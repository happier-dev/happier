import type { ManagedServiceNativeObservationV1 } from '@happier-dev/plugin-sdk/managed-services';
import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import type { ManagedServiceNativeLogReadForHost } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import type { ProjectBuiltinNativeLifecycle, ProjectNativeContainerObservation, ProjectNativeAccountingResult, ProjectNativeRuntimeFacts, ProjectNativeStageOutput } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import type { NativeComposeConfigurationMatcher } from './nativeComposeConfiguration';
import type { NativeComposeRuntimeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { readNativeComposeEngine, assertNativeComposeAvailable } from './nativeComposeEngine';
import { observeDockerEngine, openDockerEngineEvents, type DockerEngineEventSource } from './dockerEngineObservation';
import { createManagedServiceAccountingRead } from '@/plugins/runtime/invocation/services/managedServiceAccountingRead';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import { readDeploymentSourceIdentityForHost } from '@/deployments/targets/ownServer/paths';
import { readNativeComposePublishedPorts } from './nativeComposePorts';
export { assertNativeComposeAvailable, NativeComposePrerequisiteError } from './nativeComposeEngine';

export type NativeComposeActivatedServiceFacts = Readonly<{
    configuration: NativeComposeRuntimeReview['services'][number];
    containerImages: readonly Readonly<{ id: string; nativeImageId: string; imageConfigDigest: string;
        configurationMatches: NativeComposeConfigurationMatcher }>[];
}>;
export type NativeComposeActivatedProject = Readonly<{
    composeArgs: readonly string[];
    services: readonly string[];
    nativeIdsForService(composeService: string): readonly string[];
    nativeFactsForService(composeService: string): NativeComposeActivatedServiceFacts;
    authorizeServiceObserver(): HostAuthorizedPluginExecLaunch;
}>;

type Container = ProjectNativeContainerObservation & Readonly<{
    state: string; health: string; ports: Readonly<Record<string, unknown>>; workingDirectory?: string;
}>;
const unknown: ManagedServiceNativeObservationV1 = { phase: 'unknown', readiness: 'not_reported', endpoint: null };
const stopped: ManagedServiceNativeObservationV1 = { phase: 'stopped', readiness: 'not_reported', endpoint: null };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exact P30 generation witness only: labels validate custody, never discover deletion targets. */
async function removeWitnessedContainers(input: Readonly<{ ids: readonly string[]; project: string; services: readonly string[];
    stopWithNativeGrace?: true;
    run(args: readonly string[]): Promise<Readonly<{ exitCode: number | null; stdout: string }>> }>): Promise<boolean> {
    if (!input.ids.length || new Set(input.ids).size !== input.ids.length || input.ids.some(id => !/^[a-f0-9]{64}$/u.test(id))) return false;
    const before = await input.run(['inspect', '--type', 'container', ...input.ids]);
    const witnessed = before.exitCode === 0 ? containers(before.stdout, input.project) : null;
    if (!witnessed || witnessed.length !== input.ids.length
        || witnessed.some(row => !input.ids.includes(row.id) || !input.services.includes(row.service))) return false;
    if (input.stopWithNativeGrace) {
        // Omit --timeout: Docker owns the configured per-container StopTimeout.
        const stopped = await input.run(['container', 'stop', ...input.ids]);
        if (stopped.exitCode !== 0) return false;
    }
    // Non-force removal itself refuses a still-running/uncertain incumbent.
    const removed = await input.run(['container', 'rm', ...(input.stopWithNativeGrace ? [] : ['--force']), ...witnessed.map(row => row.id)]);
    if (removed.exitCode !== 0) return false;
    // A missing-id inspect and an unavailable engine can both emit [] with
    // exit 1. Only a successful native listing proves these exact ids absent.
    const after = await input.run(['ps', '--all', '--no-trunc', '--filter',
        `label=com.docker.compose.project=${input.project}`, '--format', '{{.ID}}']);
    if (after.exitCode !== 0) return false;
    const remaining = after.stdout.trim() ? after.stdout.trim().split('\n') : [];
    return remaining.every(id => /^[a-f0-9]{64}$/u.test(id) && !input.ids.includes(id));
}

/** Docker CLI stats --format emits humanized native units, not host RSS. */
function nativeMemoryBytes(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)$/u.exec(value.split('/')[0].trim());
    if (!match) return null;
    const units: Readonly<Record<string, number>> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15,
        KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, PiB: 1024 ** 5 };
    const bytes = Math.round(Number(match[1]) * units[match[2]]!);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function nativeAccounting(stdout: string, ids: readonly string[]): ProjectNativeAccountingResult {
    const samples = new Map<string, Readonly<{ nativeResourceId: string; cpuPercent: number | null; memoryBytes: number | null }>>();
    try {
        for (const line of stdout.split('\n').filter(line => line.trim())) {
            const row: unknown = JSON.parse(line);
            if (!record(row) || typeof row.ID !== 'string' || !ids.includes(row.ID) || samples.has(row.ID)) {
                return { kind: 'unavailable', reason: 'unavailable' };
            }
            const cpu = typeof row.CPUPerc === 'string' && /^\d+(?:\.\d+)?%$/u.test(row.CPUPerc) ? Number(row.CPUPerc.slice(0, -1)) : null;
            samples.set(row.ID, { nativeResourceId: row.ID, cpuPercent: cpu !== null && Number.isFinite(cpu) ? cpu : null,
                memoryBytes: nativeMemoryBytes(row.MemUsage) });
        }
    } catch { return { kind: 'unavailable', reason: 'unavailable' }; }
    // Docker omits stopped containers. Absence is unknown usage, never zero.
    return { kind: 'sample', samples: ids.map(id => samples.get(id) ?? { nativeResourceId: id, cpuPercent: null, memoryBytes: null }) };
}

