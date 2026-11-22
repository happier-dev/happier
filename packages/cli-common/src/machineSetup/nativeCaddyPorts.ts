import { createServer, isIP } from 'node:net';
import type { NativeCaddyContainerResult, NativeCaddyFirewallExposure } from './nativeCaddy.js';
import type { MachineSetupNativeCommandResult } from './nativeBackend.js';

type Result = Readonly<{ status: 'ready' }> | Extract<NativeCaddyContainerResult, { status: 'unavailable' }>;
type HostListener = Readonly<{ address: string; port: number; name?: string }>;
const conflict = (port: number, owner?: string): Result => ({ status: 'unavailable', reason: 'foreign_effect_conflict', details: {
    failure: { kind: 'native_observation_unavailable', reason: 'port_in_use', requiredFact: 'caddyPublishedBindings',
        stepId: 'caddy-public-port', port },
    remedy: owner
        ? `TCP port ${port} is already in use by ${owner}. Move or stop it if you manage it, or use Tunnel ingress, then review the Domain again.`
        : `TCP port ${port} is already in use. Identify its listener on this Machine, then free the port or use Tunnel ingress and review the Domain again.`,
} });

function observedName(value: unknown): string | undefined {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function overlaps(left: string, right: string): boolean {
    return left === right || isIP(left) === isIP(right)
        && (left === '::' || right === '::' || left === '0.0.0.0' || right === '0.0.0.0');
}

async function occupied(binding: NativeCaddyFirewallExposure, signal?: AbortSignal): Promise<boolean | undefined> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const socket = createServer();
        const abort = () => { socket.close(); reject(signal?.reason); };
        const finish = (inUse: boolean | undefined) => { signal?.removeEventListener('abort', abort); resolve(inUse); };
        signal?.addEventListener('abort', abort, { once: true });
        socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'EACCES' || error.code === 'EPERM' ? undefined : error.code === 'EADDRINUSE'));
        socket.listen({ port: binding.hostPort, host: binding.hostAddress, exclusive: true }, () => socket.close(() => finish(false)));
    });
}

/** Docker publications can be enforced by NAT with no listening host process.
 * Inspect only the binding projection, never container environment or logs.
 * A denied bind probe is not occupied evidence; native start reports its own
 * typed failure if the observation could not establish a conflict. */
export async function checkCaddyPublishedPortConflicts(bindings: readonly NativeCaddyFirewallExposure[], options: Readonly<{
    docker(args: readonly string[]): Promise<MachineSetupNativeCommandResult>;
    ownedContainerId?: string; signal?: AbortSignal; probeLocalPorts: boolean;
    readLocalListeners?(port?: number): Promise<readonly HostListener[]>;
}>): Promise<Result> {
    const listed = await options.docker(['container', 'ls', '--no-trunc', '--format', '{{json .ID}}']);
    if (listed.code === 0) {
        let ids: unknown;
        try { ids = listed.stdout.trim() ? listed.stdout.trim().split('\n').map(line => JSON.parse(line)) : []; } catch { /* No positive conflict evidence. */ }
        if (Array.isArray(ids) && ids.every(id => typeof id === 'string' && id)) {
            const foreign = ids.filter(id => id !== options.ownedContainerId);
            if (foreign.length) {
                const inspected = await options.docker(['container', 'inspect', '--format',
                    '{"name":{{json .Name}},"ports":{{json .NetworkSettings.Ports}}}', '--', ...foreign]);
                if (inspected.code === 0) for (const line of inspected.stdout.trim().split('\n')) {
                    let publication: unknown;
                    try { publication = JSON.parse(line); } catch { continue; }
                    if (!publication || typeof publication !== 'object' || !('ports' in publication)) continue;
                    const { ports } = publication;
                    if (!ports || typeof ports !== 'object' || Array.isArray(ports)) continue;
                    const name = 'name' in publication && typeof publication.name === 'string'
                        ? observedName(publication.name.replace(/^\//, '')) : undefined;
                    for (const [key, endpoints] of Object.entries(ports)) {
                        if (!key.endsWith('/tcp') || !Array.isArray(endpoints)) continue;
                        for (const endpoint of endpoints) {
                            if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.HostIp !== 'string' || typeof endpoint.HostPort !== 'string') continue;
                            const binding = bindings.find(binding => binding.protocol === 'tcp'
                                && binding.hostPort === Number(endpoint.HostPort) && overlaps(binding.hostAddress, endpoint.HostIp));
                            if (binding) return conflict(binding.hostPort, name ? `Docker container ${name}` : undefined);
                        }
                    }
                }
            }
        }
    }
    let listeners: Promise<readonly HostListener[]> | undefined;
    for (const binding of options.probeLocalPorts ? bindings : []) {
        if (binding.protocol !== 'tcp') continue;
        const inUse = await occupied(binding, options.signal);
        const matches = (listener: HostListener) => listener.port === binding.hostPort && overlaps(binding.hostAddress, listener.address);
        if (inUse === undefined && options.readLocalListeners) listeners ??= options.readLocalListeners();
        if (inUse !== true && !(inUse === undefined && (await listeners)?.some(matches))) continue;
        const owners = await options.readLocalListeners?.(binding.hostPort).catch(() => []);
        const names = [...new Set(owners?.filter(matches).flatMap(listener => observedName(listener.name) ?? []))];
        return conflict(binding.hostPort, names.length ? names.join(', ') : undefined);
    }
    return { status: 'ready' };
}
