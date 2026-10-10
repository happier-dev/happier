import type { ManagedServiceNativeObservationV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectBuiltinNativeLifecycle } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ProjectNativeEnvironmentIo } from '@/workspaces/environment/produceProjectNativeEnvironment';

type Container = Readonly<{ id: string; service: string; state: string; health: string; ports: Readonly<Record<string, unknown>> }>;
const unknown: ManagedServiceNativeObservationV1 = { phase: 'unknown', readiness: 'not_reported', endpoint: null };
const stopped: ManagedServiceNativeObservationV1 = { phase: 'stopped', readiness: 'not_reported', endpoint: null };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Docker 29.9 inspect arrays retain immutable IDs even after the Compose YAML is removed. */
function containers(stdout: string, project: string): readonly Container[] | null {
    try {
        const value: unknown = JSON.parse(stdout);
        if (!Array.isArray(value)) return null;
        const result: Container[] = [];
        for (const item of value) {
            if (!record(item) || typeof item.Id !== 'string' || !/^[a-f0-9]{64}$/u.test(item.Id)
                || !record(item.Config) || !record(item.Config.Labels)
                || item.Config.Labels['com.docker.compose.project'] !== project
                || typeof item.Config.Labels['com.docker.compose.service'] !== 'string'
                || !record(item.State) || typeof item.State.Status !== 'string'
                || !record(item.NetworkSettings) || item.NetworkSettings.Ports !== null && !record(item.NetworkSettings.Ports)) return null;
            if (item.State.Health !== undefined && (!record(item.State.Health) || typeof item.State.Health.Status !== 'string')) return null;
            result.push({ id: item.Id, service: item.Config.Labels['com.docker.compose.service'], state: item.State.Status,
                health: record(item.State.Health) ? String(item.State.Health.Status) : '', ports: item.NetworkSettings.Ports ?? {} });
        }
        return new Set(result.map(item => item.id)).size === result.length ? result : null;
    } catch { return null; }
}

function endpoint(rows: readonly Container[]): string | null {
    const ports = new Set<number>();
    for (const row of rows) for (const [containerPort, publishers] of Object.entries(row.ports)) {
        if (!containerPort.endsWith('/tcp') || !Array.isArray(publishers)) continue;
        for (const publisher of publishers) {
            if (!record(publisher) || !['0.0.0.0', '127.0.0.1', '::', '::1'].includes(String(publisher.HostIp))
                || typeof publisher.HostPort !== 'string' || !/^\d+$/u.test(publisher.HostPort)) continue;
            const port = Number(publisher.HostPort);
            if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) ports.add(port);
        }
    }
    return ports.size === 1 ? `http://127.0.0.1:${[...ports][0]}` : null;
}

/** A codec/control capture, not another supervisor, registry, shell or placement owner. */
export function createNativeComposeLifecycle(input: Readonly<{
    args: readonly string[];
    io: Pick<ProjectNativeEnvironmentIo, 'run'>;
}>) {
    const project = input.args[input.args.indexOf('--project-name') + 1];
    const up = input.args.indexOf('up');
    const target = input.args.at(-1);
    if (!project || up < 0 || !target) throw new Error('native_service_invocation_invalid');
    let launch: HostAuthorizedPluginExecLaunch | undefined;
    let prefix: readonly string[] = [];
    let ids: readonly string[] | undefined;
    const run = (args: readonly string[], signal?: AbortSignal) => {
        if (!launch?.cwd) throw new Error('native_service_admission_required');
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(launch.env ?? {})) if (value !== undefined) env[key] = value;
        return input.io.run({ command: launch.command, args: [...prefix, ...args], cwd: launch.cwd, env, ...(signal ? { signal } : {}) });
    };
    const read = async (signal?: AbortSignal) => {
        const listed = await run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'], signal);
        if (listed.exitCode !== 0) return null;
        const listedIds = listed.stdout.trim() ? listed.stdout.trim().split('\n') : [];
        if (listedIds.some(id => !/^[a-f0-9]{64}$/u.test(id)) || new Set(listedIds).size !== listedIds.length) return null;
        if (ids && listedIds.some(id => !ids!.includes(id))) return null;
        if (!listedIds.length) return [];
        const result = await run(['inspect', '--type', 'container', ...listedIds], signal);
        const rows = result.exitCode === 0 ? containers(result.stdout, project) : null;
        if (!rows) return null;
        if (rows.length !== listedIds.length || rows.some(row => !listedIds.includes(row.id))) return null;
        if (!ids && rows.length) ids = rows.map(row => row.id);
        if (ids && rows.some(row => !ids!.includes(row.id))) return null;
        return rows;
    };
    const observe = (rows: readonly Container[] | null): ManagedServiceNativeObservationV1 => {
        if (!rows) return unknown;
        if (rows.every(row => ['created', 'exited', 'dead'].includes(row.state))) return stopped;
        const selected = rows.filter(row => row.service === target);
        if (!selected.length || selected.some(row => row.state !== 'running')
            || rows.some(row => !['running', 'exited', 'dead'].includes(row.state))) return unknown;
        return { phase: 'running', readiness: selected.every(row => row.health === 'healthy') ? 'ready'
            : selected.some(row => row.health === 'starting' || row.health === 'unhealthy') ? 'not_ready' : 'not_reported', endpoint: endpoint(selected) };
    };
    const lifecycle: ProjectBuiltinNativeLifecycle = {
        async prepareStart(options) {
            if (observe(await read(options?.signal)).phase !== 'stopped') throw new Error('native_service_stop_unconfirmed');
            // Retire only an observed stopped generation before admitting its replacement.
            ids = undefined;
        },
        get redactedValues() { return Object.values(launch?.env ?? {}).filter((value): value is string => typeof value === 'string' && value.length > 0); },
        async logs(options) {
            const rows = await read(options?.signal);
            if (!rows || !ids?.length) throw new Error('native_service_observation_unavailable');
            const output: string[] = [];
            for (const row of rows) {
                const result = await run(['logs', row.id], options?.signal);
                if (result.exitCode !== 0) throw new Error('native_service_logs_unavailable');
                output.push(result.stdout + (result.stderr ?? ''));
            }
            return output.join('\n');
        },
        async inspect(options) {
            try { return observe(await read(options?.signal)); }
            catch (error) { if (options?.signal?.aborted) throw error; return unknown; }
        },
        async stop(options) {
            try {
                const before = await read(options?.signal);
                if (!before) return { status: 'termination_incomplete' };
                if (observe(before).phase === 'stopped') return { status: 'stopped' };
                if (!ids?.length) return { status: 'termination_incomplete' };
                const result = await run(['stop', ...before.map(row => row.id)], options?.signal);
                if (result.exitCode !== 0) return { status: 'termination_incomplete' };
                return { status: observe(await read(options?.signal)).phase === 'stopped' ? 'stopped' : 'termination_incomplete' };
            } catch (error) { if (options?.signal?.aborted) throw error; return { status: 'termination_incomplete' }; }
        },
    };
    return {
        lifecycle,
        bindLaunch(value: HostAuthorizedPluginExecLaunch) {
            const args = value.args ?? [];
            if (args.length < input.args.length || args.slice(-input.args.length).some((arg, index) => arg !== input.args[index])) {
                throw new Error('native_service_invocation_invalid');
            }
            launch = value;
            prefix = args.slice(0, args.length - input.args.length);
        },
    };
}