/** Docker 29.9 inspect arrays retain immutable IDs even after the Compose YAML is removed. */
function containers(stdout: string, project?: string): readonly Container[] | null {
    try {
        const value: unknown = JSON.parse(stdout);
        if (!Array.isArray(value)) return null;
        const result: Container[] = [];
        for (const item of value) {
            if (!record(item) || typeof item.Id !== 'string' || !/^[a-f0-9]{64}$/u.test(item.Id)
                || !record(item.Config) || !record(item.Config.Labels)
                || typeof item.Config.Labels['com.docker.compose.project'] !== 'string'
                || !item.Config.Labels['com.docker.compose.project']
                || project !== undefined && item.Config.Labels['com.docker.compose.project'] !== project
                || typeof item.Config.Labels['com.docker.compose.service'] !== 'string'
                || !record(item.State) || typeof item.State.Status !== 'string'
                || !record(item.NetworkSettings) || item.NetworkSettings.Ports !== null && !record(item.NetworkSettings.Ports)) return null;
            if (item.State.Health !== undefined && (!record(item.State.Health) || typeof item.State.Health.Status !== 'string')) return null;
            const policy = record(item.HostConfig) && record(item.HostConfig.RestartPolicy) ? item.HostConfig.RestartPolicy : undefined;
            const configurationMatches = typeof item.configurationMatches === 'boolean' ? item.configurationMatches : undefined;
            result.push({ ...(configurationMatches === undefined ? {} : { configurationMatches }), id: item.Id,
                composeProject: item.Config.Labels['com.docker.compose.project'], service: item.Config.Labels['com.docker.compose.service'], state: item.State.Status,
                ...(typeof item.Name === 'string' && item.Name.startsWith('/') && item.Name.length > 1
                    ? { containerName: item.Name.slice(1) } : {}),
                ...(record(item.NetworkSettings.Networks) ? { networkNames: Object.keys(item.NetworkSettings.Networks) } : {}),
                ...(typeof item.Config.Labels['com.docker.compose.project.working_dir'] === 'string'
                    ? { workingDirectory: item.Config.Labels['com.docker.compose.project.working_dir'] } : {}),
                ...(typeof item.Image === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item.Image) ? { nativeImageId: item.Image } : {}),
                ...(typeof item.State.Pid === 'number' && Number.isSafeInteger(item.State.Pid) && item.State.Pid > 0 ? { pid: item.State.Pid } : {}),
                ...(typeof item.RestartCount === 'number' && Number.isSafeInteger(item.RestartCount) && item.RestartCount >= 0 ? { restartCount: item.RestartCount } : {}),
                ...(policy && typeof policy.Name === 'string' ? { restartPolicy: { name: policy.Name,
                    ...(typeof policy.MaximumRetryCount === 'number' && Number.isSafeInteger(policy.MaximumRetryCount) && policy.MaximumRetryCount >= 0
                        ? { maximumRetryCount: policy.MaximumRetryCount } : {}) } } : {}),
                health: record(item.State.Health) ? String(item.State.Health.Status) : '', ports: item.NetworkSettings.Ports ?? {} });
        }
        return new Set(result.map(item => item.id)).size === result.length ? result : null;
    } catch { return null; }
}

