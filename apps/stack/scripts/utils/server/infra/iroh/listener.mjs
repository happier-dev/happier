import { pickNextFreeTcpPort } from '../../../net/ports.mjs';
import { DEFAULT_RELAY_HTTPS_PORT } from './configuration.mjs';
import { classifyTailscaleServeRootSlot } from '@happier-dev/cli-common/tailscale';

export function relayListenerFailure(code) {
  return Object.assign(new Error('The development relay HTTPS listener is unavailable'), { code,
    remediation: code === 'relay_serve_status_unavailable'
      ? 'On the server host, restore tailscale serve status --json, then retry the stack start. No Serve routes were changed.'
      : 'On the server host, free an unused TCP/Serve listener port, then retry the stack start. Do not replace another stack route.',
  });
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function relayHttpsPortFromState(state) {
  // Existing host records predate ports.relayHttps; their advertised URL is
  // sufficient for inspection and exact-route cleanup during the transition.
  try {
    if (state?.irohRelay?.httpsUrl) {
      const url = new URL(state.irohRelay.httpsUrl);
      if (url.protocol === 'https:') return validPort(url.port || 443);
    }
  } catch { /* An unpublished startup record can have no advertised URL. */ }
  return validPort(state?.ports?.relayHttps) ?? DEFAULT_RELAY_HTTPS_PORT;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw relayListenerFailure('relay_serve_status_unavailable');
  }
  return value;
}

function listenerInventory(serveStatusText) {
  let status;
  try { status = JSON.parse(serveStatusText); }
  catch { throw relayListenerFailure('relay_serve_status_unavailable'); }
  // Tailscale 1.104.2 marshals a nil ServeConfig as JSON null.
  if (status === null) status = {};
  record(status);
  const reservedPorts = new Set();
  const foregroundPorts = new Set();
  const collect = (config, foreground = false) => {
    record(config);
    for (const value of Object.keys(record(config.TCP ?? {}))) {
      const port = validPort(value);
      if (!port) throw relayListenerFailure('relay_serve_status_unavailable');
      reservedPorts.add(port);
      if (foreground) foregroundPorts.add(port);
    }
    for (const value of Object.keys(record(config.Web ?? {}))) {
      const port = validPort(value.slice(value.lastIndexOf(':') + 1));
      if (!port || !value.includes(':')) throw relayListenerFailure('relay_serve_status_unavailable');
      reservedPorts.add(port);
      if (foreground) foregroundPorts.add(port);
    }
    for (const value of Object.keys(record(config.AllowFunnel ?? {}))) {
      const port = validPort(value.slice(value.lastIndexOf(':') + 1));
      if (!port || !value.includes(':')) throw relayListenerFailure('relay_serve_status_unavailable');
      reservedPorts.add(port);
      if (foreground) foregroundPorts.add(port);
    }
    for (const child of Object.values(record(config.Foreground ?? {}))) collect(child, true);
  };
  collect(status);
  return { status, reservedPorts, foregroundPorts };
}

function ownedListeners(inventory, runtimeState, { allowFunnel = false, exclusive = false } = {}) {
  const { status, foregroundPorts } = inventory;
  const upstream = runtimeState?.irohRelay?.upstreamUrl;
  if (!upstream) return [];
  return Object.entries(status.Web ?? {}).flatMap(([hostPort, config]) => {
    const port = validPort(hostPort.slice(hostPort.lastIndexOf(':') + 1));
    const proxy = config?.Handlers?.['/']?.Proxy;
    const exposure = status.AllowFunnel?.[hostPort] === true ? 'public' : 'tailnet';
    if (foregroundPorts.has(port) || status.TCP?.[port]?.HTTPS !== true
      || (exposure === 'public' && !allowFunnel) || typeof proxy !== 'string') return [];
    if ((exclusive || exposure === 'public') && (Object.keys(config.Handlers).length !== 1
      || Object.keys(status.Web).filter(key => validPort(key.slice(key.lastIndexOf(':') + 1)) === port).length !== 1)) return [];
    // Reuse the shared definition of loopback/proxy equivalence.
    if (classifyTailscaleServeRootSlot(`https://${hostPort}\n|-- / proxy ${proxy}`, upstream, { httpsPort: port }).kind !== 'exact') return [];
    return [{ port, exposure, httpsUrl: new URL(`https://${hostPort}`).origin }];
  });
}

