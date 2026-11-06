import { createServer, isIP } from 'node:net';
import type { NativeCaddyContainerResult, NativeCaddyFirewallExposure } from './nativeCaddy.js';
import type { MachineSetupNativeCommandResult } from './nativeBackend.js';

type Result = Readonly<{ status: 'ready' }> | Extract<NativeCaddyContainerResult, { status: 'unavailable' }>;
const conflict = (port: number): Result => ({ status: 'unavailable', reason: 'foreign_effect_conflict', details: {
    failure: { kind: 'native_observation_unavailable', reason: 'port_in_use', requiredFact: 'caddyPublishedBindings',
        stepId: 'caddy-public-port', port },
    remedy: `TCP port ${port} is already in use by another process. Use Tunnel ingress or stop the other proxy, then review the Domain again.`,
} });

function overlaps(left: string, right: string): boolean {
    return left === right || isIP(left) === isIP(right)
        && (left === '::' || right === '::' || left === '0.0.0.0' || right === '0.0.0.0');
}

async function occupied(binding: NativeCaddyFirewallExposure, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const socket = createServer();
        const abort = () => { socket.close(); reject(signal?.reason); };
        const finish = (inUse: boolean) => { signal?.removeEventListener('abort', abort); resolve(inUse); };
        signal?.addEventListener('abort', abort, { once: true });
        socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'EADDRINUSE'));
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
}>): Promise<Result> {
    const listed = await options.docker(['container', 'ls', '--no-trunc', '--format', '{{json .ID}}']);
    if (listed.code === 0) {
        let ids: unknown;
        try { ids = listed.stdout.trim() ? listed.stdout.trim().split('\n').map(line => JSON.parse(line)) : []; } catch { /* No positive conflict evidence. */ }
        if (Array.isArray(ids) && ids.every(id => typeof id === 'string' && id)) {
            const foreign = ids.filter(id => id !== options.ownedContainerId);
            if (foreign.length) {
                const inspected = await options.docker(['container', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', '--', ...foreign]);
                if (inspected.code === 0) for (const line of inspected.stdout.trim().split('\n')) {
                    let ports: unknown;
                    try { ports = JSON.parse(line); } catch { continue; }
                    if (!ports || typeof ports !== 'object' || Array.isArray(ports)) continue;
                    for (const [key, endpoints] of Object.entries(ports)) {
                        if (!key.endsWith('/tcp') || !Array.isArray(endpoints)) continue;
                        for (const endpoint of endpoints) {
                            if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.HostIp !== 'string' || typeof endpoint.HostPort !== 'string') continue;
                            const binding = bindings.find(binding => binding.protocol === 'tcp'
                                && binding.hostPort === Number(endpoint.HostPort) && overlaps(binding.hostAddress, endpoint.HostIp));
                            if (binding) return conflict(binding.hostPort);
                        }
                    }
                }
            }
        }
    }
    for (const binding of options.probeLocalPorts ? bindings : []) {
        if (binding.protocol === 'tcp' && await occupied(binding, options.signal)) return conflict(binding.hostPort);
    }
    return { status: 'ready' };
}