/** Cold logs consume native routing labels, never source or control custody. */
export function readNativeComposeLogTargetForHost(input: Readonly<{
    stdout: string; deploymentRoot: string; environmentId: string; environmentInstanceId: string;
    projectName: string; composeService: string; deploymentId?: string;
}>): Readonly<{ environmentId: string; deploymentId: string; restorationForDeploymentId?: string;
    sourcePath: string; project: string; containerIds: readonly string[] }> | null {
    const rows = containers(input.stdout, input.projectName);
    if (!rows) return null;
    const selected = rows.flatMap(row => {
        if (row.service !== input.composeService || !row.workingDirectory) return [];
        const identity = readDeploymentSourceIdentityForHost({ deploymentRoot: input.deploymentRoot, sourcePath: row.workingDirectory });
        return identity?.environmentInstanceId === input.environmentInstanceId
            && (input.deploymentId === undefined || identity.deploymentId === input.deploymentId) ? [{ row, identity, sourcePath: row.workingDirectory }] : [];
    });
    const first = selected[0];
    if (!first || selected.some(({ row, identity }) => row.composeProject !== first.row.composeProject
        || identity.deploymentId !== first.identity.deploymentId
        || identity.restorationForDeploymentId !== first.identity.restorationForDeploymentId)) return null;
    return { environmentId: input.environmentId, deploymentId: first.identity.deploymentId,
        ...(first.identity.restorationForDeploymentId ? { restorationForDeploymentId: first.identity.restorationForDeploymentId } : {}),
        sourcePath: first.sourcePath,
        project: first.row.composeProject, containerIds: selected.map(({ row }) => row.id) };
}

/** Warm and cold readers share the same generation page and masking owner. */
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

/** Native process boundaries; tests replace events alongside their existing Docker run boundary. */
export type NativeComposeObservationIo = Pick<ProjectNativeToolchainIo, 'run'> & Readonly<{ events?: DockerEngineEventSource }>;

type NativeComposeServiceInput = Readonly<{
    args: readonly string[];
    io: NativeComposeObservationIo;
    /** Actual activation refcount, never the original finite requester admission. */
    retainLaunch?(): HostAuthorizedPluginExecLaunch;
    /** The actual engine identity already proved by native admission. */
    engineId?: string;
    /** P41 already activated this project once; each capture observes one rendered service. */
    environment?: Readonly<{ composeService: string; containerIds: readonly string[]; facts?: NativeComposeActivatedServiceFacts }>;
}>;

export function createNativeComposeLifecycle(input: NativeComposeServiceInput) {
    return createNativeComposeServiceCapture(input);
}

