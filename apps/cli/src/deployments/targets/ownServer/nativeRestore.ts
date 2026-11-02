import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createHash } from 'node:crypto';
import type { DeploymentExecEnvPortV1 } from '@happier-dev/plugin-sdk/exec';
import type { DeploymentImageV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { prepareDeploymentRestoreV1, confirmDeploymentRestoreV1, runDeploymentBackupV1, resolveDeploymentRestoreCaptureV1,
    type DeploymentRestorePrepareInputV1, type DeploymentRestoreConfirmInputV1,
    type DeploymentRestorePrepareReceiptV1, type DeploymentRestoreResultV1,
    type DeploymentRestoreNativeRequestV1, type DeploymentRestoreNativeResultV1,
    type DeploymentBackupRunInputV1, type DeploymentBackupRunResultV1, type DeploymentRestoreResolvedCaptureV1,
    type ResticAccessV1, type DeploymentRestoreDestinationV1 } from '@happier-dev/deployments';
import type { OwnServerDeploymentReceipt, OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { createNativeComposeLifecycle, executeAdmittedServiceCommand, admitServiceCommandStreamForHost,
    type NativeComposeEnvironmentProject, type NativeComposeProjectRender,
    type NativeComposeActivatedProject, type NativeComposeObservationIo } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { machineNativeEffectAdmission, type MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

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
    onStopPending(status: 'stop_pending'): void;
}>;

type NativeRestore = Readonly<{
    access: ResticAccessV1;
    signal: AbortSignal;
    execute(request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1>;
    executeBackup: DeploymentBackupRunInputV1['execute'];
    runProtectedStage<T>(effect: () => Promise<T>): Promise<T>;
}>;
const unsupported = (): never => { throw new PluginError({ code: 'unsupported_action',
    message: 'The admitted PostgreSQL restore tools are unavailable' }); };
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

type NativeRestoreServiceInput = Pick<OwnServerNativeRestoreInput, 'project' | 'activation' | 'io' | 'render' | 'context'>;
function restoreServices(input: NativeRestoreServiceInput) {
    const services = new Map<string, Readonly<{ native: ReturnType<typeof createNativeComposeLifecycle>; release(): Promise<void> }>>();
    const lifecycle = (name: string) => {
        const existing = services.get(name);
        if (existing) return existing.native.lifecycle;
        const native = createNativeComposeLifecycle({ args: input.activation.composeArgs, io: input.io,
            retainLaunch: () => input.activation.authorizeServiceObserver(), engineId: input.render.engineId,
            environment: { composeService: name, containerIds: input.activation.nativeIdsForService(name),
                facts: input.activation.nativeFactsForService(name) } });
        const launch = input.activation.authorizeServiceObserver();
        services.set(name, { native, release: () => Promise.resolve(launch.release()) });
        native.bindLaunch(launch);
        return native.lifecycle;
    };
    return { lifecycle,
        async admit(name: string, argv: readonly string[]) {
            const service = lifecycle(name);
            if (!service.admitServiceCommand) return unsupported();
            return service.admitServiceCommand({ mode: 'exec', argv }, { context: input.context,
                keys: input.render.keys, signal: input.context.operation.signal, async assertCurrent() {
                    if (!input.activation.isCurrent()) throw new PluginError({ code: 'deployment_generation_required',
                        message: 'The admitted restore generation is unavailable' });
                } });
        },
        async dispose() { await Promise.all([...services.values()].map(service => service.release())); },
    };
}

/** Native destination observation precedes backup credential acquisition. */
export async function observeOwnServerNativeRestoreDestination(input: NativeRestoreServiceInput,
    capture: Readonly<{ operationId: string; environmentId: string; revision: number;
        target: Pick<DeploymentRestoreDestinationV1, 'service' | 'adapter' | 'database'> }>): Promise<DeploymentRestoreDestinationV1> {
    const services = restoreServices(input);
    try {
        return await machineNativeEffectAdmission.runStage(input.context, async () => {
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

async function withNativeRestore<T>(input: OwnServerNativeRestoreInput,
    destination: Pick<DeploymentRestorePrepareInputV1['destination'], 'service' | 'database'>, effect: (native: NativeRestore) => Promise<T>,
    operation: 'restore' | 'restoreWithSafety' | 'backup' = 'restore'): Promise<T> {
    const signal = input.context.operation.signal;
    if (!signal) throw new PluginError({ code: 'unsupported_action', message: 'Restore requires its admitted job signal' });
    const attachment = await input.execEnv.prepare({ backupDestination: { configKey: 'destination' } }, { signal });
    const services = restoreServices(input);
    try {
        const access = input.readAccess();
        const nativeService = services.lifecycle;
        const admitService = services.admit;
        const admitRestic = (request: Extract<DeploymentRestoreNativeRequestV1, { kind: 'restic' }>['request']) =>
            input.project.admitResticCommand({ render: input.render, context: input.context,
                runtimeImage: input.runtimeImage, request, destinationAttachment: attachment,
                signal: input.context.operation.signal });
        const execute = (request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1> =>
            machineNativeEffectAdmission.runStage(input.context, async () => {
                switch (request.kind) {
                    case 'restic': return executeAdmittedServiceCommand(await admitRestic(request.request));
                    case 'service': return executeAdmittedServiceCommand(await admitService(request.service, request.argv));
                    case 'restoreStream': return executeAdmittedServiceCommand(admitServiceCommandStreamForHost({
                        producer: await admitRestic(request.producer),
                        consumer: await admitService(request.consumer.service, request.consumer.argv),
                    }));
                    case 'integrity': return executeAdmittedServiceCommand(await admitService(request.service, integrityCommand(request.database)));
                    case 'writers': {
                        for (const name of request.services) {
                            const lifecycle = nativeService(name);
                            if (request.operation === 'stop') {
                                const result = await lifecycle.stop({ signal: input.context.operation.signal });
                                if (result.status !== 'stopped') return { kind: 'outcome_unknown' };
                            } else {
                                if (!lifecycle.start) return unsupported();
                                const result = await lifecycle.start({ signal: input.context.operation.signal });
                                if (result.phase !== 'running') return { kind: 'outcome_unknown' };
                            }
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
                if (!source) return executeAdmittedServiceCommand(await admitRestic(request));
                // This restore adapter supports only its captured PostgreSQL DB.
                // The backup parent owns source recipes, evidence and read-back.
                if (source.kind !== 'dump' || source.service !== destination.service) return unsupported();
                return executeAdmittedServiceCommand(admitServiceCommandStreamForHost({
                    producer: await admitService(source.service,
                        ['pg_dump', '-Fc', '--no-owner', '--no-acl', databaseConninfo(destination.database)]),
                    consumer: await admitRestic(request),
                }));
            });
        // Prove tools in the admitted service image, not on the host, before
        // mutations. pg_amcheck requires PostgreSQL 14+. No per-step probes.
        const tools = operation === 'backup' ? ['pg_dump']
            : ['pg_amcheck', 'psql', 'createdb', 'pg_restore', ...(operation === 'restoreWithSafety' ? ['pg_dump'] : [])];
        for (const tool of tools) {
            const preflight = await execute({ kind: 'service', mode: 'exec', service: destination.service, argv: [tool, '--version'] });
            if (preflight.kind !== 'completed') throw new PluginError({ code: 'outcome_unknown', message: 'Native restore tool preflight did not settle' });
            if (preflight.exitCode !== 0) return unsupported();
        }
        return await effect({ access, signal, execute, executeBackup,
            runProtectedStage: effect => machineNativeEffectAdmission.runStage(input.context, effect,
                { protected: true, onStopPending: input.onStopPending }) });
    } finally {
        // runProtectedStage joins its children before returning. Native custody
        // also settles before the job returns the one reusable P42 attachment.
        try { await input.project.settleNative(); }
        finally {
            try { await services.dispose(); }
            finally { attachment.dispose(); }
        }
    }
}

export type OwnServerNativeRestorePrepareCapture = Omit<DeploymentRestorePrepareInputV1,
    'access' | 'signal' | 'execute' | 'safetyBackup'> & Readonly<{
        safetyBackup?: Omit<DeploymentBackupRunInputV1, 'access' | 'signal' | 'execute' | 'preMigrationBackup'>;
    }>;

/** The real pg_dump completion retains its non-secret capture through the host's
 * existing Artifact/CAS transition before reporting a verified backup. */
export async function runOwnServerNativePreMigrationBackup(input: OwnServerNativeRestoreInput, capture: Readonly<{
    receipt: OwnServerDeploymentReceipt;
    destination: Pick<DeploymentRestorePrepareInputV1['destination'], 'environmentId' | 'service' | 'adapter' | 'database'>;
    backup: Omit<DeploymentBackupRunInputV1, 'access' | 'signal' | 'execute' | 'preMigrationBackup'>;
    context: ActionExecutorContext;
    writeTransition: OwnServerDeploymentTargetHostInput['writeTransition'];
}>): Promise<Readonly<{ receipt: OwnServerDeploymentReceipt; backup: DeploymentBackupRunResultV1 }>> {
    const ownServer = capture.receipt.content.ownServer;
    if (!ownServer) return unsupported();
    if (capture.receipt.deployment.environmentId !== capture.backup.environmentId
        || capture.destination.environmentId !== capture.backup.environmentId) {
        throw new PluginError({ code: 'stale_input', message: 'The backup receipt belongs to another Environment' });
    }
    return withNativeRestore(input, capture.destination, async native => {
        let receipt = capture.receipt;
        const backup = await runDeploymentBackupV1({ ...capture.backup, access: native.access,
            signal: native.signal, execute: native.executeBackup,
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
}>;

export type OwnServerNativeRestorePrepareReceipt = DeploymentRestorePrepareReceiptV1 & Readonly<{
    repository: Pick<ResticAccessV1, 'repository' | 's3'>;
}>;

function atRecordedRepository(input: OwnServerNativeRestoreInput,
    repository: OwnServerNativeRestorePrepareReceipt['repository']): OwnServerNativeRestoreInput {
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
        restoreBackupId: admitted.restoreBackupId, receipt: admitted.receipt, destination: admitted.destination });
    if (resolved.kind === 'refused') throw new PluginError({ code: resolved.code, message: 'The restore backup capture is unavailable' });
    const capture: OwnServerNativeRestorePrepareCapture = { operationId: admitted.operationId, source: resolved.capture.source,
        sourceFormat: resolved.capture.sourceFormat, destination: resolved.capture.destination, safetyBackup: admitted.safetyBackup };
    return { capture, input: atRecordedRepository(await factory(resolved.capture), resolved.capture.repository) };
}

function restoreOperation(capture: OwnServerNativeRestorePrepareCapture) {
    const safety = capture.safetyBackup;
    if (safety && (safety.data?.logicalBackup?.adapter !== 'postgres-v1'
        || safety.data.service !== capture.destination.service)) return unsupported();
    return safety ? 'restoreWithSafety' as const : 'restore' as const;
}

async function prepareNativeRestore(capture: OwnServerNativeRestorePrepareCapture, native: NativeRestore): Promise<OwnServerNativeRestorePrepareReceipt> {
    const safety = capture.safetyBackup;
    return { ...await prepareDeploymentRestoreV1({ ...capture, ...native,
        safetyBackup: safety ? { ...safety, access: native.access, signal: native.signal, execute: native.executeBackup } : undefined,
    }), repository: { repository: native.access.repository, ...(native.access.s3 ? { s3: native.access.s3 } : {}) } };
}

/** Standalone phases own separate P42 preparations; confirmation receives a fresh input. */
export function prepareOwnServerNativeRestore(input: OwnServerNativeRestoreInput,
    admitted: OwnServerNativeRestorePrepareCapture): Promise<OwnServerNativeRestorePrepareReceipt>;
export function prepareOwnServerNativeRestore(input: OwnServerNativeRestoreInputFactory,
    admitted: OwnServerNativeRestoreByIdCapture): Promise<OwnServerNativeRestorePrepareReceipt>;
export async function prepareOwnServerNativeRestore(input: OwnServerNativeRestoreInput | OwnServerNativeRestoreInputFactory,
    admitted: OwnServerNativeRestorePrepareCapture | OwnServerNativeRestoreByIdCapture): Promise<OwnServerNativeRestorePrepareReceipt> {
    let capture: OwnServerNativeRestorePrepareCapture;
    let nativeInput: OwnServerNativeRestoreInput;
    if (typeof input === 'function') {
        // The overload pairs the host factory with ID-only admission.
        const resolved = await resolveNativeRestore(input, admitted as OwnServerNativeRestoreByIdCapture);
        capture = resolved.capture;
        nativeInput = resolved.input;
    } else {
        capture = admitted as OwnServerNativeRestorePrepareCapture;
        nativeInput = input;
    }
    const operation = restoreOperation(capture);
    return withNativeRestore(nativeInput, capture.destination, native => prepareNativeRestore(capture, native), operation);
}

export function confirmOwnServerNativeRestore(input: OwnServerNativeRestoreInput,
    capture: Omit<DeploymentRestoreConfirmInputV1, 'access' | 'signal' | 'execute' | 'runProtectedStage' | 'prepare'>
        & Readonly<{ prepare: OwnServerNativeRestorePrepareReceipt }>): Promise<DeploymentRestoreResultV1> {
    return withNativeRestore(atRecordedRepository(input, capture.prepare.repository), capture.destination,
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
        throw new PluginError({ code: result.code ?? 'restore_failed', message: 'Native database recovery did not verify restoration',
            details: { kind: result.kind, nextAction: result.nextAction } });
    }
    return result;
}
