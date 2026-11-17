import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

/**
 * One execution host serves many Stacks, and a Stack binds its selected port
 * only after source preparation (minutes later). A per-port file created with
 * O_EXCL makes the selection its Stack's own until that Stack selects the same
 * service again, so two Stacks starting together never share a port
 * (2026-11-16, nl3:3018). A server selection also claims the Stack's canonical
 * loopback port (`startPort`, its controller port), so no other Stack's server
 * takes the port its reverse forward needs. A deleted Stack's reservations only
 * make other Stacks skip those ports.
 */
export async function selectStackServicePortOnHost({ reservationDir, stackName, service = 'server', startPort,
  reservedPorts = new Set(), ...selection } = {}) {
  if (!reservationDir || !stackName) throw new Error('[stack] host port reservation requires its directory and Stack');
  await mkdir(reservationDir, { recursive: true });
  const owner = `${stackName} ${service}`;
  const fileFor = port => join(reservationDir, `${port}.stack`);
  const ownerOf = async port => (await readFile(fileFor(port), 'utf8').catch(() => '')).trim();
  const ownedByStack = value => value.split(' ')[0] === stackName;
  const claim = async (port, token = owner) => {
    try { await writeFile(fileFor(port), `${token}\n`, { flag: 'wx' }); return true; }
    catch (error) { if (error?.code !== 'EEXIST') throw error; return ownedByStack(await ownerOf(port)); }
  };
  const foreign = new Set(reservedPorts);
  const previous = [];
  for (const name of await readdir(reservationDir)) {
    const port = name.endsWith('.stack') ? coercePort(name.slice(0, -'.stack'.length)) : null;
    if (!port) continue;
    const value = await ownerOf(port);
    if (!ownedByStack(value)) foreign.add(port);
    else if (value === owner) previous.push(port);
  }
  // The canonical port is fixed by the controller and has no alternative, so it
  // takes over another Stack's earlier *server* selection of it; that Stack
  // moves on its next selection (2026-11-16, nl3:3018). Another Stack's
  // canonical claim stays theirs.
  const canonical = service === 'server' ? coercePort(startPort) : null;
  const canonicalToken = `${stackName} canonical`;
  const preferred = coercePort(selection.preferredServerPort);
  const retainedPreferred = previous.includes(preferred)
    || (preferred === canonical && preferred != null && await ownerOf(preferred) === canonicalToken);
  if (canonical) {
    const holder = await ownerOf(canonical);
    if (holder && !ownedByStack(holder) && !holder.endsWith(' canonical')) {
      await writeFile(fileFor(canonical), `${canonicalToken}\n`);
      foreign.delete(canonical);
    }
    if (foreign.has(canonical) || !await claim(canonical, canonicalToken)) foreign.add(canonical);
  }
  let selected;
  for (;;) {
    // Retain this service's admitted host allocation across replacement. The
    // lifecycle owner retires the incumbent; the replacement's native bind
    // enforces occupancy. Re-probing every interface here can refuse a released
    // port after retirement (#172b), leaving the Stack down for no new choice.
    selected = retainedPreferred && !foreign.has(preferred)
      ? preferred
      : await selectStackServicePort({ ...selection, startPort, reservedPorts: new Set(foreign) });
    if (await claim(selected)) break;
    foreign.add(selected);
  }
  for (const port of previous) if (port !== selected) await unlink(fileFor(port)).catch(() => {});
  return selected;
}