/** A codec/control capture, not another supervisor, registry, shell or placement owner. */
function createNativeComposeServiceCapture(input: NativeComposeServiceInput) {
    const project = input.args[input.args.indexOf('--project-name') + 1];
    const up = input.args.indexOf('up');
    const target = input.environment?.composeService ?? input.args.at(-1);
    if (!project || (!input.environment && up < 0) || !target) throw new Error('native_service_invocation_invalid');
    let launch: HostAuthorizedPluginExecLaunch | undefined;
    let prefix: readonly string[] = [];
    let ids: readonly string[] | undefined = input.environment ? Object.freeze([...input.environment.containerIds]) : undefined;
    if (input.environment && (!ids?.length || ids.some(id => !/^[a-f0-9]{64}$/u.test(id)) || new Set(ids).size !== ids.length)) {
        throw new PluginError({ code: 'deployment_generation_required', message: 'The admitted service generation is unavailable' });
    }
    let starterStarted = false;
    let observedEmpty = false;
    let observedIds: readonly string[] | undefined;
    let cleared = false;
    let engineId = input.engineId;
    let engineSubscription: ReturnType<typeof observeDockerEngine> | undefined;
    let engineRows: readonly Container[] | null = null;
    let nativeContainers: readonly ProjectNativeContainerObservation[] | null = null;
    let runtimeFacts: ProjectNativeRuntimeFacts = { configuration: input.environment?.facts?.configuration ?? null,
        observedAt: null, freshness: 'unavailable' };
    const imageProofs = new Map(input.environment?.facts?.containerImages.map(image => [image.id, image]));
    const run = async (args: readonly string[], signal?: AbortSignal, stageOutput?: ProjectNativeStageOutput, inputBytes?: Uint8Array) => {
        if (!launch?.cwd) throw new Error('native_service_admission_required');
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(launch.env ?? {})) if (value !== undefined) env[key] = value;
        if (stageOutput && !launch.secretRedactionLease?.isActive()) {
            throw new PluginError({ code: 'secret_redaction_unavailable', message: 'Native effect output custody is unavailable' });
        }
        const output = await input.io.run({ command: launch.command, args: [...prefix, ...args], cwd: launch.cwd, env,
            ...(signal ? { signal } : {}), ...(inputBytes ? { stdin: inputBytes } : {}), ...(stageOutput ? { output: { redaction: launch.secretRedactionLease!,
                onChunk: stageOutput.appendRedacted } } : {}) });
        stageOutput?.assertWritten();
        return output;
    };
    const accounting = createManagedServiceAccountingRead(async (signal): Promise<ProjectNativeAccountingResult> => {
        const selected = nativeContainers?.filter(row => row.service === target).map(row => row.id).sort();
        if (!selected?.length) return { kind: 'unavailable', reason: 'unavailable' };
        try {
            const result = await run(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...selected], signal);
            signal.throwIfAborted();
            const current = nativeContainers?.filter(row => row.service === target).map(row => row.id).sort();
            if (!current || JSON.stringify(current) !== JSON.stringify(selected) || result.exitCode !== 0) {
                return { kind: 'unavailable', reason: 'unavailable' };
            }
            return nativeAccounting(result.stdout, selected);
        } catch (error) {
            // Unsettled probe custody belongs to the native IO owner;
            // it is not an ordinary missing accounting observation.
            if (error !== null && typeof error === 'object' && 'code' in error
                && error.code === 'plugin_exec_termination_incomplete') throw error;
            signal.throwIfAborted();
            return { kind: 'unavailable', reason: 'unavailable' };
        }
    });
    const read = async (signal?: AbortSignal) => {
        const listed = await run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
            ...(input.environment ? ['--filter', `label=com.docker.compose.service=${target}`] : []), '--format', '{{.ID}}'], signal);
        if (listed.exitCode !== 0) return null;
        const listedIds = listed.stdout.trim() ? listed.stdout.trim().split('\n') : [];
        // A nonempty listing withdraws the earlier empty witness even when
        // its identities cannot be decoded or belong to a replacement.
        observedEmpty = listedIds.length === 0;
        if (listedIds.some(id => !/^[a-f0-9]{64}$/u.test(id)) || new Set(listedIds).size !== listedIds.length) return null;
        observedIds = listedIds;
        if (ids && listedIds.some(id => !ids!.includes(id))) return null;
        if (!listedIds.length) return [];
        const result = await run(['inspect', '--type', 'container', ...listedIds], signal);
        const rows = result.exitCode === 0 ? containers(result.stdout, project) : null;
        if (!rows || input.environment && rows.some(row => row.service !== target)) return null;
        if (rows.length !== listedIds.length || rows.some(row => !listedIds.includes(row.id))) return null;
        if (!ids && rows.length) ids = rows.map(row => row.id);
        if (ids && rows.some(row => !ids!.includes(row.id))) return null;
        return rows;
    };
    const observe = (rows: readonly Container[] | null): ManagedServiceNativeObservationV1 => {
        if (cleared) return stopped;
        if (!rows) return unknown;
        // A missing deployment generation is not a stopped incumbent that can
        // be started again. Only deploy/rollback can recreate missing resources.
        if (input.environment && rows.length === 0) return unknown;
        if (rows.every(row => ['created', 'exited', 'dead'].includes(row.state))) return stopped;
        const selected = rows.filter(row => row.service === target);
        if (!selected.length || selected.some(row => row.state !== 'running')
            || rows.some(row => !['running', 'exited', 'dead'].includes(row.state))) return unknown;
        return { phase: 'running', readiness: selected.every(row => row.health === 'healthy') ? 'ready'
            : selected.some(row => row.health === 'starting' || row.health === 'unhealthy') ? 'not_ready' : 'not_reported', endpoint: endpoint(selected) };
    };
    const afterControl = async (signal?: AbortSignal) => {
        if (!engineSubscription) return observe(await read(signal));
        await engineSubscription.refresh();
        signal?.throwIfAborted();
        return observe(engineRows);
    };
    const controlExisting = async (operation: 'start' | 'restart', options?: Readonly<{ signal?: AbortSignal }>) => {
        if (!input.environment) throw new PluginError({ code: 'native_service_control_unsupported', message: 'Existing-generation controls require Environment custody' });
        const before = await read(options?.signal);
        if (!before?.length || !ids?.length) throw new PluginError({ code: 'deployment_generation_required', message: 'The admitted service generation is unavailable; deploy or roll back to restore it' });
        const result = await run([operation, ...before.map(row => row.id)], options?.signal);
        if (result.exitCode !== 0) throw new PluginError({ code: 'native_service_control_unconfirmed', message: 'Native service control could not be confirmed' });
        return afterControl(options?.signal);
    };
    const hasCapturedEngine = async (signal?: AbortSignal): Promise<boolean> => {
        signal?.throwIfAborted();
        if (!input.engineId || !launch?.cwd) return false;
        const env = Object.fromEntries(Object.entries(launch.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        try {
            return (await readNativeComposeEngine({ io: input.io, command: launch.command,
                prefix, cwd: launch.cwd, env, signal })).id === input.engineId;
        } catch (error) {
            if (signal?.aborted) throw error;
            return false;
        }
    };
    const readRemoval = async (signal?: AbortSignal) => {
        if (!await hasCapturedEngine(signal)) return null;
        try { return await read(signal); }
        catch (error) {
            if (signal?.aborted) throw error;
            return null;
        }
    };
    const lifecycle: ProjectBuiltinNativeLifecycle = {
        async prepareStart(options) {
            if (input.environment) throw new PluginError({ code: 'deployment_generation_required', message: 'Environment services use their admitted deployment generation' });
            if (observe(await read(options?.signal)).phase !== 'stopped') throw new Error('native_service_stop_unconfirmed');
            // Retire only an observed stopped generation before admitting its replacement.
            ids = undefined;
            cleared = false;
        },
        markStarted() { starterStarted = true; observedEmpty = false; },
        get redactedValues() { return launch?.secretRedactionLease?.values() ?? []; },
        readLogRedactionLease(containerIds) {
            return !cleared && launch?.secretRedactionLease?.isActive() && ids?.length === containerIds.length
                && ids.every(id => containerIds.includes(id)) ? launch?.secretRedactionLease : undefined;
        },
        nativeContainers: () => nativeContainers,
        async nativeDocker(options) {
            if (cleared || !launch?.cwd || !engineId) throw new PluginError({ code: 'service_unavailable', message: 'The native generation is unavailable' });
            const env = Object.fromEntries(Object.entries(launch.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
            const current = await readNativeComposeEngine({ io: input.io, command: launch.command, prefix,
                cwd: launch.cwd, env, signal: options?.signal });
            if (current.id !== engineId) throw new PluginError({ code: 'service_unavailable', message: 'The native generation engine changed' });
            return { engineId, run: (args, signal, inputBytes) => run(args, signal, undefined, inputBytes) };
        },
        nativeInstances() {
            if (!engineId) return undefined;
            const adapter = { pluginId: 'happier.machine.services', localId: 'compose' };
            return [
                { adapter, nativeResourceId: JSON.stringify([engineId, project]) },
                { adapter, nativeResourceId: JSON.stringify([engineId, project, target]) },
            ];
        },
        runtimeFacts: () => runtimeFacts,
        readAccounting: options => accounting.read(options),
        async observe(listener, options) {
            if (!launch?.cwd) throw new Error('native_service_admission_required');
            if (!ids?.length) {
                // Only the first workspace capture discovers its admitted generation.
                const initial = await read(options?.signal);
                if (!ids?.length) { listener(observe(initial)); return { async dispose() {} }; }
            }
            if (!engineId) {
                const env = Object.fromEntries(Object.entries(launch.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
                engineId = await assertNativeComposeAvailable({ io: input.io, command: launch.command, prefix, cwd: launch.cwd, env, signal: options?.signal });
            }
            const subscription = observeDockerEngine(engineId, { ids,
                events: input.io.events ?? openDockerEngineEvents(launch, prefix),
                async inspect(containerIds, signal) {
                    const output = await run(['inspect', '--type', 'container', ...containerIds], signal);
                    // Docker returns an array of the remaining members with exit 1
                    // when an admitted container has gone. That is not engine loss.
                    try { const value: unknown = JSON.parse(output.stdout); return Array.isArray(value) ? value : null; }
                    catch { return null; }
                },
                configurationMatches(row) {
                    return record(row) && typeof row.Id === 'string'
                        ? imageProofs.get(row.Id)?.configurationMatches(row.Config, row.HostConfig) : undefined;
                },
                changed(rows) {
                    const parsed = rows ? containers(JSON.stringify(rows), project) : null;
                    if (parsed) observedIds = parsed.map(row => row.id);
                    engineRows = parsed && parsed.length === ids?.length ? parsed : null;
                    if (engineRows && input.environment && engineRows.some(row => row.service !== target)) engineRows = null;
                    const configuration = input.environment?.facts?.configuration;
                    const ports = engineRows && readNativeComposePublishedPorts(engineRows.map(row => row.ports),
                        value => launch?.secretRedactionLease?.redact(value) ?? value);
                    runtimeFacts = { configuration: engineRows && configuration
                        ? ports ? { ...configuration, ports } : null : runtimeFacts.configuration,
                        observedAt: engineRows ? Date.now() : runtimeFacts.observedAt,
                        freshness: engineRows ? 'current' : 'unavailable' };
                    const next = engineRows?.map(({ id, composeProject, service, containerName, networkNames, pid, restartCount, restartPolicy, nativeImageId, configurationMatches }) => {
                        const proof = imageProofs.get(id);
                        return { id, composeProject, service, ...(configurationMatches === undefined ? {} : { configurationMatches }),
                            ...(containerName ? { containerName } : {}), ...(networkNames ? { networkNames } : {}),
                            ...(pid === undefined ? {} : { pid }),
                            ...(restartCount === undefined ? {} : { restartCount }), ...(restartPolicy ? { restartPolicy } : {}),
                            ...(nativeImageId ? { nativeImageId } : {}),
                            ...(proof && proof.nativeImageId === nativeImageId ? { imageConfigDigest: proof.imageConfigDigest } : {}) };
                    }) ?? null;
                    if (JSON.stringify(next) !== JSON.stringify(nativeContainers)) {
                        const attribution = (rows: typeof nativeContainers) => rows?.map(({ id, composeProject, service, pid }) => ({ id, composeProject, service, pid })) ?? null;
                        const changed = JSON.stringify(attribution(next)) !== JSON.stringify(attribution(nativeContainers));
                        nativeContainers = next;
                        if (changed) invalidateProcessLaunchDiscovery();
                    }
                    if (!nativeContainers) accounting.cancel();
                    listener(observe(engineRows));
                },
            });
            engineSubscription = subscription;
            const dispose = async () => {
                options?.signal?.removeEventListener('abort', onAbort);
                if (engineSubscription === subscription) {
                    engineSubscription = undefined; engineRows = null;
                    runtimeFacts = { ...runtimeFacts, freshness: 'unavailable' };
                    const hadAttribution = nativeContainers !== null;
                    nativeContainers = null; accounting.cancel();
                    if (hadAttribution) invalidateProcessLaunchDiscovery();
                }
                await subscription.dispose();
            };
            const onAbort = () => { void dispose().catch(() => {}); };
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            if (options?.signal?.aborted) { await dispose(); options.signal.throwIfAborted(); }
            await subscription.ready;
            return { dispose };
        },
        async logs(options) {
            if (options.kind === 'watch') {
                options.signal?.throwIfAborted();
                options.emit({ kind: 'unavailable', reason: 'unsupported' });
                return { dispose() {} };
            }
            return readNativeComposeLogsForHost({ containerIds: ids ?? [], observedIds,
                environment: Boolean(input.environment), redactionLease: launch?.secretRedactionLease, run }, options);
        },
        async inspect(options) {
            if (cleared) return stopped;
            if (engineSubscription) { options?.signal?.throwIfAborted(); return observe(engineRows); }
            try { return observe(await read(options?.signal)); }
            catch (error) { if (options?.signal?.aborted) throw error; return unknown; }
        },
        ...(input.environment ? {
            start: (options?: Readonly<{ signal?: AbortSignal }>) => controlExisting('start', options),
            restart: (options?: Readonly<{ signal?: AbortSignal }>) => controlExisting('restart', options),
            async inspectRemoval(options?: Readonly<{ signal?: AbortSignal }>) {
                const rows = await readRemoval(options?.signal);
                return rows === null ? 'unknown' as const : rows.length ? 'present' as const : 'absent' as const;
            },
            async remove(options?: Readonly<{ signal?: AbortSignal; stageOutput?: ProjectNativeStageOutput }>) {
                options?.signal?.throwIfAborted();
                const current = await readRemoval(options?.signal);
                if (!current) return { status: 'termination_incomplete' as const };
                if (current.length && !await removeWitnessedContainers({ ids: current.map(row => row.id), project, services: [target],
                    run: args => run(args, options?.signal, args[0] === 'container' && args[1] === 'rm' ? options?.stageOutput : undefined) })) return { status: 'termination_incomplete' as const };
                if ((await readRemoval(options?.signal))?.length !== 0) {
                    return { status: 'termination_incomplete' as const };
                }
                cleared = true;
                await afterControl(options?.signal);
                return { status: 'stopped' as const };
            },
        } : {}),
        async stop(options) {
            try {
                if (options?.signal?.aborted) options.signal.throwIfAborted();
                if (cleared) return { status: 'stopped' };
                const before = await read(options?.signal);
                if (input.environment && !before?.length) return { status: 'termination_incomplete' };
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
                return { status: (await afterControl(options?.signal)).phase === 'stopped' ? 'stopped' : 'termination_incomplete' };
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
            engineId = await assertNativeComposeAvailable({ io: input.io, command: launch.command, prefix, cwd: launch.cwd, env, signal });
        },
        bindLaunch(value: HostAuthorizedPluginExecLaunch) {
            const args = value.args ?? [];
            if (args.length < input.args.length || args.slice(-input.args.length).some((arg, index) => arg !== input.args[index])) {
                throw new Error('native_service_invocation_invalid');
            }
            launch = value;
            engineId = input.engineId;
            prefix = args.slice(0, args.length - input.args.length);
        },
    };
}

/** The physical start-first generation name is shared with cold observation. */
export function resolveNativeComposeCandidateProjectName(admissionProjectName: string, deploymentId: string): string {
    return `happier-g-${createHash('sha256').update(JSON.stringify([admissionProjectName, deploymentId])).digest('hex')}`;
}
