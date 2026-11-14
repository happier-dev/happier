import { posix } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createHash } from 'node:crypto';
import type { DeploymentExecEnvPortV1 } from '@happier-dev/plugin-sdk/exec';
import type { DeploymentImageV1, DeploymentReceiptDetailV1, DeploymentRestoreUploadFormatV1, DeploymentRestoreUploadSourceV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { prepareDeploymentRestoreV1, confirmDeploymentRestoreV1, runDeploymentBackupV1, resolveDeploymentRestoreCaptureV1,
    deploymentRestoreStepProgressV1,
    type DeploymentRestorePrepareInputV1, type DeploymentRestoreConfirmInputV1,
    type DeploymentRestorePrepareReceiptV1, type DeploymentRestoreResultV1,
    type DeploymentRestoreNativeRequestV1, type DeploymentRestoreNativeResultV1,
    type DeploymentBackupRunInputV1, type DeploymentBackupRunResultV1, type DeploymentRestoreResolvedCaptureV1,
    type ResticAccessV1, type DeploymentRestoreDestinationV1, type DeploymentRestoreDatabaseDestinationV1,
    type DeploymentRestoreVolumeDestinationV1, type DeploymentRestoreSqliteDestinationV1, type DeploymentRestoreCopyMappingV1 } from '@happier-dev/deployments';
import type { OwnServerDeploymentReceipt, OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import type { OwnServerDatabaseUsernameForHost } from './backupDestination';
import { createNativeComposeLifecycle, executeAdmittedServiceCommand, admitServiceCommandStreamForHost,
    type NativeComposeEnvironmentProject, type NativeComposeProjectRender,
    type NativeComposeActivatedProject, type NativeComposeObservationIo } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { machineNativeEffectAdmission, type MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readCredentialRedactionValues } from '@/plugins/runtime/invocation/services/credentialRedactionValues';
import { admitServiceCommandInputForHost } from '@/daemon/local/services/launch/serviceCommand';
import { createBufferTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { AdmittedDeploymentRestoreUpload } from '@/transfers/targets/deploymentRestoreUpload';
import { createNativeSqliteRestore } from './nativeSqliteRestore';
import { admitOwnServerRestoreUpload } from './restoreUpload';

/** A receipt transition whose content is the own-server arm. */
export type OwnServerReceiptContentTransition = Omit<Parameters<OwnServerDeploymentTargetHostInput['writeTransition']>[0], 'content'>
    & Readonly<{ content: OwnServerDeploymentReceipt['content'] }>;

/** Captured by the existing own-server host, inside its admitted native job.
 * readAccess belongs to the SAME P42 prepare closure, not attachment decoding.
 */
export type OwnServerNativeRestoreInput = Readonly<{
    project: NativeComposeEnvironmentProject;
    render: NativeComposeProjectRender;
    activation: NativeComposeActivatedProject;
    context: MachineNativeEffectContext;
    io: NativeComposeObservationIo;
    runtimeImage: DeploymentImageV1;
    execEnv: DeploymentExecEnvPortV1;
    readAccess(): ResticAccessV1;
    readDatabaseUsername(service: string): Promise<OwnServerDatabaseUsernameForHost | undefined>;
    /** Native activation can retain this source even when its reply fails or is cancelled. */
    retainSource(): Promise<void>;
    onStopPending(status: 'stop_pending'): void;
    /** Planned interruption, published before stop; actual custody remains separate. */
    onExpectedDownServicesChanged?(services: readonly string[]): Promise<void>;
    onIncumbentServicesChanged?(services: readonly string[]): Promise<void>;
    onNamedVolumeBindingsChanged?(bindings: NativeComposeProjectRender['namedVolumes']): Promise<void>;
    operationProgress?: ActionExecutorContext['operationProgress'];
    onBackupSettled?: DeploymentBackupRunInputV1['onSettled'];
}>;

export type OwnServerNativeUploadRestoreInput = Omit<OwnServerNativeRestoreInput, 'execEnv' | 'readAccess' | 'runtimeImage'>
    & Readonly<{ upload: AdmittedDeploymentRestoreUpload; runtimeImage?: DeploymentImageV1 }>;

type NativeRestore = Readonly<{
    access?: ResticAccessV1;
    signal: AbortSignal;
    execute(request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1>;
    executeBackup: DeploymentBackupRunInputV1['execute'];
    onBackupSettled?: DeploymentBackupRunInputV1['onSettled'];
    runProtectedStage<T>(effect: () => Promise<T>): Promise<T>;
    onStep: NonNullable<DeploymentRestorePrepareInputV1['onStep']>;
}>;
const unsupported = (): never => { throw new PluginError({ code: 'unsupported_action',
    message: 'The admitted native restore tools are unavailable' }); };
const completedControl = { kind: 'completed' as const, exitCode: 0, stdout: '', stdoutTruncated: false };

/** P41's PostgreSQL integrity codec: default pg_amcheck corruption checks of
 * supported tables/TOAST/materialized views/sequences/btree indexes, not SELECT 1.
 * --install-missing prevents an absent amcheck extension silently skipping DBs.
 * https://www.postgresql.org/docs/15/app-pgamcheck.html
 * Positional conninfo selects ONE literal database, unlike --database patterns.
 * https://www.postgresql.org/docs/15/libpq-connect.html#LIBPQ-CONNSTRING
 */
function databaseConninfo(database: string): string {
    const escaped = database.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    return `dbname='${escaped}'`;
}
function integrityCommand(database: string): readonly string[] {
    return ['pg_amcheck', '--no-password', '--install-missing', databaseConninfo(database)];
}

type NativeRestoreServiceInput = Pick<OwnServerNativeRestoreInput, 'project' | 'activation' | 'io' | 'render' | 'context' | 'readDatabaseUsername'>;
function restoreServices(input: NativeRestoreServiceInput) {
    const services = new Map<string, { native: ReturnType<typeof createNativeComposeLifecycle>;
        username?: Promise<string | undefined>; launch: ReturnType<NativeComposeActivatedProject['authorizeServiceObserver']> }>();
    const lifecycle = (name: string) => {
        const existing = services.get(name);
        if (existing) return existing.native.lifecycle;
        const native = createNativeComposeLifecycle({ args: input.activation.composeArgs, io: input.io,
            retainLaunch: () => input.activation.authorizeServiceObserver(), engineId: input.render.engineId,
            environment: { composeService: name, containerIds: input.activation.nativeIdsForService(name),
                facts: input.activation.nativeFactsForService(name) } });
        const launch = input.activation.authorizeServiceObserver();
        services.set(name, { native, launch });
        native.bindLaunch(launch);
        return native.lifecycle;
    };
    return { lifecycle,
        async admit(name: string, argv: readonly string[], environmentOverrides?: Readonly<Record<string, string>>, sensitiveValues?: readonly string[]) {
            const service = lifecycle(name);
            if (!service.admitServiceCommand) return unsupported();
            const captured = services.get(name)!;
            // One resolution per native service capture; version probes do not
            // connect, and writer lifecycle operations need no database operand.
            const username = argv.includes('--version') || argv.includes('--list') || argv.some(arg => arg.startsWith('--username=')) ? undefined
                : await (captured.username ??= input.readDatabaseUsername(name).then(material => {
                    captured.launch.secretRedactionLease?.add(material?.secretValues.flatMap(rawCredential =>
                        readCredentialRedactionValues({ rawCredential })) ?? []);
                    return material?.username;
                }));
            const command = username === undefined ? argv : [argv[0]!, `--username=${username}`, ...argv.slice(1)];
            return service.admitServiceCommand({ mode: 'exec', argv: command }, { context: input.context,
                keys: input.render.keys, signal: input.context.operation.signal, environmentOverrides, sensitiveValues, async assertCurrent() {
                    if (!input.activation.isCurrent()) throw new PluginError({ code: 'deployment_generation_required',
                        message: 'The admitted restore generation is unavailable' });
                } });
        },
        async dispose() { await Promise.all([...services.values()].map(service => service.launch.release())); },
    };
}

/** Native destination observation precedes backup credential acquisition. */
type DatabaseObservation = Readonly<{ operationId: string; environmentId: string; revision: number }>;
type PostgresTarget = Pick<DeploymentRestoreDatabaseDestinationV1, 'service' | 'adapter' | 'database'>;
type SqliteTarget = Pick<DeploymentRestoreSqliteDestinationV1, 'service' | 'adapter' | 'path'>;
export function observeOwnServerNativeRestoreDestination(input: NativeRestoreServiceInput, capture: DatabaseObservation & Readonly<{ target: PostgresTarget }>): Promise<DeploymentRestoreDatabaseDestinationV1>;
export function observeOwnServerNativeRestoreDestination(input: NativeRestoreServiceInput, capture: DatabaseObservation & Readonly<{ target: SqliteTarget }>): Promise<DeploymentRestoreSqliteDestinationV1>;
export function observeOwnServerNativeRestoreDestination(input: NativeRestoreServiceInput, capture: DatabaseObservation & Readonly<{ target: PostgresTarget | SqliteTarget }>): Promise<DeploymentRestoreDatabaseDestinationV1 | DeploymentRestoreSqliteDestinationV1>;
export async function observeOwnServerNativeRestoreDestination(input: NativeRestoreServiceInput,
    capture: DatabaseObservation & Readonly<{ target: PostgresTarget | SqliteTarget }>): Promise<DeploymentRestoreDatabaseDestinationV1 | DeploymentRestoreSqliteDestinationV1> {
    const services = restoreServices(input);
    try {
        return await machineNativeEffectAdmission.runStage(input.context, async () => {
            if (capture.target.adapter === 'sqlite-v1') {
                const target = capture.target;
                const selected = input.render.review.services.find(service => service.name === target.service);
                const mounted = selected?.mounts.filter(mount => {
                    if (!mount.target) return false;
                    const relative = posix.relative(mount.target, target.path);
                    return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative);
                }).sort((a, b) => (b.target?.length ?? 0) - (a.target?.length ?? 0))[0];
                if (!mounted?.source || mounted.type !== 'volume' && mounted.type !== 'bind') return unsupported();
                const writerServices: string[] = [];
                for (const service of input.render.review.services) {
                    if (!service.mounts.some(mount => mount.type === mounted.type && mount.source === mounted.source && !mount.readOnly)) continue;
                    const state = await services.lifecycle(service.name).inspect({ signal: input.context.operation.signal });
                    if (state.phase === 'running') writerServices.push(service.name);
                    else if (state.phase !== 'stopped') throw new PluginError({ code: 'outcome_unknown', message: 'A SQLite writer has unknown native state' });
                }
                return createNativeSqliteRestore(input, async () => unsupported()).observe(target, { ...capture, writerServices });
            }
            const names = await executeAdmittedServiceCommand(await services.admit(capture.target.service,
                ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '--dbname=postgres', '-At', '-c',
                    'SELECT COALESCE(json_agg(datname),\'[]\'::json) FROM pg_database']));
            if (names.kind !== 'completed' || names.exitCode !== 0 || names.stdoutTruncated) {
                throw new PluginError({ code: 'outcome_unknown', message: 'The destination database observation did not settle' });
            }
            const databases: unknown = JSON.parse(names.stdout);
            if (!Array.isArray(databases) || databases.some(value => typeof value !== 'string')) return unsupported();
            const writerServices: string[] = [];
            for (const name of input.activation.services) {
                if (name === capture.target.service) continue;
                const observed = await services.lifecycle(name).inspect({ signal: input.context.operation.signal });
                if (observed.phase === 'running') writerServices.push(name);
                else if (observed.phase !== 'stopped') throw new PluginError({ code: 'outcome_unknown', message: 'A database writer has unknown native state' });
            }
            // Preserve any existing database, including schema-only data, with
            // the parent's safety backup. Names fit PostgreSQL's 63-byte limit.
            const identity = createHash('sha256').update(capture.operationId).digest('base64url');
            const databaseExists = databases.includes(capture.target.database);
            return { environmentId: capture.environmentId, revision: capture.revision, ...capture.target,
                stagingDatabase: `happier_${identity}_stage`, recoveryDatabase: `happier_${identity}_old`,
                databaseExists, hasMeaningfulData: databaseExists, writerServices };
        });
    } finally { try { await input.project.settleNative(); } finally { await services.dispose(); } }
}

/** P41 resolves the logical volume once; the restore keeps its physical binding
 * and the exact running set so activation cannot start deliberately stopped services. */
export async function observeOwnServerNativeVolumeRestoreDestination(input: NativeRestoreServiceInput,
    capture: Readonly<{ operationId: string; environmentId: string; revision: number;
        target: Pick<DeploymentRestoreVolumeDestinationV1, 'service' | 'adapter' | 'volume'> }>): Promise<DeploymentRestoreVolumeDestinationV1> {
    const binding = input.render.namedVolumes.find(value => value.volume === capture.target.volume);
    const selected = input.render.review.services.find(value => value.name === capture.target.service);
    if (!binding || !selected?.mounts.some(mount => mount.type === 'volume' && mount.source === binding.volume)) return unsupported();
    const services = restoreServices(input);
    try {
        return await machineNativeEffectAdmission.runStage(input.context, async () => {
            const runningServices: string[] = [], writerServices: string[] = [];
            for (const service of input.render.review.services) {
                const observed = await services.lifecycle(service.name).inspect({ signal: input.context.operation.signal });
                if (observed.phase === 'running') {
                    runningServices.push(service.name);
                    if (service.mounts.some(mount => mount.type === 'volume' && mount.source === binding.volume && !mount.readOnly)) writerServices.push(service.name);
                } else if (observed.phase !== 'stopped') throw new PluginError({ code: 'outcome_unknown', message: 'A volume consumer has unknown native state' });
            }
            const identity = createHash('sha256').update(capture.operationId).digest('base64url');
            return { environmentId: capture.environmentId, revision: capture.revision, ...capture.target,
                currentVolume: binding.physicalName, stagingVolume: `happier_${identity}_stage`,
                hasMeaningfulData: true, writerServices, runningServices };
        });
    } finally { try { await input.project.settleNative(); } finally { await services.dispose(); } }
}

type NativeBackupTarget = Pick<DeploymentRestoreDatabaseDestinationV1, 'service' | 'database'>
    | Pick<DeploymentRestoreSqliteDestinationV1, 'service' | 'path'> | Pick<DeploymentRestoreVolumeDestinationV1, 'service' | 'volume'>;
async function withNativeRestore<T>(input: OwnServerNativeRestoreInput | OwnServerNativeUploadRestoreInput,
    destination: NativeBackupTarget | undefined, effect: (native: NativeRestore) => Promise<T>,
    operation: 'restore' | 'restoreWithSafety' | 'backup' | 'repository' = 'restore', backupTargets: readonly NativeBackupTarget[] = []): Promise<T> {
    const signal = input.context.operation.signal;
    if (!signal) throw new PluginError({ code: 'unsupported_action', message: 'Restore requires its admitted job signal' });
    const attachment = 'execEnv' in input ? await input.execEnv.prepare({ backupDestination: { configKey: 'destination' } }, { signal }) : undefined;
    const services = restoreServices(input);
    const stoppedServices = new Set<string>();
    const volumeProjects: NativeComposeEnvironmentProject[] = [];
    try {
        const access = 'readAccess' in input ? input.readAccess() : undefined;
        const nativeService = services.lifecycle;
        const admitService = services.admit;
        const admitRestic = (request: Extract<DeploymentRestoreNativeRequestV1, { kind: 'restic' }>['request']) => {
            if (!attachment || !input.runtimeImage) return unsupported();
            return input.project.admitResticCommand({ render: input.render, context: input.context,
                runtimeImage: input.runtimeImage, request, destinationAttachment: attachment,
                signal: input.context.operation.signal });
        };
        const sqlite = createNativeSqliteRestore(input, admitRestic);
        const execute = (request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1> =>
            machineNativeEffectAdmission.runStage(input.context, async () => {
                switch (request.kind) {
                    case 'sqliteStage': return sqlite.stageSource(request);
                    case 'sqlite': return sqlite.execute(request);
                    case 'restic': return executeAdmittedServiceCommand(await admitRestic(request.request));
                    case 'service': {
                        const command = await admitService(request.service, request.argv, request.environmentOverrides, request.sensitiveValues);
                        return executeAdmittedServiceCommand(request.stdin === undefined ? command : admitServiceCommandInputForHost({
                            command, source: createBufferTransferPayloadSource(Buffer.from(request.stdin)) }));
                    }
                    case 'volumeArchive': {
                        if (!('upload' in input) || !input.runtimeImage || input.upload.transferId !== request.source.transferId
                            || input.upload.sha256 !== request.source.sha256 || input.upload.sizeBytes !== request.source.sizeBytes) return unsupported();
                        const command = { render: input.render, context: input.context, runtimeImage: input.runtimeImage,
                            archive: { mode: request.mode }, signal };
                        const admitted = request.mode === 'extract'
                            ? await input.project.admitVolumeRestoreCommand({ ...command, physicalName: request.destination.stagingVolume })
                            : await input.project.admitResticCommand(command);
                        return executeAdmittedServiceCommand(admitServiceCommandInputForHost({ command: admitted,
                            source: { kind: 'native', sizeBytes: input.upload.sizeBytes, manifestHash: `sha256:${input.upload.sha256}`,
                                readChunk: input.upload.readChunk } }));
                    }
                    case 'restoreUpload': {
                        if (!('upload' in input) || input.upload.transferId !== request.source.transferId
                            || input.upload.sha256 !== request.source.sha256 || input.upload.sizeBytes !== request.source.sizeBytes) return unsupported();
                        return executeAdmittedServiceCommand(admitServiceCommandInputForHost({
                            command: await admitService(request.consumer.service, request.consumer.argv, request.consumer.environmentOverrides),
                            source: { kind: 'native', sizeBytes: input.upload.sizeBytes, manifestHash: `sha256:${input.upload.sha256}`,
                                readChunk: input.upload.readChunk } }));
                    }
                    case 'restoreStream': return executeAdmittedServiceCommand(admitServiceCommandStreamForHost({
                        producer: await admitRestic(request.producer),
                        consumer: await admitService(request.consumer.service, request.consumer.argv, request.consumer.environmentOverrides),
                    }));
                    case 'integrity': return executeAdmittedServiceCommand(await admitService(request.service, integrityCommand(request.database)));
                    case 'stageVolume': {
                        if (!attachment || !input.runtimeImage) return unsupported();
                        return executeAdmittedServiceCommand(await input.project.admitVolumeRestoreCommand({
                        render: input.render, context: input.context, runtimeImage: input.runtimeImage, request: request.request,
                        physicalName: request.destination.stagingVolume, destinationAttachment: attachment, signal }));
                    }
                    case 'switchVolume': {
                        const bindings = input.render.namedVolumes.map(binding => binding.volume === request.destination.volume
                            ? { volume: binding.volume, physicalName: request.physicalName } : binding);
                        const project = input.project.createVolumeRestoreCandidate(bindings);
                        volumeProjects.push(project);
                        const render = await project.render({ signal });
                        await input.retainSource();
                        const active = await project.activate({ render, context: input.context, signal,
                            runningServices: request.destination.runningServices });
                        await input.onNamedVolumeBindingsChanged?.(bindings);
                        for (const name of request.destination.writerServices) stoppedServices.delete(name);
                        await input.onIncumbentServicesChanged?.([...stoppedServices]);
                        await input.onExpectedDownServicesChanged?.([...stoppedServices]);
                        return { kind: 'health', status: active.health === 'healthy' || !request.destination.runningServices.length
                            ? 'healthy' : 'unknown' };
                    }
                    case 'writers': {
                        if (request.operation === 'stop') await input.onExpectedDownServicesChanged?.(
                            [...new Set([...stoppedServices, ...request.services])]);
                        for (const name of request.services) {
                            const lifecycle = nativeService(name);
                            if (request.operation === 'stop') {
                                const result = await lifecycle.stop({ signal: input.context.operation.signal });
                                if (result.status !== 'stopped') return { kind: 'outcome_unknown' };
                                stoppedServices.add(name);
                            } else {
                                if (!lifecycle.start) return unsupported();
                                const result = await lifecycle.start({ signal: input.context.operation.signal });
                                if (result.phase !== 'running') return { kind: 'outcome_unknown' };
                                stoppedServices.delete(name);
                                await input.onExpectedDownServicesChanged?.([...stoppedServices]);
                            }
                            await input.onIncumbentServicesChanged?.([...stoppedServices]);
                        }
                        return completedControl;
                    }
                    case 'health': {
                        const result = await nativeService(request.service).inspect({ signal: input.context.operation.signal });
                        return { kind: 'health', status: result.phase === 'running' && result.readiness === 'ready' ? 'healthy'
                            : result.phase === 'stopped' || result.phase === 'running' && result.readiness === 'not_ready' ? 'unhealthy' : 'unknown' };
                    }
                }
            });
        const executeBackup: DeploymentBackupRunInputV1['execute'] = (request, source) =>
            machineNativeEffectAdmission.runStage(input.context, async () => {
                if (!attachment || !input.runtimeImage || !access) return unsupported();
                const runtimeImage = input.runtimeImage;
                if (!source) return executeAdmittedServiceCommand(await admitRestic(request));
                if (source.kind === 'volume') {
                    const mounted = input.render.review.services.filter(service => service.mounts.some(mount =>
                        mount.type === 'volume' && mount.source === source.volume));
                    if (!mounted.some(service => service.name === source.service)) return unsupported();
                    const writers: string[] = [];
                    for (const service of mounted) {
                        if (!service.mounts.some(mount => mount.type === 'volume' && mount.source === source.volume && !mount.readOnly)) continue;
                        const observed = await nativeService(service.name).inspect({ signal });
                        if (observed.phase === 'running') writers.push(service.name);
                        else if (observed.phase !== 'stopped') return { kind: 'outcome_unknown' };
                    }
                    // Stop, finite copy and writer recovery share the existing
                    // protected stage so ordinary Stop cannot strand a writer.
                    return machineNativeEffectAdmission.runStage(input.context, async () => {
                        try {
                            const stopped = await execute({ kind: 'writers', operation: 'stop', services: writers });
                            if (stopped.kind !== 'completed' || stopped.exitCode !== 0) return { kind: 'outcome_unknown' };
                            const admitted = await input.project.admitResticCommand({ render: input.render, context: input.context,
                                runtimeImage, request, selector: source, destinationAttachment: attachment, signal });
                            return await executeAdmittedServiceCommand(admitted);
                        } finally {
                            const started = await execute({ kind: 'writers', operation: 'start', services: writers });
                            if (started.kind !== 'completed' || started.exitCode !== 0) throw new PluginError({
                                code: 'outcome_unknown', message: 'The volume backup writer restart did not settle' });
                        }
                    }, { protected: true, onStopPending: input.onStopPending });
                }
                const selected = backupTargets.find(target => target.service === source.service) ?? destination;
                if (!selected || source.service !== selected.service) return unsupported();
                if ('path' in selected) return sqlite.backup(request, selected);
                if (!('database' in selected)) return unsupported();
                return executeAdmittedServiceCommand(admitServiceCommandStreamForHost({
                    producer: await admitService(source.service,
                        ['pg_dump', '-Fc', '--no-owner', '--no-acl', databaseConninfo(selected.database)]),
                    consumer: await admitRestic(request),
                }));
            });
        // Prove tools in the admitted service image, not on the host, before
        // mutations. pg_amcheck requires PostgreSQL 14+. No per-step probes.
        const targets = operation === 'backup' && backupTargets.length ? backupTargets : destination ? [destination] : [];
        for (const target of targets) {
            if (operation === 'repository' || !('database' in target)) continue;
            const tools = operation === 'backup' ? ['pg_dump']
                : ['pg_amcheck', 'psql', 'createdb', 'pg_restore', ...(operation === 'restoreWithSafety' ? ['pg_dump'] : [])];
            for (const tool of tools) {
                const preflight = await execute({ kind: 'service', mode: 'exec', service: target.service, argv: [tool, '--version'] });
                if (preflight.kind !== 'completed') throw new PluginError({ code: 'outcome_unknown', message: 'Native restore tool preflight did not settle' });
                if (preflight.exitCode !== 0) return unsupported();
            }
        }
        return await effect({ access, signal, execute, executeBackup, onBackupSettled: input.onBackupSettled,
            onStep: step => input.operationProgress?.update(deploymentRestoreStepProgressV1(step)),
            runProtectedStage: effect => machineNativeEffectAdmission.runStage(input.context, effect,
                { protected: true, onStopPending: input.onStopPending }) });
    } finally {
        // runProtectedStage joins its children before returning. Native custody
        // also settles before the job returns the one reusable P42 attachment.
        try { await input.project.settleNative(); }
        finally {
            try { for (const project of volumeProjects) await project.dispose(); await services.dispose(); }
            finally { attachment?.dispose(); }
        }
    }
}

/** Repository reads and retention borrow the same attachment/native custody,
 * without requiring a database source or invoking restore preparation. */
export function withOwnServerNativeBackup<T>(input: OwnServerNativeRestoreInput,
    destinations: readonly NativeBackupTarget[] | undefined,
    effect: (native: Pick<NativeRestore, 'signal' | 'executeBackup'> & Readonly<{ access: ResticAccessV1 }>) => Promise<T>): Promise<T> {
    return withNativeRestore(input, undefined, native => effect({ ...native, access: native.access ?? unsupported() }), destinations?.length ? 'backup' : 'repository', destinations);
}

export type OwnServerNativeRestorePrepareCapture = Omit<DeploymentRestorePrepareInputV1,
    'access' | 'signal' | 'execute' | 'safetyBackup'> & Readonly<{
        safetyBackup?: Omit<DeploymentBackupRunInputV1, 'access' | 'signal' | 'execute' | 'preMigrationBackup'>;
    }>;
export type OwnServerNativeUploadRestorePrepareCapture = Omit<OwnServerNativeRestorePrepareCapture, 'source' | 'sourceFormat'>
    & Readonly<{ source: Extract<DeploymentRestorePrepareInputV1['source'], { kind: 'upload' }> }>;

/** The real pg_dump completion retains its non-secret capture through the host's
 * existing Artifact/CAS transition before reporting a verified backup. */
export async function runOwnServerNativePreMigrationBackup(input: OwnServerNativeRestoreInput, capture: Readonly<{
    receipt: OwnServerDeploymentReceipt;
    destination: Pick<DeploymentRestoreDatabaseDestinationV1, 'environmentId' | 'service' | 'adapter' | 'database'>;
    backup: Omit<DeploymentBackupRunInputV1, 'access' | 'signal' | 'execute' | 'preMigrationBackup'>;
    context: ActionExecutorContext;
    /** The capture only ever writes own-server receipt content. */
    writeTransition(request: OwnServerReceiptContentTransition): ReturnType<OwnServerDeploymentTargetHostInput['writeTransition']>;
}>): Promise<Readonly<{ receipt: OwnServerDeploymentReceipt; backup: DeploymentBackupRunResultV1 }>> {
    const ownServer = capture.receipt.content.ownServer;
    if (!ownServer) return unsupported();
    if (capture.receipt.deployment.environmentId !== capture.backup.environmentId
        || capture.destination.environmentId !== capture.backup.environmentId) {
        throw new PluginError({ code: 'stale_input', message: 'The backup receipt belongs to another Environment' });
    }
    return withNativeRestore(input, capture.destination, async native => {
        let receipt = capture.receipt;
        const backup = await runDeploymentBackupV1({ ...capture.backup, access: native.access ?? unsupported(),
            signal: native.signal, execute: native.executeBackup, onSettled: native.onBackupSettled,
            preMigrationBackup: { sourceFormat: 'postgresCustom', target: { service: capture.destination.service,
                adapter: capture.destination.adapter, database: capture.destination.database },
            async writeCapture(preMigrationBackup) {
                const content = { ...receipt.content, ownServer: { ...ownServer, preMigrationBackup } };
                const written = await capture.writeTransition({ environmentId: receipt.deployment.environmentId,
                    deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment,
                    expectedRevision: receipt.deployment.revision, state: receipt.deployment.state,
                    context: capture.context, content });
                if (!written.ok) throw new PluginError({ code: written.errorCode, message: 'The backup capture could not be retained' });
                receipt = { ...receipt, content, deployment: { ...receipt.deployment, revision: written.deploymentRevision } };
            } },
        });
        return { receipt, backup };
    }, 'backup');
}

export type OwnServerNativeRestoreByIdCapture = Omit<OwnServerNativeRestorePrepareCapture, 'source' | 'sourceFormat'> & Readonly<{
    receipt: DeploymentReceiptDetailV1;
    restoreBackupId: string;
    copy?: DeploymentRestoreCopyMappingV1;
}>;

export type OwnServerNativeRestorePrepareReceipt = DeploymentRestorePrepareReceiptV1 & Readonly<{
    repository?: Pick<ResticAccessV1, 'repository' | 's3'>;
}>;

function atRecordedRepository(input: OwnServerNativeRestoreInput,
    repository: NonNullable<OwnServerNativeRestorePrepareReceipt['repository']>): OwnServerNativeRestoreInput {
    return { ...input, readAccess() {
        const { repository: _repository, s3: _s3, ...custody } = input.readAccess();
        return { ...custody, ...repository };
    } };
}

/** Bind the resolved configuration to the host's existing P42 preparation only
 * after ID admission. This factory creates no new credential service. */
export type OwnServerNativeRestoreInputFactory = (capture: DeploymentRestoreResolvedCaptureV1) =>
    OwnServerNativeRestoreInput | Promise<OwnServerNativeRestoreInput>;

async function resolveNativeRestore(factory: OwnServerNativeRestoreInputFactory, admitted: OwnServerNativeRestoreByIdCapture) {
    const resolved = resolveDeploymentRestoreCaptureV1({ environmentId: admitted.destination.environmentId,
        restoreBackupId: admitted.restoreBackupId, receipt: admitted.receipt, destination: admitted.destination,
        ...(admitted.copy ? { copy: admitted.copy } : {}) });
    if (resolved.kind === 'refused') throw new PluginError({ code: resolved.code, message: 'The restore backup capture is unavailable' });
    const capture: OwnServerNativeRestorePrepareCapture = { operationId: admitted.operationId, source: resolved.capture.source,
        sourceFormat: resolved.capture.sourceFormat, destination: resolved.capture.destination, safetyBackup: admitted.safetyBackup };
    return { capture, input: atRecordedRepository(await factory(resolved.capture), resolved.capture.repository) };
}

function restoreOperation(capture: Pick<OwnServerNativeRestorePrepareCapture, 'safetyBackup' | 'destination'>) {
    const safety = capture.safetyBackup;
    if (safety && capture.destination.adapter === 'postgres-v1' && (!safety.data?.some(data => data.logicalBackup?.adapter === 'postgres-v1' && data.service === capture.destination.service))) return unsupported();
    return safety ? 'restoreWithSafety' as const : 'restore' as const;
}

async function prepareNativeRestore(capture: OwnServerNativeRestorePrepareCapture | OwnServerNativeUploadRestorePrepareCapture, native: NativeRestore,
    safetyNative: Pick<NativeRestore, 'access' | 'signal' | 'executeBackup' | 'onBackupSettled'> = native,
    upload?: AdmittedDeploymentRestoreUpload): Promise<OwnServerNativeRestorePrepareReceipt> {
    const safety = capture.safetyBackup;
    const sourceFormat = upload ? await admitOwnServerRestoreUpload({ upload, destination: capture.destination, operationId: capture.operationId,
        signal: native.signal, execute: native.execute }) : 'sourceFormat' in capture ? capture.sourceFormat : unsupported();
    return { ...await prepareDeploymentRestoreV1({ ...capture, ...native, sourceFormat,
        safetyBackup: safety ? { ...safety, access: safetyNative.access ?? unsupported(), signal: safetyNative.signal, execute: safetyNative.executeBackup,
            onSettled: safetyNative.onBackupSettled } : undefined,
    }), ...(native.access ? { repository: { repository: native.access.repository, ...(native.access.s3 ? { s3: native.access.s3 } : {}) } } : {}) };
}

/** Standalone phases own separate P42 preparations; confirmation receives a fresh input. */
export function prepareOwnServerNativeRestore(input: OwnServerNativeUploadRestoreInput,
    admitted: OwnServerNativeUploadRestorePrepareCapture, destinationSafetyInput?: OwnServerNativeRestoreInput):
    Promise<OwnServerNativeRestorePrepareReceipt & Readonly<{ source: DeploymentRestoreUploadSourceV1; sourceFormat: DeploymentRestoreUploadFormatV1 }>>;
export function prepareOwnServerNativeRestore(input: OwnServerNativeRestoreInput | OwnServerNativeUploadRestoreInput,
    admitted: OwnServerNativeRestorePrepareCapture | OwnServerNativeUploadRestorePrepareCapture, destinationSafetyInput?: OwnServerNativeRestoreInput): Promise<OwnServerNativeRestorePrepareReceipt>;
export function prepareOwnServerNativeRestore(input: OwnServerNativeRestoreInputFactory,
    admitted: OwnServerNativeRestoreByIdCapture, destinationSafetyInput?: OwnServerNativeRestoreInput): Promise<OwnServerNativeRestorePrepareReceipt>;
export async function prepareOwnServerNativeRestore(input: OwnServerNativeRestoreInput | OwnServerNativeUploadRestoreInput | OwnServerNativeRestoreInputFactory,
    admitted: OwnServerNativeRestorePrepareCapture | OwnServerNativeUploadRestorePrepareCapture | OwnServerNativeRestoreByIdCapture,
    destinationSafetyInput?: OwnServerNativeRestoreInput): Promise<OwnServerNativeRestorePrepareReceipt> {
    let capture: OwnServerNativeRestorePrepareCapture | OwnServerNativeUploadRestorePrepareCapture;
    let nativeInput: OwnServerNativeRestoreInput | OwnServerNativeUploadRestoreInput;
    if (typeof input === 'function') {
        // The overload pairs the host factory with ID-only admission.
        const resolved = await resolveNativeRestore(input, admitted as OwnServerNativeRestoreByIdCapture);
        capture = resolved.capture;
        nativeInput = resolved.input;
    } else {
        capture = admitted as OwnServerNativeRestorePrepareCapture | OwnServerNativeUploadRestorePrepareCapture;
        nativeInput = input;
    }
    const operation = restoreOperation(capture);
    // A copy reads the source repository but protects an incumbent destination
    // through that destination's own backup credentials and native service.
    const safetyBackup = capture.safetyBackup;
    if (safetyBackup && destinationSafetyInput) return withNativeRestore(nativeInput, capture.destination,
        native => withOwnServerNativeBackup(destinationSafetyInput, safetyBackup.restoreTargets ?? [capture.destination],
            safetyNative => prepareNativeRestore(capture, native, safetyNative, 'upload' in nativeInput ? nativeInput.upload : undefined)), 'restore');
    return withNativeRestore(nativeInput, capture.destination,
        native => prepareNativeRestore(capture, native, native, 'upload' in nativeInput ? nativeInput.upload : undefined), operation, capture.safetyBackup?.restoreTargets);
}

export function confirmOwnServerNativeRestore(input: OwnServerNativeRestoreInput | OwnServerNativeUploadRestoreInput,
    capture: Omit<DeploymentRestoreConfirmInputV1, 'access' | 'signal' | 'execute' | 'runProtectedStage' | 'prepare'>
        & Readonly<{ prepare: OwnServerNativeRestorePrepareReceipt }>): Promise<DeploymentRestoreResultV1> {
    return withNativeRestore('upload' in input ? input : atRecordedRepository(input, capture.prepare.repository ?? unsupported()), capture.destination,
        native => confirmDeploymentRestoreV1({ ...capture, ...native }));
}

/** One ID admission and one retained P42 group span both native phases. */
export async function executeOwnServerNativeRestore(factory: OwnServerNativeRestoreInputFactory,
    capture: OwnServerNativeRestoreByIdCapture): Promise<Extract<DeploymentRestoreResultV1, { kind: 'restored' }>> {
    const resolved = await resolveNativeRestore(factory, capture);
    const operation = restoreOperation(resolved.capture);
    const result = await withNativeRestore(resolved.input, resolved.capture.destination, async native => {
        const prepare = await prepareNativeRestore(resolved.capture, native);
        return confirmDeploymentRestoreV1({ prepare, source: prepare.source,
            sourceFormat: prepare.sourceFormat, destination: prepare.destination, ...native });
    }, operation);
    if (result.kind !== 'restored' || result.verified !== true) {
        throw new PluginError({ code: result.kind === 'outcome_unknown' ? 'outcome_unknown' : result.code ?? 'restore_failed',
            message: 'Native database recovery did not verify restoration',
            details: { kind: result.kind, nextAction: result.nextAction, ...(result.steps ? { steps: result.steps } : {}),
                ...(result.nativeFailure ? { nativeFailure: result.nativeFailure } : {}) } });
    }
    return result;
}
