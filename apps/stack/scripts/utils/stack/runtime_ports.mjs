import { coercePort } from '../server/port.mjs';
import { isTcpPortFree, observeTcpPortAvailability, pickNextFreeTcpPort } from '../net/ports.mjs';

function allocationForPort(port, previous) {
  const previousPort = coercePort(previous?.previousPort);
  return previous?.port === port && previousPort && previous.reason === 'previous-port-occupied'
    ? { port, previousPort, reason: previous.reason }
    : { port };
}

// Choices survive Stop, but never supply process custody or live endpoints.
// Legacy runtime ports seed the optional record on the next state write.
export function readStackPortAllocations(state) {
  const allocations = {};
  const controllerPort = coercePort(state?.ports?.server) ?? coercePort(state?.portAllocations?.controller?.port);
  if (controllerPort) allocations.controller = allocationForPort(controllerPort, state?.portAllocations?.controller);
  const servers = {};
  for (const [name, allocation] of Object.entries(state?.portAllocations?.servers ?? {})) {
    const port = coercePort(allocation?.port);
    if (port) Object.defineProperty(servers, name, { value: allocationForPort(port, allocation), enumerable: true, configurable: true });
  }
  for (const [name, target] of Object.entries(state?.remoteTargets ?? {})) {
    const port = coercePort(target?.servicePorts?.server);
    if (!port) continue;
    const allocation = target.portAllocation?.port === port ? target.portAllocation : servers[name];
    Object.defineProperty(servers, name, { value: allocationForPort(port, allocation), enumerable: true, configurable: true });
  }
  if (Object.keys(servers).length) allocations.servers = servers;
  return Object.keys(allocations).length ? allocations : null;
}

export async function selectStackServicePort({
  startPort,
  preferredServerPort = null,
  reservedPorts = new Set(),
  observeTcpPortAvailabilityImpl = observeTcpPortAvailability,
  isTcpPortFreeImpl = isTcpPortFree,
  pickNextFreeTcpPortImpl = pickNextFreeTcpPort,
  onPortChange,
} = {}) {
  const previousPort = coercePort(preferredServerPort);
  if (previousPort && !reservedPorts.has(previousPort)) {
    const availability = await observeTcpPortAvailabilityImpl(previousPort);
    if (availability?.status === 'free') return previousPort;
    if (availability?.status !== 'occupied') {
      throw Object.assign(new Error(`[stack] remembered port ${previousPort} availability is inconclusive`), { code: 'EPORTSELECTIONINCONCLUSIVE' });
    }
    reservedPorts.add(previousPort);
  }

  // Keep the existing fresh-allocation bind-race retry at its canonical owner.
  let selectedPort = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    selectedPort = await pickNextFreeTcpPortImpl(startPort, { reservedPorts });
    if (await isTcpPortFreeImpl(selectedPort)) {
      if (previousPort) onPortChange?.({ previousPort, port: selectedPort, reason: 'previous-port-occupied' });
      return selectedPort;
    }
    reservedPorts.add(selectedPort);
  }
  throw new Error(`[stack] unable to allocate a free server port after a bounded retry (last candidate ${selectedPort ?? 'unknown'})`);
}
