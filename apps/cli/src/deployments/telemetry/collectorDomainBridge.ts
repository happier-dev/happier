import { homedir } from 'node:os';
import { observeNativeCaddyContainer, createNativeCaddyAdminExchange, type NativeDockerEngineFacts } from '@happier-dev/cli-common/machineSetup';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectNativeInvocationCustody } from '@/workspaces/projectSetup/projectSetupExecution';
import { readNativeComposeEngine, retainNativeDockerContainerRemoval } from '@/daemon/local/services/launch/nativeComposeEngine';
import { acquirePrivateServiceContainerBridge, readPrivateServiceContainerRelayHost, type PrivateServiceContainerBridge } from '../targets/ownServer/privateServiceContainerBridge';
import { readCaddyTelemetryCollectorBridges } from '../targets/ownServer/caddyRouteMaterialization';

export type CollectorDomainNative = Readonly<{
    docker: ProjectNativeDockerPort;
    engine: NativeDockerEngineFacts;
}>;
export type InstalledCollectorCaddy = CollectorDomainNative & Readonly<{ configuration: unknown; release(): Promise<void> }>;

/** Reads the installed Domain routes through the existing native Caddy owner.
 * The persisted route contains the relay alias required after restart.
 */
export async function readInstalledCollectorCaddy(signal: AbortSignal): Promise<InstalledCollectorCaddy | null> {
    const custody = createProjectNativeInvocationCustody({ signal });
    const release = async () => { try { await custody.release(); } finally { custody.dispose(); } };
    try {
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        const io = createProjectNativeIo().environmentIo.createInvocation({ signal, retainCapture: custody.retain });
        const profile = { io, command: 'docker', prefix: [], cwd: homedir(), env, signal };
        const engine = await readNativeComposeEngine(profile);
        const docker: ProjectNativeDockerPort = { engineId: engine.id, engineKind: engine.kind,
            removeOwnedContainer: retainNativeDockerContainerRemoval(profile),
            run: (args, nativeSignal, inputBytes) => io.run({ command: profile.command, args, cwd: profile.cwd,
                env, signal: nativeSignal ?? signal, ...(inputBytes ? { stdin: inputBytes } : {}) }) };
        const caddy = await observeNativeCaddyContainer({ privateNetworks: [] }, { signal, run: async command => {
            const result = await docker.run(command.args, command.signal ?? signal, command.inputBytes);
            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' };
        } });
        if (caddy.status !== 'ready') { await release(); return null; }
        const response = await createNativeCaddyAdminExchange(caddy.adminSocketPath)({ method: 'GET', path: '/config/', signal });
        if (response.status !== 200) throw new Error('collector_domain_configuration_unavailable');
        return { docker, engine, configuration: response.value, release };
    } catch (error) { await release(); throw error; }
}

/** Bridges belong to the published receiver, never the finite Domain job.
 * Endpoint withdrawal closes all listeners; publication replays installed routes.
 */
export function createCollectorDomainBridges(options: Readonly<{
    machineId: string;
    readEndpoint(): string | null;
    readInstalledCaddy?: (signal: AbortSignal) => Promise<InstalledCollectorCaddy | null>;
}>) {
    const bridges = new Map<string, Promise<PrivateServiceContainerBridge>>();
    let lifetime: AbortSignal | undefined;
    const forward = { get host() { const endpoint = options.readEndpoint(); return endpoint ? new URL(endpoint).hostname : '127.0.0.1'; },
        get port() { const endpoint = options.readEndpoint(); return endpoint ? Number(new URL(endpoint).port) : 0; } };
    async function acquire(input: CollectorDomainNative & Readonly<{ networkId: string; restoredHost?: string }>) {
        if (!lifetime || lifetime.aborted || !options.readEndpoint()) throw new Error('collector_unavailable');
        lifetime.throwIfAborted();
        const key = `${input.engine.id}:${input.networkId}`;
        const existing = bridges.get(key);
        if (existing) return existing;
        const active = [...bridges.entries()].filter(([key]) => key.startsWith(`${input.engine.id}:`)).map(([, bridge]) => bridge);
        const acquisition = (async () => {
            for (const pending of active) {
                const bridge = await pending.catch(() => null);
                if (bridge && (bridge.networkName === input.networkId || bridge.networkId === input.networkId)) return bridge;
            }
            const route = input.restoredHost ? { restoredHost: input.restoredHost } : { key: JSON.stringify(['collector-domain', options.machineId]) };
            return acquirePrivateServiceContainerBridge({ ...input, route, forward, signal: lifetime });
        })();
        bridges.set(key, acquisition);
        try { return await acquisition; }
        catch (error) { if (bridges.get(key) === acquisition) bridges.delete(key); throw error; }
    }
    async function close() {
        const retained = [...bridges.values()];
        bridges.clear();
        const live = await Promise.all(retained.map(pending => pending.catch(() => null)));
        await Promise.all([...new Set(live)].map(bridge => bridge?.close()));
    }
    async function restore() {
        const signal = lifetime;
        if (!signal || signal.aborted || !options.readInstalledCaddy || !options.readEndpoint()) return;
        const installed = await options.readInstalledCaddy(signal);
        if (!installed) return;
        try {
            for (const bridge of readCaddyTelemetryCollectorBridges(installed.configuration)) {
                signal.throwIfAborted();
                const restoredHost = readPrivateServiceContainerRelayHost(bridge);
                if (!restoredHost) continue;
                // Each installed route keeps its alias; Domains on one origin reuse the relay.
                await acquire({ docker: installed.docker, engine: installed.engine, networkId: bridge.networkId, restoredHost });
            }
        } finally { await installed.release(); }
    }
    return { acquire, close, restore, publish(signal: AbortSignal) { lifetime = signal; } };
}
