import type { ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import type { ManagedServiceNativeLogReadForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import type { ProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ManagedServiceNativeObservationV1 } from '@happier-dev/plugin-sdk/managed-services';
import { hostname } from 'node:os';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { LocalServiceNativePrerequisiteV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectBuiltinNativeLifecycle } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ProjectNativeEnvironmentIo } from '@/workspaces/environment/produceProjectNativeEnvironment';

type Container = Readonly<{ id: string; service: string; state: string; health: string; ports: Readonly<Record<string, unknown>> }>;
const unknown: ManagedServiceNativeObservationV1 = { phase: 'unknown', readiness: 'not_reported', endpoint: null };
const stopped: ManagedServiceNativeObservationV1 = { phase: 'stopped', readiness: 'not_reported', endpoint: null };

export class NativeComposePrerequisiteError extends PluginError {
    constructor(cause: LocalServiceNativePrerequisiteV1['cause']) {
        const prerequisite: LocalServiceNativePrerequisiteV1 = { tool: 'docker', machineName: hostname(), cause };
        super({ code: 'native_tool_unavailable', message: 'Docker is unavailable on this machine', details: { prerequisite } });
    }
}

function dockerFailureCause(stderr: string, code?: unknown): LocalServiceNativePrerequisiteV1['cause'] {
    // Permission precedes Docker's generic "daemon is not running" advice on Windows.
    if (code === 'EACCES' || code === 'EPERM' || /permission denied|access is denied|operation not permitted/iu.test(stderr)) return 'permission_denied';
    if (code === 'ENOENT') return 'not_installed';
    if (code === 'ECONNREFUSED' || /cannot connect to the docker daemon|connection refused|no such file or directory|the system cannot find the file specified/iu.test(stderr)) return 'not_running';
    return 'unavailable';
}

/** Read-only engine prerequisite, reused for review and the final authorized environment. */
export async function assertNativeComposeAvailable(input: Readonly<{
    io: Pick<ProjectNativeEnvironmentIo, 'run'>;
    command: string;
    prefix: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    signal?: AbortSignal;
}>): Promise<void> {
    const assertNotCancelled = () => {
        if (input.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    };
    assertNotCancelled();
    let output: Awaited<ReturnType<ProjectNativeEnvironmentIo['run']>>;
    try {
        output = await input.io.run({ command: input.command, args: [...input.prefix, 'info', '--format', '{{.ID}}'],
            cwd: input.cwd, env: input.env, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
        assertNotCancelled();
        // Unsettled probe-process custody is not a native prerequisite refusal.
        if (record(error) && error.code === 'plugin_exec_termination_incomplete') throw error;
        throw new NativeComposePrerequisiteError(dockerFailureCause('', record(error) ? error.code : undefined));
    }
    assertNotCancelled();
    if (output.exitCode !== 0) throw new NativeComposePrerequisiteError(dockerFailureCause(output.stderr ?? ''));
}

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

export async function readNativeComposeLogsForHost(input: Readonly<{
    containerIds: readonly string[];
    observedIds?: readonly string[];
    environment?: boolean;
    redactionLease?: Pick<ProviderRedactionLease, 'isActive' | 'redact'>;
    redactionComplete?: boolean;
    run(args: readonly string[], signal?: AbortSignal): Promise<Readonly<{ exitCode: number | null; stdout: string; stderr?: string }>>;
}>, options: ManagedServiceNativeLogReadForHost): Promise<ManagedServiceNativeLogResultV1> {
    const assertRedaction = () => {
        const incomplete = Boolean(input.redactionComplete === false || input.environment && !input.redactionLease?.isActive()
            || input.redactionLease && !input.redactionLease.isActive());
        if (incomplete && !options.allowIncompleteSecretMasking) {
            throw new PluginError({ code: 'secret_redaction_unavailable', message: 'Service log secret masking is unavailable' });
        }
        return incomplete;
    };
    options.signal?.throwIfAborted();
    assertRedaction();
    if (!input.containerIds.length) return { kind: 'unavailable', reason: 'admission_unavailable' };
    const sourceRevision = JSON.stringify([...input.containerIds].sort());
    const observedRevision = input.observedIds ? JSON.stringify([...input.observedIds].sort()) : sourceRevision;
    if (observedRevision !== sourceRevision || options.cursor && options.cursor.sourceRevision !== sourceRevision) {
        return { kind: 'source-changed', sourceRevision: observedRevision };
    }
    const output: string[] = [];
    for (const id of input.containerIds) {
        // Docker tails by lines; the existing diagnostic byte budget bounds
        // that upstream window without rediscovering the admitted instances.
        const result = await input.run(['logs', '--tail', String(options.maxBytes), id], options.signal);
        if (result.exitCode !== 0) return { kind: 'unavailable', reason: 'unavailable' };
        output.push(result.stdout + (result.stderr ?? ''));
    }
    options.signal?.throwIfAborted();
    const incomplete = assertRedaction();
    const raw = output.join('\n');
    const masked = input.redactionLease?.isActive() ? input.redactionLease.redact(raw) : raw;
    const text = incomplete ? `secret masking may be incomplete until the next deploy\n${masked}` : masked;
    const bytes = Buffer.from(text, 'utf8');
    return { kind: 'page', page: { sourceRevision,
        text: new TextDecoder('utf-8').decode(bytes.subarray(0, options.maxBytes), { stream: true }),
        nextCursor: null, truncated: bytes.byteLength > options.maxBytes,
        ...(incomplete ? { secretMasking: 'incomplete' as const } : {}) } };
}

function endpoint(rows: readonly Container[]): string | null {
    const ports = new Map<number, Set<string>>();
    for (const row of rows) for (const [containerPort, publishers] of Object.entries(row.ports)) {
        if (!containerPort.endsWith('/tcp') || !Array.isArray(publishers)) continue;
        for (const publisher of publishers) {
            if (!record(publisher) || !['0.0.0.0', '127.0.0.1', '::', '::1'].includes(String(publisher.HostIp))
                || typeof publisher.HostPort !== 'string' || !/^\d+$/u.test(publisher.HostPort)) continue;
            const port = Number(publisher.HostPort);
            if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) {
                const hosts = ports.get(port) ?? new Set<string>();
                hosts.add(String(publisher.HostIp).includes(':') ? '[::1]' : '127.0.0.1');
                ports.set(port, hosts);
            }
        }
    }
    if (ports.size !== 1) return null;
    const [port, hosts] = [...ports][0];
    return `http://${hosts.has('127.0.0.1') ? '127.0.0.1' : '[::1]'}:${port}`;
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
    let starterStarted = false;
    let observedEmpty = false;
    let cleared = false;
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
        // A nonempty listing withdraws the earlier empty witness even when
        // its identities cannot be decoded or belong to a replacement.
        observedEmpty = listedIds.length === 0;
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
            cleared = false;
        },
        markStarted() { starterStarted = true; observedEmpty = false; },
        get redactedValues() { return Object.values(launch?.env ?? {}).filter((value): value is string => typeof value === 'string' && value.length > 0); },
        async logs(options) {
            if (options.kind === 'watch') {
                options.signal?.throwIfAborted();
                options.emit({ kind: 'unavailable', reason: 'unsupported' });
                return { dispose() {} };
            }
            return readNativeComposeLogsForHost({ containerIds: ids ?? [], run }, options);
        },
        async inspect(options) {
            if (cleared) return stopped;
            try { return observe(await read(options?.signal)); }
            catch (error) { if (options?.signal?.aborted) throw error; return unknown; }
        },
        async stop(options) {
            try {
                if (options?.signal?.aborted) options.signal.throwIfAborted();
                if (cleared) return { status: 'stopped' };
                const before = await read(options?.signal);
                if (!before) {
                    // Local identity absence is not an absence witness for a
                    // detached incumbent recovered by a new daemon controller.
                    if (observedEmpty && !ids?.length && !starterStarted) { cleared = true; return { status: 'stopped' }; }
                    return { status: 'termination_incomplete' };
                }
                if (observe(before).phase === 'stopped') return { status: 'stopped' };
                if (!ids?.length) return { status: 'termination_incomplete' };
                const result = await run(['stop', ...before.map(row => row.id)], options?.signal);
                if (result.exitCode !== 0) return { status: 'termination_incomplete' };
                return { status: observe(await read(options?.signal)).phase === 'stopped' ? 'stopped' : 'termination_incomplete' };
            } catch (error) {
                if (options?.signal?.aborted) throw error;
                if (observedEmpty && !ids?.length && !starterStarted) { cleared = true; return { status: 'stopped' }; }
                return { status: 'termination_incomplete' };
            }
        },
    };
    return {
        lifecycle,
        async assertAvailable(signal?: AbortSignal) {
            if (!launch?.cwd) throw new Error('native_service_admission_required');
            const env: Record<string, string> = {};
            for (const [key, value] of Object.entries(launch.env ?? {})) if (value !== undefined) env[key] = value;
            await assertNativeComposeAvailable({ io: input.io, command: launch.command, prefix, cwd: launch.cwd, env, signal });
        },
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
