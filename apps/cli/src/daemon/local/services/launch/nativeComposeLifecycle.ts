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
import { resolveEnvironmentComposeProjectName } from '@/workspaces/projectSetup/projectNativeResolution';
import { createNativeComposeImageIdentity } from './nativeComposeImageIdentity';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { type NativeComposeRegistryAcquisition } from './nativeComposeImageIdentity';
import type { HostDeploymentRuntimeProjectionV1 } from '@/deployments/secrets/deploymentExecEnvPort';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { type NativeComposeEffectAuthority } from './nativeComposeImageIdentity';
import { normalizeNativeComposePlatform } from './nativeComposeImageIdentity';
import { resolveNativeComposeDeploymentImageReferences } from './nativeComposeImageIdentity';
import { inspectNativeComposeStorage } from './nativeComposeStorage';
import { isDeploymentSourceUnchangedManifestInput } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createNativeComposeGenerationProof } from './nativeComposeGeneration';
import { createNativeComposeActivatedProject } from './nativeComposeActivatedProject';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { readProjectDefinitionFileBytes } from '@/workspaces/projectSetup/nativeDefinitionFiles';
import { assertStoredComposeToolSupport } from '@/workspaces/projectSetup/nativeComposeSource';
import { resolve } from 'node:path';
import { createNativeRuntimeProjectionForHost } from './candidateRuntimeProjection';
import { createNativeComposeImagePreparation } from './nativeComposeImagePreparation';
import { MachineNativeEffectAdmissionError } from './machineNativeEffectAdmission';
import { writeFile } from 'node:fs/promises';
import { createNativeComposeIncumbentBindReader } from './nativeComposeSharedData';
import { projectNativeComposeSharedData } from './nativeComposeSharedData';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { isAbsolute } from 'node:path';
import { assertNativeComposeSharedDataPaths } from './nativeComposeSharedData';
import { assertNativeComposeStartFirstConfiguration } from './nativeComposeStartFirst';
import { admitNativeResticCommand } from './nativeResticCommand';
import { RESTIC_RUNTIME_V1 } from '@happier-dev/deployments';
import { activateNativeComposeStartFirst } from './nativeComposeStartFirst';
import { nativeServiceCommandArgs } from './serviceCommand';
import { admitNativeServiceCommandForHost } from './serviceCommand';
import { seedNativeComposeSharedData } from './nativeComposeSharedData';
import { nativeComposeCompletedServices } from './nativeComposeGeneration';
import { type NativeComposeRoutingGeneration } from './nativeComposeStartFirst';
import type { MachineNativeEffectContext } from './machineNativeEffectAdmission';
import { type NativeComposeEngineFacts } from './nativeComposeEngine';
import type { OwnServerDeploymentInputBasisV1 } from '@happier-dev/deployment-protocol';
import type { MachineNativeEffectKey } from './machineNativeEffectAdmission';
import { type NativeComposeStorageReview } from './nativeComposeStorage';
import { type NativeComposeSharedDataPlan } from './nativeComposeSharedData';
import { type NativeResticCommandInput } from './nativeResticCommand';
import type { AdmittedServiceExecContextV1 } from './serviceCommand';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import { type NativeComposeStartFirstInput } from './nativeComposeStartFirst';
import { type NativeComposeStartFirstResult } from './nativeComposeStartFirst';
import { type NativeComposeBuildSelection } from './nativeComposeImagePreparation';
import { type NativeComposeBuildDescription } from './nativeComposeImagePreparation';
import { type NativeComposePrepareImagesOptions } from './nativeComposeImagePreparation';
import type { NativeComposeImageArchive } from './nativeComposeImageIdentity';
import type { ServiceCommandV1 } from './serviceCommand';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { DeploymentExecEnvPortV1 } from '@happier-dev/plugin-sdk/exec';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import { type NativeComposeImageAcquisition } from './nativeComposeImageIdentity';
import { type NativeComposeSharedDataInput } from './nativeComposeSharedData';
import { hostname } from 'node:os';
import type { LocalServiceNativePrerequisiteV1 } from '@happier-dev/protocol/local/services/launcher/v1';

export { assertNativeComposeAvailable, NativeComposePrerequisiteError } from './nativeComposeEngine';

export type NativeComposeActivatedServiceFacts = Readonly<{
    configuration: NativeComposeRuntimeReview['services'][number];
    containerImages: readonly Readonly<{ id: string; nativeImageId: string; imageConfigDigest: string;
        configurationMatches: NativeComposeConfigurationMatcher }>[];
}>;
export type NativeComposeActivatedProject = Readonly<{
    composeArgs: readonly string[];
    services: readonly string[];
    health: 'healthy' | 'unverified';
    routingGeneration(): NativeComposeRoutingGeneration;
    retire(input: Readonly<{ context: MachineNativeEffectContext; signal?: AbortSignal }>): Promise<void>;
    nativeIdsForService(composeService: string): readonly string[];
    nativeFactsForService(composeService: string): NativeComposeActivatedServiceFacts;
    isCurrent(): boolean;
    authorizeServiceObserver(): HostAuthorizedPluginExecLaunch;
    dispose(): Promise<void>;
}>;