export function recordedRelayListener({ serveStatusText, runtimeState, allowFunnel = false, exclusive = false }) {
  return ownedListeners(listenerInventory(serveStatusText), runtimeState, { allowFunnel, exclusive })
    .find(listener => listener.port === relayHttpsPortFromState(runtimeState)) ?? null;
}

function funnelPorts(tailscaleStatusText) {
  // Tailscale's documented default, used only when no port capability exists:
  // https://tailscale.com/docs/reference/tailscale-cli/funnel
  if (!tailscaleStatusText) return [443, 8443, 10000];
  let self;
  try { self = JSON.parse(tailscaleStatusText)?.Self; }
  catch { throw relayListenerFailure('relay_serve_status_unavailable'); }
  const capabilities = [...(Array.isArray(self?.Capabilities) ? self.Capabilities : []),
    ...Object.keys(self?.CapMap ?? {})].filter(value => typeof value === 'string'
      && value.startsWith('https://tailscale.com/cap/funnel-ports?'));
  if (!capabilities.length) return [443, 8443, 10000];
  const ports = new Set();
  for (const capability of capabilities) {
    for (const part of (new URL(capability).searchParams.get('ports') ?? '').split(',')) {
      const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
      const start = match && validPort(match[1]);
      const end = match && validPort(match[2] ?? match[1]);
      if (!start || !end || end < start) throw relayListenerFailure('relay_serve_port_unavailable');
      for (let port = start; port <= end; port++) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export async function selectRelayHttpsPort({ serveStatusText, runtimeState, signal, funnel = false, tailscaleStatusText } = {}) {
  signal?.throwIfAborted();
  const inventory = listenerInventory(serveStatusText);
  const { reservedPorts } = inventory;
  const eligiblePorts = funnel ? funnelPorts(tailscaleStatusText) : null;

  const retainedPort = validPort(runtimeState?.ports?.relayHttps) ?? relayHttpsPortFromState(runtimeState);
  // Only a recorded relay upstream supplies ownership. A service's virtual IP
  // has its own listener namespace, so Services are not host-port reservations.
  {
    const owned = ownedListeners(inventory, runtimeState, { allowFunnel: funnel, exclusive: funnel })
      .map(listener => listener.port).filter(port => !eligiblePorts || eligiblePorts.includes(port))
      .sort((a, b) => (a === retainedPort ? -1 : b === retainedPort ? 1 : a - b));
    if (owned.length) return owned[0];
  }

  if (eligiblePorts) {
    for (const port of eligiblePorts) {
      signal?.throwIfAborted();
      if (reservedPorts.has(port)) continue;
      try {
        // One candidate, not a scan into ports outside the Funnel capability.
        return await pickNextFreeTcpPort(port, { tries: 1 });
      } catch { signal?.throwIfAborted(); }
    }
    throw relayListenerFailure('relay_serve_port_unavailable');
  }

  const startPort = reservedPorts.has(retainedPort) ? DEFAULT_RELAY_HTTPS_PORT : retainedPort;
  try {
    // Use the allocator's existing observation budget and the actual TCP
    // port-space boundary, rather than introducing a relay-specific scan cap.
    return await pickNextFreeTcpPort(startPort, { reservedPorts, tries: 65536 - startPort });
  } catch {
    signal?.throwIfAborted();
    if (startPort !== DEFAULT_RELAY_HTTPS_PORT) {
      try {
        return await pickNextFreeTcpPort(DEFAULT_RELAY_HTTPS_PORT, {
          reservedPorts, tries: 65536 - DEFAULT_RELAY_HTTPS_PORT,
        });
      } catch { signal?.throwIfAborted(); }
    }
    throw relayListenerFailure('relay_serve_port_unavailable');
  }
}
