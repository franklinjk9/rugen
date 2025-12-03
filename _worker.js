import indexHtml from "./assets/index.html";
import caCert from "./assets/ca.txt";
import sunlogo from "./assets/lionsun.txt";
import moonlogo from "./assets/hammer.txt";
import darkModeAudio from "./assets/audio.txt";
import howToUseHtml from "./assets/how-to-use.html";
import donateHtml from "./assets/donate.html";


function generateRandomTag() {
  return Math.random().toString(36).substring(2, 7);
}

function generateFilename(locations, gatewaysJson) {
  const randomTag = generateRandomTag();
  const prefix = 'riseup';
  let locationPart = 'all';

  if (locations && locations.length > 0 && !locations.includes('All')) {
    const locationMap = gatewaysJson.locations;
    const countryCodes = new Set();

    locations.forEach(locationName => {
      if (locationMap[locationName] && locationMap[locationName].country_code) {
        countryCodes.add(locationMap[locationName].country_code);
      }
    });

    if (countryCodes.size > 0) {
      locationPart = [...countryCodes].sort().join('-');
    }
  }

  return `${prefix}_${locationPart}_${randomTag}.ovpn`;
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
        switch (url.pathname) {
            case "/":
                let renderedHtml = indexHtml.replace(
                    /\${siteKey\s*\|\|\s*'1x00000000000000000000AA'}/g,
                    env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA"
                );
                renderedHtml = renderedHtml.replace('${sunlogo}', sunlogo);
                renderedHtml = renderedHtml.replace('${moonlogo}', moonlogo);
                renderedHtml = renderedHtml.replace('${darkModeAudio}', darkModeAudio);
                return new Response(renderedHtml, { headers: { "Content-Type": "text/html;charset=UTF-8" } });

            case "/how-to-use":
                return new Response(howToUseHtml, { headers: { "Content-Type": "text/html;charset=UTF-8" } });

            case "/donate":
                return new Response(donateHtml, { headers: { "Content-Type": "text/html;charset=UTF-8" } });

            case "/locations":
                try {
                    const gatewaysResponse = await fetch("https://api.black.riseup.net/3/config/eip-service.json");
                    if (!gatewaysResponse.ok) throw new Error("Failed to fetch locations");
                    const gatewaysJson = await gatewaysResponse.json();
                    
                    const locationMap = gatewaysJson.locations;
                    const uniqueLocations = [...new Set(gatewaysJson.gateways.map(g => g.location))].sort();

                    const locationsWithFlags = uniqueLocations.map(locationName => {
                        return {
                            name: locationName,
                            code: locationMap[locationName]?.country_code || null
                        };
                    });

                    return new Response(JSON.stringify(locationsWithFlags), { headers: { "Content-Type": "application/json" } });
                } catch (error) {
                    return new Response("Could not retrieve locations.", { status: 500 });
                }
        }
    }

    if (request.method === "POST" && url.pathname === "/generate") {
      const formData = await request.formData();
      const ip = request.headers.get("CF-Connecting-IP");

      const token = formData.get("cf-turnstile-response");
      if (!token) {
        return new Response("CAPTCHA response missing.", { status: 400 });
      }

      let turnstileFormData = new FormData();
      turnstileFormData.append("secret", env.TURNSTILE_SECRET_KEY);
      turnstileFormData.append("response", token);
      turnstileFormData.append("remoteip", ip);

      const turnstileResult = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        body: turnstileFormData,
        method: "POST",
      });

      const outcome = await turnstileResult.json();
      if (!outcome.success) {
        return new Response("CAPTCHA verification failed.", { status: 403 });
      }

      try {
        const gatewaysResponse = await fetch("https://api.black.riseup.net/3/config/eip-service.json");
        if (!gatewaysResponse.ok) throw new Error("Failed to fetch gateways for config");
        const gatewaysJson = await gatewaysResponse.json();

        const noIpv6 = formData.get("no-ipv6") === "on";
        const noDnsLeak = formData.get("no-dns-leak") === "on";
        const protocol = formData.get("protocol") || "tcp";
        const locations = formData.getAll("locations");

        const filename = generateFilename(locations, gatewaysJson);
        const ovpnConfig = await generateOvpnConfig(noIpv6, noDnsLeak, protocol, locations, gatewaysJson);

        return new Response(ovpnConfig, {
          headers: {
            "Content-Type": "application/x-openvpn-profile",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      } catch (error) {
        console.error("Failed to generate OpenVPN config:", error);
        return new Response(`Error generating config: ${error.message}`, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function generateOvpnConfig(noIpv6, noDnsLeak, protocol, locations, gatewaysJson) {
  const keyCertResponse = await fetch("https://api.black.riseup.net/3/cert", { headers: { Accept: "text/html" } });
  if (!keyCertResponse.ok) throw new Error(`Failed to fetch certificate: ${keyCertResponse.statusText}`);
  const keyCertText = await keyCertResponse.text();
  let config = getBaseConfig(protocol);
  const remoteLines = generateRemoteList(gatewaysJson, locations);
  if (!remoteLines) throw new Error("Could not generate server list from API response.");
  config = config.replace("# Riseup available servers will be inserted here", remoteLines);
  if (noIpv6) config += getNoIpv6Block();
  if (noDnsLeak) config += getNoDnsLeakBlock();
  const keyMatch = keyCertText.match(/-----BEGIN RSA PRIVATE KEY-----(.|\n|\r)*?-----END RSA PRIVATE KEY-----/);
  const certMatch = keyCertText.match(/-----BEGIN CERTIFICATE-----(.|\n|\r)*?-----END CERTIFICATE-----/);
  if (!keyMatch || !certMatch) throw new Error("Could not parse key/certificate from Riseup API response.");
  
  config += `\n<key>\n${keyMatch[0]}\n</key>\n`;
  config += `\n<cert>\n${certMatch[0]}\n</cert>\n`;
  
  return config;
}

function generateRemoteList(gatewaysJson, locations) {
  let remoteLines = [];
  const useAllLocations = !locations || locations.length === 0 || locations.includes("All");
  const filteredGateways = useAllLocations 
    ? gatewaysJson.gateways 
    : gatewaysJson.gateways.filter(g => locations.includes(g.location));
  if (filteredGateways && Array.isArray(filteredGateways)) {
    filteredGateways.forEach((gateway) => {
      const ip = gateway.ip_address;
      const host = gateway.host;
      const location = gateway.location;
      const openvpnTransport = gateway.capabilities.transport.find((t) => t.type === "openvpn");
      if (openvpnTransport && Array.isArray(openvpnTransport.ports)) {
        openvpnTransport.ports.forEach((port) => {
          remoteLines.push(`remote ${ip} ${port}`);
        });
      }
    });
  }
  return remoteLines.join("\n");
}

function getBaseConfig(protocol = "tcp") {
  return `client
dev tun
proto ${protocol}
nobind
# Riseup available servers will be inserted here
remote-random
persist-key
persist-tun
pull-filter ignore "ping"
pull-filter ignore "ping-restart"
keepalive 10 20
server-poll-timeout 10
connect-retry 1 2
connect-retry-max 1
cipher AES-256-GCM
data-ciphers AES-256-GCM
remote-cert-tls server
verb 3
<ca>
${caCert}
</ca>`;
}

function getNoIpv6Block() {
  return `
# Disable IPv6
pull-filter ignore "tun-ipv6"
pull-filter ignore "route-ipv6"
pull-filter ignore "ifconfig-ipv6"
pull-filter ignore "redirect-gateway"
block-ipv6
redirect-gateway def1`;
}

function getNoDnsLeakBlock() {
  return `
# Avoid using ISP dns servers
pull-filter ignore "block-outside-dns"
pull-filter ignore "dhcp-option"
dhcp-option DNS 1.1.1.1
script-security 2
up "/usr/bin/env bash -c '/etc/openvpn/update-resolv-conf $* || /etc/openvpn/up.sh $*'"
down "/usr/bin/env bash -c '/etc/openvpn/update-resolv-conf $* || /etc/openvpn/down.sh $*'"`;
}