type Container = ProjectNativeContainerObservation & Readonly<{
    state: string; health: string; ports: Readonly<Record<string, unknown>>; workingDirectory?: string;
    startedAtMs?: number; healthSince?: number;
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
            const startedAtMs = typeof item.State.StartedAt === 'string' ? Date.parse(item.State.StartedAt) : NaN;
            const healthSince = record(item.State.Health) ? item.State.Health.Since : undefined;
            const configurationMatches = typeof item.configurationMatches === 'boolean' ? item.configurationMatches : undefined;
            result.push({ ...(configurationMatches === undefined ? {} : { configurationMatches }), id: item.Id,
                composeProject: item.Config.Labels['com.docker.compose.project'], service: item.Config.Labels['com.docker.compose.service'], state: item.State.Status,
                ...(Number.isSafeInteger(startedAtMs) && startedAtMs > 0 && item.State.Status === 'running' ? { startedAtMs } : {}),
                ...(typeof healthSince === 'number' && Number.isSafeInteger(healthSince) && healthSince > 0 ? { healthSince } : {}),
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
        const missingOriginalMasking = Boolean((input.environment || input.redactionLease) && !input.redactionLease?.isActive());
        const incomplete = input.redactionComplete === false || missingOriginalMasking;
        if (incomplete && !options.allowIncompleteSecretMasking) {
            throw new PluginError({ code: 'secret_redaction_unavailable',
                message: missingOriginalMasking ? 'Redeploy the Environment to restore service log secret masking'
                    : 'Service log secret masking is unavailable',
                ...(missingOriginalMasking ? {
                    details: { reason: 'secret_redaction_redeploy_required', remedy: 'redeploy_environment', retryable: false },
                    failureCause: { phase: 'service.logs.redaction', errorClass: 'Error',
                        errorCode: 'secret_redaction_redeploy_required', httpStatus: null },
                } : {}),
            });
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
    const bytes = Buffer.from(masked, 'utf8');
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

/** A codec/control capture, not another supervisor, registry, shell or placement owner. */
export function createNativeComposeLifecycle(input: NativeComposeEnvironmentProjectInput): NativeComposeEnvironmentProject;
export function createNativeComposeLifecycle(input: NativeComposeServiceInput): ReturnType<typeof createNativeComposeServiceCapture>;
export function createNativeComposeLifecycle(input: NativeComposeServiceInput | NativeComposeEnvironmentProjectInput) {
    return 'kind' in input ? createEnvironmentProject(input) : createNativeComposeServiceCapture(input);
}





export type NativeComposeEnvironmentProject = Readonly<{
    observeActivated(input: Readonly<{ render: NativeComposeProjectRender; signal?: AbortSignal;
        /** Exact losing-generation custody only; returned health is unverified. */
        purpose?: 'retire' }>): Promise<NativeComposeObservedActivation>;
    admitResticCommand(input: NativeResticCommandInput): Promise<AdmittedServiceExecContextV1>;
    prepareResticRuntime(input: Readonly<{ render: NativeComposeProjectRender; context: MachineNativeEffectContext }>): Promise<DeploymentImageV1>;
    createStartFirstCandidate(): NativeComposeEnvironmentProject;
    activateStartFirst(input: NativeComposeStartFirstInput): Promise<NativeComposeStartFirstResult>;
    describeBuild(options?: NativeComposeBuildSelection): Promise<NativeComposeBuildDescription & Readonly<{ keys: readonly MachineNativeEffectKey[] }>>;
    prepareImages(options?: NativeComposePrepareImagesOptions & Readonly<{ context?: MachineNativeEffectContext }>): Promise<readonly DeploymentImageV1[]>;
    exportImages(input: Readonly<{ images: readonly DeploymentImageV1[]; signal?: AbortSignal; context?: MachineNativeEffectContext }>): Promise<readonly NativeComposeImageArchive[]>;
    render(options?: Readonly<{ signal?: AbortSignal }> & (Readonly<{ purpose?: undefined }>
        | Readonly<{ purpose: 'serviceCommand'; service: string }>)): Promise<NativeComposeProjectRender>;
    /** Compare an imported project's reviewed generation once under native admission. */
    assertReviewedGeneration(render: NativeComposeProjectRender, signal?: AbortSignal): Promise<void>;
    /** Explicit P41 image-acquisition stage under its existing complete admission.
     * Candidate command admission itself never pulls/builds/tags/starts services. */
    prepareRuntimeImages(input: Readonly<{ render: NativeComposeProjectRender; context: MachineNativeEffectContext;
        signal?: AbortSignal }>): Promise<void>;
    /** Actual admitted candidate render/pins, never incumbent selection or a caller launch DTO. */
    admitServiceCommand(input: Readonly<{ render: NativeComposeProjectRender; context: MachineNativeEffectContext;
        service: string; command: ServiceCommandV1; environmentOverrides?: Readonly<Record<string, string>>;
        signal?: AbortSignal }>): Promise<AdmittedServiceExecContextV1>;
    observe(input: Readonly<{ render: NativeComposeProjectRender; signal?: AbortSignal }>): Promise<Readonly<{
        status: 'matching' | 'different' | 'unknown'; health: 'healthy' | 'unhealthy' | 'unverified';
    }>>;
    activate(input: Readonly<{ render: NativeComposeProjectRender; context: MachineNativeEffectContext; signal?: AbortSignal;
        cleanupOnFailure?: boolean }>): Promise<NativeComposeActivatedProject>;
    settleNative(): Promise<void>;
    dispose(): Promise<void>;
}>;

export type NativeComposeProjectRender = Readonly<{
    environmentInstanceId: string;
    admissionProjectName: string;
    engineId: string;
    engine: NativeComposeEngineFacts;
    projectName: string;
    platform: string;
    services: readonly string[];
    health?: OwnServerDeploymentInputBasisV1['health'];
    healthServices: readonly string[];
    servicePlatforms: readonly Readonly<{ service: string; platform: string }>[];
    buildServices: readonly string[];
    /** Host-only admission coordinates, never serialized as review/receipt content. */
    keys: readonly MachineNativeEffectKey[];
    review: NativeComposeRuntimeReview;
    storage?: NativeComposeStorageReview;
    /** Invocation-only source plan; never serialized as review/receipt content. */
    sharedData?: NativeComposeSharedDataPlan;
    basis: Readonly<{
        manifestFingerprint: string;
        configInputDigests: readonly Readonly<{ path: string; digest: string }>[];
        toolVersion: string;
        physicalProjectName: string;
        nativeGeneration?: OwnServerDeploymentInputBasisV1['nativeGeneration'];
    }>;
}>;

export type NativeComposeObservedActivation = Readonly<{ kind: 'active'; activation: NativeComposeActivatedProject }>
    | Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'unknown'; reason: string }>;



export type NativeComposeEnvironmentProjectInput = Readonly<{
    kind: 'environmentProject';
    phase?: 'build' | 'runtime';
    /** Exact host-owned empty build cwd, admitted by the source phase facade. */
    executionDirectory?: string;
    exec: ExecService;
    envPort: DeploymentExecEnvPortV1;
    source: DeploymentSourceMaterializationV1;
    files: readonly string[];
    sourceKind?: 'repository' | 'stored';
    profiles?: readonly string[];
    services: readonly string[];
    health?: OwnServerDeploymentInputBasisV1['health'];
    physicalProjectName?: string;
    /** Protected imported origin; native admission must address that same engine. */
    expectedEngineId?: string;
    images: readonly DeploymentImageV1[];
    /** Current host-admitted binding, never caller-supplied Docker credentials. */
    imageAcquisition?: NativeComposeImageAcquisition;
    storage?: Readonly<{ runtimeMachineCount: number; sharedData?: NativeComposeSharedDataInput }>;
    io: ProjectNativeToolchainIo;
    /** Operation-owned sink receives only the supervisor's P42-sanitized bytes. */
    stageOutput?: Readonly<{
        appendRedacted(stream: 'stdout' | 'stderr', chunk: Uint8Array): void;
        assertWritten(): void;
    }>;
    /** The invocation-scoped native process owner, not detached app lifetime. */
    settleNative(): Promise<void>;
}>;



export function resolveNativeComposeCandidateProjectName(admissionProjectName: string, deploymentId: string): string {
    return `happier-g-${createHash('sha256').update(JSON.stringify([admissionProjectName, deploymentId])).digest('hex')}`;
}

export { executeAdmittedServiceCommand, admitServiceCommandStreamForHost } from './serviceCommand';

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

function createEnvironmentProject(input: NativeComposeEnvironmentProjectInput,
    candidate?: Readonly<{ admissionProjectName: string }>): NativeComposeEnvironmentProject {
    const projectName = resolveEnvironmentComposeProjectName({ environmentInstanceId: input.source.environmentInstanceId,
        services: input.services, ...(input.physicalProjectName ? { physicalProjectName: input.physicalProjectName } : {}) });
    const admissionProjectName = candidate?.admissionProjectName ?? projectName;
    const files = [...input.files];
    const profiles = [...(input.profiles ?? [])];
    const selected = [...input.services];
    const health = input.health?.map(value => ({ ...value }));
    const excludedFromHealth = new Set(health?.filter(value => !value.participates).map(value => value.service));
    const images = input.images.map(image => ({ ...image }));
    type RenderCapture = { model: Record<string, unknown>; unresolvedModel: Record<string, unknown>; composeArgs: readonly string[];
        commandService?: string;
        identity: ReturnType<typeof createNativeComposeImageIdentity>;
        localImages: ReadonlyMap<string, Readonly<{ reference: string; config: Record<string, unknown> }>>;
        prepared?: Readonly<{ render: NativeComposeProjectRender; context: MachineNativeEffectContext }> };
    const renderedCaptures = new WeakMap<NativeComposeProjectRender, RenderCapture>();
    let root: string | undefined;
    let closed = false;
    let activation: NativeComposeActivatedProject | undefined;
    let runtimePlatform: string | undefined;
    let effectivePlatforms = new Map<string, string>();
    const assertOpen = (signal?: AbortSignal) => {
        if (closed || signal?.aborted) return nativeRefusal('deployment_source_unavailable');
    };
    const assertCurrent = async (signal?: AbortSignal) => {
        assertOpen(signal);
        await input.source.assertCurrent();
        assertOpen(signal);
    };
    const directory = async () => root ??= await mkdtemp(join(input.phase === 'build' && input.executionDirectory
        ? input.executionDirectory : tmpdir(), 'happier-compose-environment-'));
    const removeDirectory = async () => { if (root) { const owned = root; root = undefined; await rm(owned, { recursive: true, force: true }); } };
    const authorizedPrefixes = new WeakMap<HostAuthorizedPluginExecLaunch, Readonly<{
        prefix: readonly string[]; env: Readonly<Record<string, string>> }>>();
    const authorize = async (args: readonly string[], signal?: AbortSignal, registry?: NativeComposeRegistryAcquisition | null,
        sourceNormalization = false, deploymentRuntimeProjection?: HostDeploymentRuntimeProjectionV1) => {
        await assertCurrent(signal);
        const tool = await input.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose', cwd: input.source.rootPath, ...(signal ? { signal } : {}) });
        if (registry === null && !input.imageAcquisition?.publicRegistryEnvPort) return nativeRefusal('deployment_registry_unavailable');
        // These owner-authored commands consume no application inputs in either
        // phase. One classifier keeps discovery/image inspection on the genuine
        // host tuple; runtime projection is separately consumed below.
        const consumesBuildInputs = input.phase === 'build' && args[0] === 'buildx' && args[1] === 'bake';
        const inputFree = sourceNormalization || registry === undefined && args[0] !== 'compose' && !consumesBuildInputs
            || args[0] === 'compose' && args[1] === 'version';
        const attachment = inputFree && !deploymentRuntimeProjection ? undefined : registry === null
            ? await input.imageAcquisition!.publicRegistryEnvPort!.prepare({ source: input.source, phase: 'build' }, signal ? { signal } : undefined)
            : registry
            ? await registry.envPort.prepare({ bindingIdentity: registry.bindingIdentity }, signal ? { signal } : undefined)
            : await input.envPort.prepare({ source: input.source, phase: input.phase ?? 'runtime' }, signal ? { signal } : undefined);
        try {
            const admitted = await authorizePluginExecLaunchForHost(input.exec, { executable: tool.executable, args,
                cwd: input.phase === 'build' && input.executionDirectory ? input.executionDirectory : input.source.rootPath,
                ...(attachment ? { deploymentEnv: attachment } : {}) }, {
                    ...(signal ? { signal } : {}), ...(deploymentRuntimeProjection ? { deploymentRuntimeProjection } : {}) });
            // Input-free commands keep the host tuple, without materializing
            // application inputs merely to stream their native output.
            const redaction = input.stageOutput && inputFree && !attachment && !admitted.secretRedactionLease
                ? createProviderRedactionLease({ values: [] }) : undefined;
            const launch = redaction ? Object.freeze({ ...admitted, secretRedactionLease: redaction,
                async release() {
                    try { await admitted.release(); }
                    finally { redaction.close(); }
                },
            }) : admitted;
            authorizedPrefixes.set(launch, {
                prefix: launch.nativeExecutablePrefix ?? launch.args.slice(0, launch.args.length - args.length),
                // The normalization helper pins dotenv with an empty native
                // --env-file. Do not shadow a legitimate application key here.
                env: deploymentRuntimeProjection ? launch.env : { ...launch.env, COMPOSE_DISABLE_ENV_FILE: '1' },
            });
            return launch;
        } catch (error) { attachment?.dispose(); throw error; }
    };
    const runAuthorized = async (launch: HostAuthorizedPluginExecLaunch, signal?: AbortSignal, checkExit = true,
        authority?: NativeComposeEffectAuthority) => {
        assertOpen(signal);
        if (!launch.cwd) return nativeRefusal('native_compose_cwd_unavailable');
        await launch.recheckInputs?.();
        const tuple = authorizedPrefixes.get(launch) ?? nativeRefusal('native_service_admission_required');
        let output: Awaited<ReturnType<ProjectNativeToolchainIo['run']>>;
        try { output = await input.io.run({ command: launch.command, args: launch.args, cwd: launch.cwd,
            env: tuple.env, ...(launch.stdin ? { stdin: launch.stdin } : {}), ...(signal ? { signal } : {}),
            ...(authority && input.stageOutput ? { output: {
                redaction: launch.secretRedactionLease ?? nativeRefusal('secret_redaction_unavailable'),
                onChunk: input.stageOutput.appendRedacted,
            } } : {}) }); }
        finally { await launch.retireDeploymentRuntimeFiles?.(); }
        if (authority && input.stageOutput) input.stageOutput.assertWritten();
        assertOpen(signal);
        if (checkExit && output.exitCode !== 0) {
            const args = launch.args.slice(tuple.prefix.length);
            // Docker parses plugin flags itself when Buildx is absent. Keep
            // the closed prerequisite fact, never its private stderr or args.
            if (args[0] === 'buildx' && /unknown command:[^\r\n]*\bbuildx\b|unknown flag: --(?:raw|print|file|allow|metadata-file)\b/iu.test(output.stderr ?? '')) {
                throw new PluginError({ code: 'docker_buildx_not_installed',
                    message: 'Install Docker Buildx on the build machine before deploying', retryable: false });
            }
            return nativeRefusal('native_compose_command_failed');
        }
        return output;
    };
    const run = async (args: readonly string[], signal?: AbortSignal, registry?: NativeComposeRegistryAcquisition | null, checkExit = true,
        authority?: NativeComposeEffectAuthority) => {
        const launch = await authorize(args, signal, registry);
        try { return await runAuthorized(launch, signal, checkExit, authority); }
        finally { await launch.release(); }
    };
    const base = ['compose', '--project-name', projectName, '--project-directory', input.source.rootPath,
        ...profiles.flatMap(profile => ['--profile', profile])];
    const pin = (service: string) => {
        const platform = effectivePlatforms.get(service) ?? runtimePlatform;
        const candidates = images.filter(image => image.service === service
            && (!platform || normalizeNativeComposePlatform(image.platform) === platform));
        if (candidates.length !== 1) return nativeRefusal('deployment_image_unavailable');
        return candidates[0];
    };
    const imageReferences = (service: string) => resolveNativeComposeDeploymentImageReferences({
        environmentInstanceId: input.source.environmentInstanceId, deploymentId: input.source.deploymentId, image: pin(service),
    });
    const localReferences = (service: string) => {
        const image = pin(service);
        const refs = imageReferences(service);
        return [refs.activationRef, refs.ownedTag, image.configDigest, ...(image.registryReference ? [image.registryReference] : [])];
    };
    const inspectStorage = (model: Record<string, unknown>, configs: ReadonlyMap<string, Record<string, unknown>>) => inspectNativeComposeStorage({
        model, imageConfigs: configs, runtimeMachineCount: input.storage?.runtimeMachineCount ?? 1,
        ...(candidate ? { requireStateless: true } : {}),
        isUnchangedManifestSource: path => isDeploymentSourceUnchangedManifestInput(input.source, path),
    });
    const generation = createNativeComposeGenerationProof({ projectName, run: (args, signal) => run(args, signal), pin });
    const nativeGeneration = async (signal?: AbortSignal) => (await generation.snapshot(signal)).rows
        .map(row => ({ id: row.Id, restartCount: row.RestartCount })).sort((a, b) => a.id.localeCompare(b.id));
    const inspectGeneration = (current: NativeComposeProjectRender, identity: ReturnType<typeof createNativeComposeImageIdentity>, signal?: AbortSignal,
        observation?: Readonly<{ snapshot: Awaited<ReturnType<typeof generation.snapshot>>; purpose?: 'retire' }>) =>
        generation.inspect({ services: current.services, healthServices: current.healthServices,
            model: renderedCaptures.get(current)?.model ?? nativeRefusal('deployment_generation_unavailable'),
            proveImage: (reference, image) => identity.prove(reference, image), signal, ...observation });
    const retainActivation = (current: NativeComposeProjectRender, capture: RenderCapture,
        proof: Awaited<ReturnType<typeof inspectGeneration>>, launch: HostAuthorizedPluginExecLaunch,
        prefix: readonly string[], stopLending?: () => void) => createNativeComposeActivatedProject({
        current, composeArgs: capture.composeArgs, generation: proof, launch, prefix,
        async release() {
            stopLending?.();
            try { await launch.release(); } finally { await removeDirectory(); }
        },
        async retire(options) {
            const signal = options.signal ?? options.context.operation.signal;
            await machineNativeEffectAdmission.runStage(options.context, async () => {
                signal?.throwIfAborted();
                const ids = current.services.flatMap(service => [...proof.serviceNativeIds.get(service)!]);
                if (!await removeWitnessedContainers({ ids, project: projectName, services: current.services,
                    stopWithNativeGrace: true, run: args => input.io.run({ command: launch.command, args: [...prefix, ...args],
                        cwd: launch.cwd!, env: launch.env, ...(signal ? { signal } : {}) }) })) return nativeRefusal('deployment_generation_unavailable');
            });
        },
    });
    const normalize = async (signal?: AbortSignal) => {
        const toolVersion = (await run(['compose', 'version', '--short'], signal)).stdout.trim();
        const configInputDigests: { path: string; digest: string }[] = [];
        for (const file of files) {
            const read = await readProjectDefinitionFileBytes(input.source.rootPath, file);
            if (read.kind !== 'read') return nativeRefusal('deployment_source_unavailable');
            configInputDigests.push({ path: file, digest: `sha256:${createHash('sha256').update(read.bytes).digest('hex')}` });
            if (input.sourceKind === 'stored') await assertStoredComposeToolSupport(Buffer.from(read.bytes).toString('utf8'), toolVersion);
        }
        // Compose also resolves bare environment entries and environment-backed
        // configs/secrets with --no-interpolate. Normalize with canonical tool
        // inputs only and defer environment-resolving Normalize (which drops
        // unset bare build args); native merge/path/default-context handling stays.
        const launch = await authorize([...base, ...files.flatMap(file => ['--file', resolve(input.source.rootPath, file)]),
            'config', '--format', 'json', '--no-interpolate', '--no-env-resolution', '--no-normalize', ...selected], signal, undefined, true,
            input.phase === 'build' ? undefined : createNativeRuntimeProjectionForHost({ kind: 'source', source: input.source,
                composeArguments: base, sourceFiles: files.map(file => resolve(input.source.rootPath, file)), services: selected,
                io: input.io, assertCurrent: () => assertCurrent(signal) }));
        try {
            const model = nativeModel((await runAuthorized(launch, signal)).stdout);
            return { model, configInputDigests, toolVersion };
        } finally { await launch.release(); }
    };
    const imagePreparation = createNativeComposeImagePreparation({ source: input.source, images: input.images, imageAcquisition: input.imageAcquisition, phase: input.phase ?? 'runtime',
        executionDirectory: input.executionDirectory, services: selected, projectName, composeArgs: base, normalize, parseComposeModel: nativeModel,
        directory, assertCurrent, run: (args, signal, checkExit, registry, authority) => run(args, signal, registry, checkExit, authority),
        async withOutput(args, signal, visit, runtimeModel) {
            const launch = await authorize(args, signal, undefined, false,
                input.phase === 'build' || !runtimeModel ? undefined : createNativeRuntimeProjectionForHost({
                    kind: 'configuration', source: input.source, model: runtimeModel,
                    composeArguments: base, services: Object.keys(runtimeModel.services), io: input.io,
                    assertCurrent: () => assertCurrent(signal) }));
            try {
                const output = await runAuthorized(launch, signal);
                if (!launch.secretRedactionLease) return nativeRefusal('secret_redaction_unavailable');
                return await visit(output.stdout, launch.secretRedactionLease.redact);
            } finally { await launch.release(); }
        } });
    const readBuildKeys = async (signal?: AbortSignal): Promise<readonly MachineNativeEffectKey[]> => {
        const launch = await authorize(['info', '--format', '{{json .}}'], signal);
        try {
            const engine = await readNativeComposeEngine({ io: input.io, command: launch.command, prefix: launch.args.slice(0, -3),
                cwd: launch.cwd!, env: { ...launch.env, COMPOSE_DISABLE_ENV_FILE: '1' }, signal });
            return [{ kind: 'composeProject', dockerEndpoint: engine.id, projectName: admissionProjectName }];
        } finally { await launch.release(); }
    };
    const admittedImageEffect = async <T>(context: MachineNativeEffectContext | undefined,
        effect: (authority: NativeComposeEffectAuthority) => Promise<T>) => {
        if (!context) throw new MachineNativeEffectAdmissionError('admission_unavailable');
        return await machineNativeEffectAdmission.runStage(context, () => effect({ context }));
    };
    const render = async (options?: Parameters<NativeComposeEnvironmentProject['render']>[0]): Promise<NativeComposeProjectRender> => {
        const signal = options?.signal;
        await assertCurrent(signal);
        runtimePlatform = normalizeNativeComposePlatform((await run(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], signal)).stdout.trim());
        if (!/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-zA-Z0-9_.-]+)?$/u.test(runtimePlatform)) return nativeRefusal('deployment_platform_unavailable');
        const engineLaunch = await authorize(['info', '--format', '{{json .}}'], signal);
        let engine: NativeComposeEngineFacts;
        try { engine = await readNativeComposeEngine({ io: input.io, command: engineLaunch.command,
            prefix: engineLaunch.args.slice(0, -3), cwd: engineLaunch.cwd!, env: { ...engineLaunch.env, COMPOSE_DISABLE_ENV_FILE: '1' }, signal }); }
        finally { await engineLaunch.release(); }
        const engineId = engine.id;
        if (input.expectedEngineId !== undefined && engineId !== input.expectedEngineId) return nativeRefusal('native_origin_changed');
        const purpose = options?.purpose;
        const { model: normalized, configInputDigests, toolVersion } = await normalize(signal);
        if (!record(normalized.services)) return nativeRefusal('native_compose_configuration_invalid');
        const sourceServices = Object.keys(normalized.services);
        if (!sourceServices.length || selected.some(service => !record(normalized.services) || !record(normalized.services[service]))) return nativeRefusal('native_target_missing');
        const sourceBuildServices = sourceServices.filter(service => record(normalized.services) && record(normalized.services[service])
            && normalized.services[service].build !== undefined);
        const sourceImages = new Map(Object.entries(normalized.services).flatMap(([service, definition]) =>
            record(definition) && typeof definition.image === 'string' ? [[service, definition.image] as const] : []));
        // Native Compose already expanded extension/anchor fragments. Their
        // unused copies must not demand build values during runtime interpolation.
        for (const key of Object.keys(normalized)) if (key.startsWith('x-')) delete normalized[key];
        // Native Compose resolved includes/merges once. Only phase projection is
        // performed here; no YAML interpretation or placeholder render exists.
        for (const definition of Object.values(normalized.services)) {
            if (!record(definition)) return nativeRefusal('native_compose_configuration_invalid');
            delete definition.build;
            // Platform may be a runtime expression. Resolve the actual native
            // model without a guessed image or build-only image expression,
            // then select the exact receipt pin for that effective platform.
            delete definition.image;
            definition.pull_policy = 'never';
        }
        // Build-only secret declarations cannot demand build-phase values from
        // a runtime attachment after their consuming build sections are removed.
        const runtimeSecrets = new Set(Object.values(normalized.services).flatMap(service => record(service) && Array.isArray(service.secrets)
            ? service.secrets.flatMap(secret => typeof secret === 'string' ? [secret] : record(secret) && typeof secret.source === 'string' ? [secret.source] : []) : []));
        if (record(normalized.secrets)) normalized.secrets = Object.fromEntries(Object.entries(normalized.secrets).filter(([key]) => runtimeSecrets.has(key)));
        normalized.name = projectName;
        const runtimeFile = join(await directory(), 'runtime.compose.json');
        await writeFile(runtimeFile, JSON.stringify(normalized), { mode: 0o600 });
        const composeArgs = [...base, '--file', runtimeFile];
        const actualLaunch = await authorize([...composeArgs, 'config', '--format', 'json', '--no-consistency', ...selected], signal,
            undefined, false, input.phase === 'build' ? undefined : createNativeRuntimeProjectionForHost({ kind: 'configuration', source: input.source,
                model: normalized, composeArguments: base, services: selected, io: input.io,
                bindRuntimeEnvironment: purpose !== 'serviceCommand',
                assertCurrent: () => assertCurrent(signal) }));
        let model: Record<string, unknown>;
        let review: NativeComposeRuntimeReview;
        let sharedData: NativeComposeSharedDataPlan | undefined;
        try {
            model = nativeModel((await runAuthorized(actualLaunch, signal)).stdout);
            if (!actualLaunch.secretRedactionLease) return nativeRefusal('secret_redaction_unavailable');
            if (!record(model.services)) return nativeRefusal('native_compose_configuration_invalid');
            if (input.storage?.sharedData && input.sourceKind === 'repository') {
                const nativeBinds = createNativeComposeIncumbentBindReader({ projectName, run: args => run(args, signal),
                    readSourceCustody: input.storage.sharedData.readSourceCustody });
                sharedData = await projectNativeComposeSharedData({ model, source: input.source, unresolvedModel: normalized,
                    storage: input.storage.sharedData,
                    readIncumbentBind: nativeBinds.read, readSeedWriters: nativeBinds.writers });
            }
            const services = Object.keys(model.services);
            if (!services.length || selected.some(service => !record(model.services) || !record(model.services[service]))) return nativeRefusal('native_target_missing');
            const buildServices = services.filter(service => sourceBuildServices.includes(service));
            const definitions = model.services;
            const servicePlatforms = services.map(service => {
                const definition = definitions[service];
                if (!record(definition) || definition.platform !== undefined && typeof definition.platform !== 'string') return nativeRefusal('deployment_platform_unavailable');
                const platform = normalizeNativeComposePlatform(typeof definition.platform === 'string' ? definition.platform : runtimePlatform!);
                if (!/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-zA-Z0-9_.-]+)?$/u.test(platform)
                    || actualLaunch.secretRedactionLease!.redact(platform) !== platform) return nativeRefusal('deployment_platform_unavailable');
                return { service, platform };
            });
            effectivePlatforms = new Map(servicePlatforms.map(({ service, platform }) => [service, platform]));
            const unresolvedImages = services.filter(service => !images.some(image => image.service === service
                && normalizeNativeComposePlatform(image.platform) === effectivePlatforms.get(service)));
            // Native config owns selection and dependency closure. Retain only
            // its selected names in the unresolved phase projection used by up;
            // never persist the resolved model containing runtime secret values.
            const selectedServices = Object.fromEntries(Object.entries(normalized.services).filter(([service]) => services.includes(service)));
            normalized.services = selectedServices;
            for (const [service, definition] of Object.entries(selectedServices)) {
                if (!record(definition)) return nativeRefusal('native_compose_configuration_invalid');
                if (!unresolvedImages.includes(service)) definition.image = imageReferences(service).activationRef;
                else if (sourceImages.has(service)) definition.image = sourceImages.get(service);
            }
            await writeFile(runtimeFile, JSON.stringify(normalized), { mode: 0o600 });
            review = projectNativeComposeReview(model, input.source.rootPath, actualLaunch.secretRedactionLease.redact);
            if (unresolvedImages.length) review = { ...review, inspection: 'unknown', risks: [...review.risks,
                ...unresolvedImages.map(service => ({ kind: 'inspection_unknown' as const,
                    service: actualLaunch.secretRedactionLease!.redact(service) }))] };
            // Keep this capture's redactor alive through resolved-image storage
            // review; structural service/mount values may contain bound secrets.
            for (const service of input.sourceKind === 'stored' ? Object.values(model.services) : []) {
                if (!record(service) || !Array.isArray(service.volumes)) continue;
                for (const mount of service.volumes) {
                    if (!record(mount) || typeof mount.source !== 'string') continue;
                    if (mount.type === 'bind') {
                        let source = resolve(mount.source);
                        try { source = await realpath(source); } catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
                        const withinRelease = relative(input.source.rootPath, source);
                        if (!isAbsolute(withinRelease) && withinRelease !== '..'
                            && !withinRelease.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
                            throw new PluginError({ code: 'needs_repository', message: 'Move to a repository, then Prepare if needed' });
                        }
                    }
                }
            }
            const identity = createNativeComposeImageIdentity({ run: (args, identitySignal, registry, authority) =>
                run(args, identitySignal ?? signal, registry, args[1] !== 'inspect', authority), directory });
            const localImages = new Map<string, Readonly<{ reference: string; config: Record<string, unknown> }>>();
            let storage: NativeComposeStorageReview | undefined;
            if (input.storage || input.imageAcquisition) {
                for (const service of services) {
                    if (unresolvedImages.includes(service)) continue;
                    const local = await identity.locate(localReferences(service), pin(service));
                    if (local) localImages.set(service, local);
                }
                if (input.storage && localImages.size === services.length) storage = await inspectStorage(model,
                    new Map([...localImages].map(([service, local]) => [service, local.config])));
                else if (input.storage) review = { ...review, inspection: 'unknown', risks: [...review.risks,
                    ...services.filter(service => !localImages.has(service)).map(service => ({ kind: 'inspection_unknown' as const,
                        service: actualLaunch.secretRedactionLease!.redact(service) }))] };
            }
            await assertCurrent(signal);
            const result: NativeComposeProjectRender = { engineId, engine, projectName, platform: runtimePlatform, services, servicePlatforms, buildServices,
                ...(health ? { health } : {}), healthServices: candidate ? services : services.filter(service => !excludedFromHealth.has(service)),
                ...(sharedData ? { sharedData } : {}),
                environmentInstanceId: input.source.environmentInstanceId, admissionProjectName,
                keys: [{ kind: 'composeProject', dockerEndpoint: engineId, projectName: admissionProjectName }], review,
                ...(storage ? { storage: { warnings: storage.warnings.map(warning => ({ ...warning,
                    service: actualLaunch.secretRedactionLease!.redact(warning.service),
                    target: actualLaunch.secretRedactionLease!.redact(warning.target) })) } } : {}),
                basis: { manifestFingerprint: input.source.manifestFingerprint, configInputDigests, toolVersion, physicalProjectName: projectName,
                    ...(input.expectedEngineId === undefined ? {} : { nativeGeneration: await nativeGeneration(signal) }) } };
            if (options?.purpose === 'serviceCommand') assertCandidateServiceSupported(model, result, options.service);
            renderedCaptures.set(result, { model, unresolvedModel: structuredClone(normalized), composeArgs, identity, localImages,
                ...(options?.purpose === 'serviceCommand' ? { commandService: options.service } : {}) });
            return result;
        } finally { await actualLaunch.release(); }
    };
    // This is the existing activation image stage, shared rather than copied
    // into finite run. The candidate factory consumes its exact prepared fact.
    const candidateRefusal = (reason: string): never => { throw new PluginError({ code: 'service_admission_unavailable',
        message: 'The admitted candidate service command is unavailable', details: { reason } }); };
    // P30 §3.2b: a candidate may not silently start dependencies. P41 must
    // produce its explicit dependency stage before this owner can admit them.
    // Current shared-data seeding is activation-only; do not acquire/tag images
    // for a command that cannot yet read its admitted source. This read-only
    // preflight is shared by render and dispatch, not a consumer-side parser.
    const assertCandidateServiceSupported = (model: Record<string, unknown>,
        rendered: Pick<NativeComposeProjectRender, 'services' | 'sharedData'>, service: string) => {
        if (!record(model.services) || !rendered.services.includes(service) || !record(model.services[service]))
            return candidateRefusal('candidate_service_unavailable');
        const definition = model.services[service];
        if (record(definition.depends_on) && Object.keys(definition.depends_on).length
            || Array.isArray(definition.depends_on) && definition.depends_on.length
            || ['network_mode', 'ipc', 'pid'].some(key => typeof definition[key] === 'string'
                && definition[key].startsWith('service:'))
            || Array.isArray(definition.volumes_from) && definition.volumes_from.length
            || Array.isArray(definition.links) && definition.links.length)
            return candidateRefusal('candidate_dependency_identity_unavailable');
        if (rendered.sharedData?.seeds.some(seed => seed.services.includes(service)))
            return candidateRefusal('candidate_shared_data_not_prepared');
    };
    const prepareRuntimeRender = async (request: Parameters<NativeComposeEnvironmentProject['activate']>[0]) => {
        if (activation || !renderedCaptures.has(request.render)) return nativeRefusal('deployment_generation_unavailable');
        const service = renderedCaptures.get(request.render)!.commandService;
        const current = await render(service === undefined ? (request.signal ? { signal: request.signal } : undefined)
            : { purpose: 'serviceCommand', service, ...(request.signal ? { signal: request.signal } : {}) });
        if (JSON.stringify(current.basis) !== JSON.stringify(request.render.basis)) return nativeRefusal('deployment_input_changed');
        const authority = { context: request.context };
        const capture = renderedCaptures.get(current)!;
        const { identity } = capture;
        for (const service of current.services) pin(service);
        const acquired = new Map(capture.localImages);
        if (input.storage?.sharedData && current.sharedData) await assertNativeComposeSharedDataPaths({
            storage: input.storage.sharedData, paths: current.sharedData.paths });
        for (const service of current.services) {
            const image = pin(service);
            const local = await identity.acquire(image, { references: localReferences(service), acquisition: input.imageAcquisition, authority,
                pull: async (registry, reference) => { await run(['image', 'pull', '--platform', image.platform, reference], request.signal, registry, true, authority); } });
            acquired.set(service, local);
        }
        const imageConfigs = new Map([...acquired].map(([service, local]) => [service, local.config]));
        if (candidate) assertNativeComposeStartFirstConfiguration(capture.model, imageConfigs);
        if (input.storage || candidate) await inspectStorage(capture.model, imageConfigs);
        for (const service of current.services) {
            const { reference } = acquired.get(service)!;
            const { ownedTag, activationRef } = imageReferences(service);
            await run(['image', 'tag', reference, ownedTag], request.signal, undefined, true, authority);
            await run(['image', 'tag', reference, activationRef], request.signal, undefined, true, authority);
        }
        return { current, capture, identity, authority };
    };
    const owner: NativeComposeEnvironmentProject = {
        async observeActivated(request) {
            const capture = renderedCaptures.get(request.render);
            if (input.phase === 'build' || !capture) return { kind: 'unknown', reason: 'deployment_generation_unavailable' };
            try {
                await assertCurrent(request.signal);
                const snapshot = await generation.snapshot(request.signal);
                if (!snapshot.ids.length) return { kind: 'absent' };
                const proof = await inspectGeneration(request.render, capture.identity, request.signal, { snapshot, purpose: request.purpose });
                proof.routingServices(); // Complete native replica/name/network proof before lending the handle.
                if (activation?.isCurrent()) {
                    if (request.render.services.some(service => {
                        const previous = activation!.nativeIdsForService(service);
                        const current = proof.serviceNativeIds.get(service)!;
                        return previous.length !== current.length || previous.some(id => !current.includes(id));
                    })) return { kind: 'unknown', reason: 'deployment_generation_unavailable' };
                    // Keep the same native lifetime and immutable identity;
                    // readiness belongs to THIS observation's purpose/proof.
                    if (activation.health !== proof.health) activation = { ...activation, health: proof.health };
                    return { kind: 'active', activation };
                }
                const launch = await authorize([...capture.composeArgs, 'config', '--format', 'json'], request.signal,
                    undefined, false, createNativeRuntimeProjectionForHost({ kind: 'configuration', source: input.source,
                        model: capture.unresolvedModel, composeArguments: base, services: request.render.services,
                        io: input.io, assertCurrent: () => assertCurrent(request.signal) }));
                try {
                    if (!launch.detachDeploymentEnvironmentForObservation) return nativeRefusal('secret_redaction_unavailable');
                    const prefix = authorizedPrefixes.get(launch)?.prefix ?? nativeRefusal('native_service_admission_required');
                    activation = retainActivation(request.render, capture, proof, launch.detachDeploymentEnvironmentForObservation(), prefix);
                    return { kind: 'active', activation };
                } catch (error) { await launch.release(); throw error; }
            } catch (error) {
                if (request.signal?.aborted) throw error;
                const details = record(error) && record(error.details) ? error.details : undefined;
                return { kind: 'unknown', reason: typeof details?.reason === 'string' ? details.reason : 'deployment_generation_unavailable' };
            }
        },
        async admitResticCommand(request) {
            const capture = renderedCaptures.get(request.render);
            if (input.phase === 'build' || !capture) return candidateRefusal('native_restic_source_unavailable');
            return admitNativeResticCommand(request, { source: input.source, exec: input.exec, io: input.io,
                model: capture.model, identity: capture.identity, assertCurrent: () => assertCurrent(request.signal),
                containerIds: () => {
                    const current = activation;
                    return current ? current.services.flatMap(service => [...current.nativeIdsForService(service)]) : [];
                },
                run: args => run(args, request.signal) });
        },
        async prepareResticRuntime(request) {
            const capture = renderedCaptures.get(request.render);
            if (input.phase === 'build' || !capture) return candidateRefusal('native_restic_source_unavailable');
            return admittedImageEffect(request.context, async authority => {
                const signal = request.context.operation.signal;
                const [image] = await capture.identity.resolveVariants({ service: 'restic', reference: RESTIC_RUNTIME_V1.image,
                    platforms: [request.render.platform] }, { signal });
                if (!image?.registryReference) return nativeRefusal('deployment_image_unavailable');
                await capture.identity.acquire(image, { references: [image.registryReference], purpose: 'operationRuntime', authority,
                    pull: async (registry, reference) => { await run(['pull', '--platform', image.platform, reference], signal, registry, true, authority); } });
                return image;
            });
        },
        createStartFirstCandidate() {
            if (input.phase === 'build') return nativeRefusal('deployment_runtime_phase_required');
            const generationName = resolveNativeComposeCandidateProjectName(admissionProjectName, input.source.deploymentId);
            return createEnvironmentProject({ ...input, physicalProjectName: generationName }, { admissionProjectName });
        },
        async activateStartFirst(request) {
            if (request.target) {
                if (request.target !== activation || !request.target.isCurrent() || !renderedCaptures.has(request.render))
                    return nativeRefusal('deployment_generation_unavailable');
            } else if (!candidate) return nativeRefusal('deployment_generation_unavailable');
            return activateNativeComposeStartFirst(request, value => owner.activate(value));
        },
        async describeBuild(options) { return { ...await imagePreparation.describeBuild(options), keys: await readBuildKeys(options?.signal) }; },
        async prepareImages(options) {
            return options?.build && !options.planOnly
                ? admittedImageEffect(options.context, authority => imagePreparation.prepareImages({ ...options, authority }))
                : imagePreparation.prepareImages(options);
        },
        async exportImages(request) {
            return admittedImageEffect(request.context, authority => imagePreparation.exportImages({ ...request, authority }));
        },
        render,
        async assertReviewedGeneration(current, signal) {
            if (current.basis.nativeGeneration === undefined) return;
            if (JSON.stringify(await nativeGeneration(signal)) !== JSON.stringify(current.basis.nativeGeneration)) {
                throw new PluginError({ code: 'deployment_conflict', message: 'The reviewed native generation has changed' });
            }
        },
        async prepareRuntimeImages(request) {
            if (input.phase === 'build') return nativeRefusal('deployment_runtime_phase_required');
            const prepared = await prepareRuntimeRender(request);
            renderedCaptures.get(request.render)!.prepared = { render: prepared.current, context: request.context };
        },
        async admitServiceCommand(request) {
            const refused = candidateRefusal;
            const { context, service, signal } = request;
            if (input.phase === 'build' || activation || request.command.mode !== 'run') return refused('candidate_command_unavailable');
            const prepared = renderedCaptures.get(request.render)?.prepared;
            if (!prepared || prepared.context !== context) return refused('candidate_images_not_prepared');
            const current = prepared.render;
            const capture = renderedCaptures.get(current) ?? refused('candidate_render_unavailable');
            if (capture.commandService !== service) return refused('candidate_runtime_carrier_unavailable');
            assertCandidateServiceSupported(capture.model, current, service);
            // Bind literal argv before any asynchronous stage; only the P41
            // prepared owner may supply its exact approved migration command.
            const command = { mode: 'run' as const, argv: Object.freeze([...request.command.argv]) };
            const environmentOverrides = request.environmentOverrides ? Object.freeze({ ...request.environmentOverrides }) : undefined;
            const commandArguments = nativeServiceCommandArgs([], service, command);
            const assertCandidateCurrent = async () => {
                await assertCurrent(signal);
                if (activation) return refused('candidate_became_incumbent');
            };
            await assertCandidateCurrent();
            // Candidate image identity is admitted once before dispatch. Its
            // child launch keeps cancellation and the same prepared model.
            await capture.identity.prove(imageReferences(service).activationRef, pin(service));
            return admitNativeServiceCommandForHost({ context,
                ...(signal ? { signal } : {}), assertCurrent: assertCandidateCurrent,
                launch: () => authorize(nativeServiceCommandArgs(capture.composeArgs, service, command), signal,
                    undefined, false, createNativeRuntimeProjectionForHost({ kind: 'candidate', source: input.source,
                        model: capture.unresolvedModel, composeArguments: base, service,
                        commandArguments, ...(environmentOverrides ? { environmentOverrides } : {}),
                        io: input.io, assertCurrent: assertCandidateCurrent })) });
        },
        settleNative: input.settleNative,
        async observe(request) {
            if (!renderedCaptures.has(request.render)) return nativeRefusal('deployment_generation_unavailable');
            try {
                const { health } = await inspectGeneration(request.render, renderedCaptures.get(request.render)!.identity, request.signal);
                return { status: 'matching', health };
            } catch (error) {
                if (request.signal?.aborted) throw error;
                const details = record(error) && record(error.details) ? error.details : undefined;
                const reason = details && typeof details.reason === 'string' ? details.reason : undefined;
                if (reason === 'deployment_activation_failed') return { status: 'different', health: 'unhealthy' };
                if (reason === 'deployment_generation_unavailable' || reason === 'deployment_image_identity_mismatch'
                    || reason === 'deployment_image_platform_mismatch' || reason === 'deployment_image_manifest_mismatch') {
                    return { status: 'different', health: 'unverified' };
                }
                return { status: 'unknown', health: 'unverified' };
            }
        },
        async activate(request) {
            if (renderedCaptures.get(request.render)?.commandService !== undefined) {
                return nativeRefusal('deployment_activation_requires_regular_render');
            }
            const { current, capture, identity, authority } = await prepareRuntimeRender(request);
            if (input.storage?.sharedData && current.sharedData?.seeds.length) {
                const seedRoot = join(await realpath(input.storage.sharedData.environmentRoot), 'shared');
                const nativeBinds = createNativeComposeIncumbentBindReader({ projectName, run: args => run(args, request.signal),
                    readSourceCustody: input.storage.sharedData.readSourceCustody });
                for (const seed of current.sharedData.seeds) {
                    const observed = await nativeBinds.read('', '', seed.relativePath);
                    if (observed && observed.path !== seed.sourcePath) throw new MachineNativeEffectAdmissionError('plan_changed');
                }
                const quiesce = await nativeBinds.writers(current.sharedData.seeds.flatMap(seed =>
                    [join(seedRoot, seed.relativePath), ...(seed.sourcePath ? [seed.sourcePath] : [])]));
                // Quiesce only native services overlapping a pending seed's
                // source or destination, including an existing shared ancestor.
                if (quiesce.length) await run(['stop', ...quiesce], request.signal, undefined, true, authority);
                try {
                    await seedNativeComposeSharedData({ source: input.source, storage: input.storage.sharedData, plan: current.sharedData,
                        assertCurrent: () => assertCurrent(request.signal) });
                } catch (error) {
                    // A known failed seed has not recreated the incumbent. Its
                    // original containers still hold their original mounts.
                    if (quiesce.length && !request.signal?.aborted) await run(['start', ...quiesce], request.signal, undefined, true, authority);
                    throw error;
                }
            }
            const selectiveHealth = current.healthServices.length !== current.services.length;
            // C11: Compose owns readiness settlement. Keep its native health/exit
            // verdict and the caller's cancellation, without a derived deadline.
            const upArgs = [...capture.composeArgs, 'up', '--detach', ...(selectiveHealth ? [] : ['--wait']), '--remove-orphans', '--no-build', '--pull', 'never',
                ...current.services];
            // Capture unchanged native counters before up, not after a crash.
            // The same witnessed ids also delimit first-deploy failure cleanup.
            const preexisting = await generation.captureBaseline(request.signal);
            const runtimeProjection = (commandArguments: readonly string[]) => createNativeRuntimeProjectionForHost({
                kind: 'runtime', source: input.source, model: capture.unresolvedModel,
                composeArguments: base, services: current.services, commandArguments,
                io: input.io, assertCurrent: () => assertCurrent(request.signal) });
            let launch = await authorize(upArgs, request.signal, undefined, false,
                runtimeProjection(upArgs.slice(capture.composeArgs.length)));
            let provenServiceIds: ReadonlyMap<string, readonly string[]> | undefined;
            const stopLending = machineNativeEffectAdmission.lendComposeLogMasking(request.context, target => {
                if (target.sourcePath !== input.source.rootPath) return undefined;
                const ids = provenServiceIds?.get(target.composeService);
                if (ids && (ids.length !== target.containerIds.length || !ids.every(id => target.containerIds.includes(id)))) return undefined;
                return { lease: launch.secretRedactionLease, complete: ids !== undefined };
            });
            try {
                if (input.storage?.sharedData && current.sharedData) await assertNativeComposeSharedDataPaths({
                    storage: input.storage.sharedData, paths: current.sharedData.paths });
                await runAuthorized(launch, request.signal, true, authority);
                if (selectiveHealth) {
                    // Compose 2.39.4 start.go:72-107 waits on every service in
                    // the selected project. up.go:60-67 makes --no-deps select
                    // only participants, after the ordinary dependency start.
                    // Keep every real healthcheck and never remove excluded
                    // containers as orphans or recreate the running generation.
                    const completed = nativeComposeCompletedServices(capture.model);
                    const waiting = current.healthServices.filter(service => !completed.has(service));
                    if (waiting.length) {
                        const command = ['up', '--detach', '--wait', '--no-deps', '--no-recreate',
                            '--no-build', '--pull', 'never', ...waiting];
                        const waitLaunch = await authorize([...capture.composeArgs, ...command], request.signal, undefined, false,
                            runtimeProjection(command));
                        try { await runAuthorized(waitLaunch, request.signal, true, authority); }
                        finally { await waitLaunch.release(); }
                    }
                }
                const proof = await inspectGeneration(current, identity, request.signal);
                provenServiceIds = proof.serviceNativeIds;
                if (!launch.detachDeploymentEnvironmentForObservation) return nativeRefusal('secret_redaction_unavailable');
                launch = launch.detachDeploymentEnvironmentForObservation();
                const prefix = launch.args.slice(0, launch.args.length - upArgs.length);
                activation = retainActivation(current, capture, proof, launch, prefix, stopLending);
                return activation;
            } catch (error) {
                try {
                    const details = record(error) && record(error.details) ? error.details : undefined;
                    if (request.cleanupOnFailure && !request.signal?.aborted
                        && ['deployment_activation_failed', 'native_compose_command_failed'].includes(String(details?.reason))) {
                        const listed = (await run(['ps', '--all', '--no-trunc', '--filter',
                            `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}'], request.signal)).stdout.trim().split('\n').filter(Boolean);
                        const introduced = listed.filter(id => !preexisting.includes(id));
                        if (!introduced.length) throw error;
                        const inspected = await run(['inspect', '--type', 'container', ...introduced], request.signal);
                        const rows: unknown = JSON.parse(inspected.stdout);
                        if (!Array.isArray(rows) || rows.length !== introduced.length) throw error;
                        for (const row of rows) {
                            if (!record(row) || typeof row.Id !== 'string' || !introduced.includes(row.Id) || typeof row.Image !== 'string'
                                || !record(row.Config) || !record(row.Config.Labels)
                                || row.Config.Labels['com.docker.compose.project'] !== projectName
                                || typeof row.Config.Labels['com.docker.compose.service'] !== 'string'
                                || !current.services.includes(row.Config.Labels['com.docker.compose.service'])) throw error;
                            await identity.prove(row.Image, pin(row.Config.Labels['com.docker.compose.service']));
                        }
                        const removed = await removeWitnessedContainers({ ids: introduced, project: projectName, services: current.services,
                            run: args => run(args, request.signal, undefined, false, authority) });
                        if (removed) throw new PluginError({ code: 'native_failed', message: 'First deployment failed; introduced containers were removed',
                            details: { reason: String(details?.reason), firstDeployCleanup: 'removed' } });
                    }
                    throw error;
                } finally { stopLending(); await launch.release(); }
            }
        },
        async dispose() {
            if (closed) return;
            closed = true;
            if (activation) await activation.dispose();
            else await removeDirectory();
        },
    };
    return owner;
}

function nativeRefusal(reason: string): never {
    throw new PluginError({ code: 'native_failed', message: 'Native Compose operation could not be completed', details: { reason } });
}



function nativeModel(stdout: string): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(stdout); } catch { return nativeRefusal('native_compose_configuration_invalid'); }
    if (!record(value) || !record(value.services)) return nativeRefusal('native_compose_configuration_invalid');
    return value;
}

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
        const startedAtMs = runtimeFacts.accounting?.startedAtMs;
        runtimeFacts = { ...runtimeFacts, accounting: startedAtMs === undefined ? undefined : { startedAtMs } };
        const selected = nativeContainers?.filter(row => row.service === target).map(row => row.id).sort();
        if (!selected?.length) return { kind: 'unavailable', reason: 'unavailable' };
        try {
            const result = await run(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...selected], signal);
            signal.throwIfAborted();
            const current = nativeContainers?.filter(row => row.service === target).map(row => row.id).sort();
            if (!current || JSON.stringify(current) !== JSON.stringify(selected) || result.exitCode !== 0) {
                return { kind: 'unavailable', reason: 'unavailable' };
            }
            const sampled = nativeAccounting(result.stdout, selected);
            if (sampled.kind === 'sample' && sampled.samples.length && sampled.samples.every(sample => sample.memoryBytes !== null)) {
                runtimeFacts = { ...runtimeFacts, accounting: { ...runtimeFacts.accounting,
                    memoryBytes: sampled.samples.reduce((total, sample) => total + sample.memoryBytes!, 0) } };
            }
            return sampled;
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
    const unknownObservation = { ...unknown, displayName: project };
    const stoppedObservation = { ...stopped, displayName: project };
    const observe = (rows: readonly Container[] | null): ManagedServiceNativeObservationV1 => {
        if (cleared) return stoppedObservation;
        if (!rows) return unknownObservation;
        // A missing deployment generation is not a stopped incumbent that can
        // be started again. Only deploy/rollback can recreate missing resources.
        if (input.environment && rows.length === 0) return unknownObservation;
        if (rows.every(row => ['created', 'exited', 'dead'].includes(row.state))) return stoppedObservation;
        const selected = rows.filter(row => row.service === target);
        if (!selected.length || selected.some(row => row.state !== 'running')
            || rows.some(row => !['running', 'exited', 'dead'].includes(row.state))) return unknownObservation;
        return { phase: 'running', readiness: selected.every(row => row.health === 'healthy') ? 'ready'
            : selected.some(row => row.health === 'starting' || row.health === 'unhealthy') ? 'not_ready' : 'not_reported', endpoint: endpoint(selected), displayName: project };
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
    const prepareServiceLaunch = async (args: readonly string[], signal?: AbortSignal): Promise<HostAuthorizedPluginExecLaunch> => {
            signal?.throwIfAborted();
            const rows = await read(signal);
            if (!input.environment || !rows?.length || rows.length !== ids?.length
                || rows.some(row => row.state !== 'running') || !input.retainLaunch) {
                throw new PluginError({ code: 'deployment_generation_required', message: 'The admitted service generation is unavailable' });
            }
            const retained = input.retainLaunch();
            let released: Promise<void> | undefined;
            try {
                signal?.throwIfAborted();
                if (!retained.secretRedactionLease?.isActive()) throw new PluginError({ code: 'secret_redaction_unavailable', message: 'Service shell redaction is unavailable' });
                // The retained observer is the finalized original host tuple,
                // not the application overlay. Keep its admitted endpoint.
                const env = retained.env;
                if (!retained.cwd || !engineId || (await readNativeComposeEngine({ io: input.io, command: retained.command,
                    prefix, cwd: retained.cwd, env, signal })).id !== engineId) {
                    throw new PluginError({ code: 'deployment_generation_required', message: 'The admitted service engine is unavailable' });
                }
                signal?.throwIfAborted();
                return { ...retained, args,
                    env: { ...env, COMPOSE_DISABLE_ENV_FILE: '1' }, async release() {
                        return released ??= Promise.resolve().then(() => retained.release());
                    } };
            } catch (error) { await retained.release(); throw error; }
    };
    const lifecycle: ProjectBuiltinNativeLifecycle = {
        shell: options => prepareServiceLaunch([...prefix, ...input.args, 'exec', '-it', target, '/bin/sh'], options?.signal),
        async admitServiceCommand(command, options) {
            if (command.mode !== 'exec') throw new PluginError({ code: 'service_admission_unavailable', message: 'A fresh admitted runtime environment is required for a one-off service command' });
            const args = nativeServiceCommandArgs([...prefix, ...input.args], target, command);
            return admitNativeServiceCommandForHost({ ...options,
                launch: () => prepareServiceLaunch(args, options.signal) });
        },
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
                    // A replicated service has been fully up since its newest member started.
                    const startedAtMs = engineRows?.length && engineRows.every(row => row.startedAtMs !== undefined)
                        ? Math.max(...engineRows.map(row => row.startedAtMs!)) : undefined;
                    const healthSince = engineRows?.length && engineRows.every(row => row.healthSince !== undefined)
                        ? Math.max(...engineRows.map(row => row.healthSince!)) : undefined;
                    const memoryBytes = engineRows && runtimeFacts.accounting?.startedAtMs === startedAtMs
                        ? runtimeFacts.accounting?.memoryBytes : undefined;
                    const ports = engineRows && readNativeComposePublishedPorts(engineRows.map(row => row.ports),
                        value => launch?.secretRedactionLease?.redact(value) ?? value);
                    runtimeFacts = { configuration: engineRows && configuration
                        ? ports ? { ...configuration, ports } : null : runtimeFacts.configuration,
                        observedAt: engineRows ? Date.now() : runtimeFacts.observedAt,
                        freshness: engineRows ? 'current' : 'unavailable',
                        ...(startedAtMs === undefined && memoryBytes === undefined ? {} : { accounting: {
                            ...(startedAtMs === undefined ? {} : { startedAtMs }), ...(memoryBytes === undefined ? {} : { memoryBytes }) } }),
                        ...(healthSince === undefined ? {} : { healthSince }) };
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
