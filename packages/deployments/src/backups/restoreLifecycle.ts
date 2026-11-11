import { readDeploymentBackupMaintenanceFailureEvidenceV1, type DeploymentBackupNativeFailureV1,
    type DeploymentRestoreStepV1, type DeploymentBackupManifestV1, type DeploymentRestoreUploadSourceV1, type DeploymentRestoreUploadFormatV1 } from '@happier-dev/deployment-protocol';
export { deploymentRestoreStepProgressV1, readDeploymentRestoreStepProgressV1 } from '@happier-dev/deployment-protocol';

import { runDeploymentBackupV1, type DeploymentBackupNativeResultV1, type DeploymentBackupRunInputV1,
    type DeploymentBackupRunResultV1 } from '../actions/backups.js';
import { readResticNativeJsonV1 } from './manifestV1.js';
import { readBackupNativeFailureEvidenceV1, verifyDeploymentBackupV1 } from './verificationV1.js';
import { buildResticRequestV1, type ResticAccessV1, type ResticRequestV1 } from './resticExecutor.js';

/** Exact native identities and supported tools are captured by P41/P30 at admission.
 * Staging/recovery names belong to this operation, not a caller-selected live database. */
export type DeploymentRestoreDatabaseDestinationV1 = Readonly<{
    environmentId: string; revision: number; service: string; adapter: 'postgres-v1';
    database: string; stagingDatabase: string; recoveryDatabase: string;
    databaseExists: boolean; hasMeaningfulData: boolean;
    /** Exact admitted writers to stop/resume; excludes deliberately stopped services. */
    writerServices: readonly string[];
}>;
export type DeploymentRestoreVolumeDestinationV1 = Readonly<{
    environmentId: string; revision: number; service: string; adapter: 'volume-v1';
    volume: string; currentVolume: string; stagingVolume: string; hasMeaningfulData: boolean;
    writerServices: readonly string[]; runningServices: readonly string[];
}>;
export type DeploymentRestoreSqliteDestinationV1 = Readonly<{
    environmentId: string; revision: number; service: string; adapter: 'sqlite-v1'; path: string;
    stagingVolume: string; hasMeaningfulData: boolean; writerServices: readonly string[];
}>;
export type DeploymentRestoreDestinationV1 = DeploymentRestoreDatabaseDestinationV1 | DeploymentRestoreVolumeDestinationV1 | DeploymentRestoreSqliteDestinationV1;
/** These requests describe native IO, not lifecycle callbacks. P30 owns process,
 * stream checksum/EOF, cancellation and settlement; P41 owns exact service control,
 * supported engine integrity checks and service/app health. No adapter is supplied
 * by default: registration must remain unavailable until these real producers exist. */
export type DeploymentRestoreNativeRequestV1 =
    | Readonly<{ kind: 'restic'; request: ResticRequestV1 }>
    | Readonly<{ kind: 'service'; mode: 'exec'; service: string; argv: readonly string[]; stdin?: string;
        environmentOverrides?: Readonly<Record<string, string>>; sensitiveValues?: readonly string[] }>
    | Readonly<{ kind: 'restoreStream'; producer: ResticRequestV1;
        consumer: Readonly<{ mode: 'exec'; service: string; argv: readonly string[]; environmentOverrides?: Readonly<Record<string, string>> }> }>
    | Readonly<{ kind: 'restoreUpload'; source: DeploymentRestoreUploadSourceV1;
        consumer: Readonly<{ mode: 'exec'; service: string; argv: readonly string[]; environmentOverrides: Readonly<Record<string, string>> }> }>
    | Readonly<{ kind: 'writers'; operation: 'stop' | 'start'; services: readonly string[] }>
    | Readonly<{ kind: 'integrity'; service: string; database: string }>
    | Readonly<{ kind: 'stageVolume'; destination: DeploymentRestoreVolumeDestinationV1; request: ResticRequestV1 }>
    | Readonly<{ kind: 'volumeArchive'; mode: 'list'; source: DeploymentRestoreUploadSourceV1 }>
    | Readonly<{ kind: 'volumeArchive'; mode: 'extract'; source: DeploymentRestoreUploadSourceV1; destination: DeploymentRestoreVolumeDestinationV1 }>
    | Readonly<{ kind: 'switchVolume'; destination: DeploymentRestoreVolumeDestinationV1; physicalName: string }>
    | Readonly<{ kind: 'sqliteStage'; destination: DeploymentRestoreSqliteDestinationV1;
        source: DeploymentBackupManifestV1 | DeploymentRestoreUploadSourceV1; operationId: string }>
    | Readonly<{ kind: 'sqlite'; operation: 'admitStage' | 'snapshotRecovery' | 'activate' | 'recover';
        destination: DeploymentRestoreSqliteDestinationV1; operationId: string }>
    | Readonly<{ kind: 'health'; service: string }>;
export type DeploymentRestoreNativeResultV1 = Readonly<{ kind: 'outcome_unknown' }>
    | (Omit<Extract<DeploymentBackupNativeResultV1, { kind: 'completed' }>, 'producer'> & Readonly<{
        producer?: Readonly<{ exitCode: number; checksumSha256: string; bytes: number }>;
    }>)
    | Readonly<{ kind: 'health'; status: 'healthy' | 'unhealthy' | 'unknown' }>;
type NativeExecute = (request: DeploymentRestoreNativeRequestV1) => Promise<DeploymentRestoreNativeResultV1>;
type RestoreCapture = Readonly<{
    source: DeploymentBackupManifestV1 | DeploymentRestoreUploadSourceV1; destination: DeploymentRestoreDestinationV1;
    /** Captured by the source/tool preflight; a dump manifest alone does not prove format. */
    sourceFormat: 'volume' | DeploymentRestoreUploadFormatV1;
    access?: ResticAccessV1; signal: AbortSignal; execute: NativeExecute;
    /** The existing Action operation pushes these closed native step facts. */
    onStep?(step: DeploymentRestoreStepV1): void;
}>;
export type DeploymentRestorePrepareInputV1 = RestoreCapture & Readonly<{
    operationId: string; safetyBackup?: DeploymentBackupRunInputV1;
}>;
/** Stored in the existing prepare Action receipt. No prepared-token/state store. */
export type DeploymentRestorePrepareReceiptV1 = Readonly<{
    kind: 'prepared'; operationId: string; source: RestoreCapture['source'];
    sourceFormat: RestoreCapture['sourceFormat']; destination: DeploymentRestoreDestinationV1; safetyBackup?: DeploymentBackupRunResultV1;
    steps?: readonly DeploymentRestoreStepV1[];
}>;
export type DeploymentRestoreConfirmInputV1 = RestoreCapture & Readonly<{
    prepare: DeploymentRestorePrepareReceiptV1;
    /** The host's ONE native protected stage, under the same admitted context.
     * signal/execute already use that owner's forwarded job signal. */
    runProtectedStage<T>(effect: () => Promise<T>): Promise<T>;
}>;
type RestoreFailureCode = 'backup_required' | 'backup_failed' | 'backup_integrity_failed' | 'restore_failed'
    | 'stale_input' | 'cancelled' | 'outcome_unknown' | 'unsupported_action';
export type DeploymentRestoreResultV1 = Readonly<{
    source: DeploymentBackupManifestV1 | DeploymentRestoreUploadSourceV1; destination: DeploymentRestoreDestinationV1;
    safetyBackup?: DeploymentBackupRunResultV1; code?: RestoreFailureCode; nativeFailure?: DeploymentBackupNativeFailureV1;
    steps?: readonly DeploymentRestoreStepV1[];
}> & (Readonly<{ kind: 'restored'; verified: true; nextAction: 'none' }>
    | Readonly<{ kind: 'rolledBack' | 'outcome_unknown' | 'recoveryRequired'; verified: false;
        nextAction: 'none' | 'inspectStagingDatabase' | 'observeDatabaseNames' | 'restoreRecoveryDatabase' | 'checkServiceHealth'
            | 'inspectStagingVolume' | 'restorePreviousVolume' }>);

function refuse(code: RestoreFailureCode): never { throw Object.assign(new Error(code), { code }); }
function codeOf(error: unknown): RestoreFailureCode {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = error.code;
        if (code === 'backup_required' || code === 'backup_failed' || code === 'backup_integrity_failed' || code === 'restore_failed'
            || code === 'stale_input' || code === 'cancelled' || code === 'unsupported_action') return code;
    }
    return 'outcome_unknown';
}
function cancelled(signal: AbortSignal) { if (signal.aborted) refuse('cancelled'); }

function restoreSteps(input: Pick<RestoreCapture, 'onStep'>, previous: readonly DeploymentRestoreStepV1[] = []) {
    let steps = [...previous];
    const record = (id: DeploymentRestoreStepV1['id'], status: DeploymentRestoreStepV1['status']) => {
        const step = { id, status };
        const index = steps.findIndex(item => item.id === id);
        if (index < 0) steps = [...steps, step];
        else steps = steps.map((item, at) => at === index ? step : item);
        input.onStep?.(step);
    };
    return { record, snapshot: () => steps,
        failRunning() { for (const step of steps) if (step.status === 'running') record(step.id, 'failed'); },
        async run<T>(id: DeploymentRestoreStepV1['id'], effect: () => Promise<T>) {
            record(id, 'running');
            try { const value = await effect(); record(id, 'completed'); return value; }
            catch (error) { record(id, 'failed'); throw error; }
        },
    };
}
function completed(result: DeploymentRestoreNativeResultV1) {
    if (result.kind !== 'completed') return refuse('outcome_unknown');
    if (result.exitCode !== 0) throw Object.assign(new Error('restore_failed'), { code: 'restore_failed',
        details: readBackupNativeFailureEvidenceV1(result) });
    return result;
}
function identifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function service(destination: DeploymentRestoreDatabaseDestinationV1, argv: readonly string[]): DeploymentRestoreNativeRequestV1 {
    return { kind: 'service', service: destination.service, mode: 'exec', argv };
}
function sql(destination: DeploymentRestoreDatabaseDestinationV1, statement: string) {
    return service(destination, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '--dbname=postgres', '-At', '-c', statement]);
}
function rename(destination: DeploymentRestoreDatabaseDestinationV1, from: string, to: string) {
    return sql(destination, `ALTER DATABASE ${identifier(from)} RENAME TO ${identifier(to)}`);
}
function sameMembers(left: readonly string[], right: readonly string[]) {
    const leftSet = new Set(left), rightSet = new Set(right);
    return leftSet.size === rightSet.size && [...leftSet].every(member => rightSet.has(member));
}
function sameSource(left: RestoreCapture['source'], right: RestoreCapture['source']) {
    if (left.kind === 'upload' || right.kind === 'upload') return left.kind === 'upload' && right.kind === 'upload'
        && left.transferId === right.transferId && left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
    return left.environmentId === right.environmentId && left.sourceId === right.sourceId && left.kind === right.kind
        && left.configRevision === right.configRevision && left.repositoryId === right.repositoryId
        && left.snapshot.snapshotId === right.snapshot.snapshotId && left.snapshot.treeId === right.snapshot.treeId
        && left.snapshot.hostname === right.snapshot.hostname && left.snapshot.time === right.snapshot.time
        && sameMembers(left.snapshot.tags, right.snapshot.tags)
        && left.producerChecksumSha256 === right.producerChecksumSha256 && left.totalBytesProcessed === right.totalBytesProcessed
        && left.totalFilesProcessed === right.totalFilesProcessed && left.snapshot.paths.length === right.snapshot.paths.length
        && left.snapshot.paths.every((path, index) => path === right.snapshot.paths[index]);
}
function sameDestination(left: DeploymentRestoreDestinationV1, right: DeploymentRestoreDestinationV1) {
    if (left.adapter === 'sqlite-v1' || right.adapter === 'sqlite-v1') {
        return left.adapter === 'sqlite-v1' && right.adapter === 'sqlite-v1'
            && left.environmentId === right.environmentId && left.revision === right.revision && left.service === right.service
            && left.path === right.path && left.stagingVolume === right.stagingVolume
            && left.hasMeaningfulData === right.hasMeaningfulData && sameMembers(left.writerServices, right.writerServices);
    }
    if (left.adapter === 'volume-v1' || right.adapter === 'volume-v1') {
        return left.adapter === 'volume-v1' && right.adapter === 'volume-v1'
            && left.environmentId === right.environmentId && left.revision === right.revision && left.service === right.service
            && left.volume === right.volume && left.currentVolume === right.currentVolume && left.stagingVolume === right.stagingVolume
            && left.hasMeaningfulData === right.hasMeaningfulData && sameMembers(left.writerServices, right.writerServices)
            && sameMembers(left.runningServices, right.runningServices);
    }
    return left.environmentId === right.environmentId && left.revision === right.revision && left.service === right.service
        && left.adapter === right.adapter && left.database === right.database && left.stagingDatabase === right.stagingDatabase
        && left.recoveryDatabase === right.recoveryDatabase && left.databaseExists === right.databaseExists
        && left.hasMeaningfulData === right.hasMeaningfulData && sameMembers(left.writerServices, right.writerServices);
}

/** Read exact native evidence from the selected repository, never "latest".
 * The host already admitted the source manifest; native repository bytes remain
 * an external boundary and must agree with that owned receipt. */
async function verifySource(input: RestoreCapture) {
    const source = input.source;
    if (source.kind === 'upload') return undefined;
    if (!input.access) return refuse('backup_required');
    await verifyDeploymentBackupV1({ environmentId: source.environmentId, configRevision: source.configRevision,
        manifest: source, access: input.access, signal: input.signal, level: 'manifestReadBack', execute: async request => {
            const result = await input.execute({ kind: 'restic', request });
            if (result.kind !== 'completed') return refuse('outcome_unknown');
            return result;
        } });
    return source.snapshot.paths[0]!;
}

export async function prepareDeploymentRestoreV1(input: DeploymentRestorePrepareInputV1): Promise<DeploymentRestorePrepareReceiptV1> {
    const steps = restoreSteps(input);
    steps.record('safety', 'running');
    try {
        cancelled(input.signal);
        // Unsupported formats/engines are explicit; custom PostgreSQL archives alone
        // have a staged semantic producer here. Upload admission remains transfer-owned.
        const { destination } = input;
        if (destination.adapter === 'sqlite-v1') {
            if (input.sourceFormat !== 'sqlite' || input.source.kind !== 'upload' && input.source.kind !== 'dump') refuse('unsupported_action');
            if (destination.hasMeaningfulData && (!input.safetyBackup || input.safetyBackup.environmentId !== destination.environmentId
                || !input.safetyBackup.configuration.sources.some(source => source.kind === 'dump' && source.service === destination.service))) refuse('backup_required');
        } else if (destination.adapter === 'volume-v1') {
            if (input.source.kind === 'upload' ? input.sourceFormat !== 'volumeTar'
                : input.source.kind !== 'volume' || input.sourceFormat !== 'volume') refuse('unsupported_action');
            if (destination.currentVolume === destination.stagingVolume) refuse('stale_input');
            if (destination.hasMeaningfulData && (!input.safetyBackup || input.safetyBackup.environmentId !== destination.environmentId
                || !input.safetyBackup.configuration.sources.some(source => source.kind === 'volume'
                    && source.service === destination.service && source.volume === destination.volume))) refuse('backup_required');
        } else {
        if (destination.adapter !== 'postgres-v1' || (input.source.kind === 'upload'
            ? input.sourceFormat !== 'postgresCustom' && input.sourceFormat !== 'postgresSql'
            : input.source.kind !== 'dump' || input.sourceFormat !== 'postgresCustom')) refuse('unsupported_action');
        if (new Set([destination.database, destination.stagingDatabase, destination.recoveryDatabase]).size !== 3) refuse('stale_input');
        if (destination.hasMeaningfulData && (!input.safetyBackup || input.safetyBackup.environmentId !== destination.environmentId
            || !input.safetyBackup.configuration.sources.some(source => source.kind === 'dump' && source.service === destination.service))) refuse('backup_required');
        }
        await verifySource(input);
        if (destination.adapter === 'sqlite-v1' && input.source.kind !== 'upload') await steps.run('integrity', async () =>
            completed(await input.execute({ kind: 'sqliteStage', destination, source: input.source, operationId: input.operationId })));
        const safetyBackup = destination.hasMeaningfulData && input.safetyBackup
            ? await runDeploymentBackupV1({ ...input.safetyBackup, signal: input.signal }) : undefined;
        steps.record('safety', safetyBackup ? 'completed' : 'skipped');
        return { kind: 'prepared', operationId: input.operationId, source: input.source, sourceFormat: input.sourceFormat, destination,
            ...(safetyBackup ? { safetyBackup } : {}), steps: steps.snapshot() };
    } catch (error) {
        steps.failRunning();
        // Keep the child backup's exact recovery evidence alongside its failed phase.
        const details = error && typeof error === 'object' && 'details' in error && error.details
            && typeof error.details === 'object' ? error.details : {};
        throw Object.assign(error instanceof Error ? error : new Error(codeOf(error)), {
            details: { ...details, steps: steps.snapshot() },
        });
    }
}

/** Invoked inside a fresh host admission. Source/target authority, target revision
 * CAS and credential acquisition are the host owners' work, once at that boundary.
 * This exact receipt comparison prevents substitution; it is not a phase authority loop. */
export async function confirmDeploymentRestoreV1(input: DeploymentRestoreConfirmInputV1): Promise<DeploymentRestoreResultV1> {
    const { destination, prepare } = input;
    const steps = restoreSteps(input, prepare.steps);
    if (!sameSource(input.source, prepare.source) || input.sourceFormat !== prepare.sourceFormat
        || !sameDestination(destination, prepare.destination)) refuse('stale_input');
    if (destination.hasMeaningfulData && !prepare.safetyBackup) refuse('backup_required');
    const result = (kind: DeploymentRestoreResultV1['kind'], nextAction: DeploymentRestoreResultV1['nextAction'],
        code?: RestoreFailureCode, error?: unknown): DeploymentRestoreResultV1 => {
        const nativeFailure = readDeploymentBackupMaintenanceFailureEvidenceV1(error)?.nativeFailure;
        const evidence = { source: prepare.source, destination, steps: steps.snapshot(),
            ...(nativeFailure ? { nativeFailure } : {}),
            ...(prepare.safetyBackup ? { safetyBackup: prepare.safetyBackup } : {}), ...(code ? { code } : {}) };
        return kind === 'restored' ? { ...evidence, kind, verified: true, nextAction: 'none' }
            : { ...evidence, kind, verified: false, nextAction };
    };
    const execute = async (request: DeploymentRestoreNativeRequestV1) => {
        cancelled(input.signal);
        return input.execute(request);
    };
    if (destination.adapter === 'sqlite-v1') {
        completed(await execute({ kind: 'sqlite', operation: 'admitStage', destination, operationId: prepare.operationId }));
        return input.runProtectedStage(async () => {
            let writersStopped = false;
            let recoveryReady = false;
            let activationAttempted = false;
            const control = async (operation: 'stop' | 'start') => {
                if (!destination.writerServices.length) { steps.record(operation, 'skipped'); return; }
                if (operation === 'stop') writersStopped = true;
                await steps.run(operation, async () => completed(await execute({ kind: 'writers', operation,
                    services: destination.writerServices })));
                if (operation === 'start') writersStopped = false;
            };
            const health = async () => {
                if (!destination.writerServices.includes(destination.service)) return;
                const observed = await execute({ kind: 'health', service: destination.service });
                if (observed.kind !== 'health' || observed.status === 'unknown') refuse('outcome_unknown');
                if (observed.status !== 'healthy') refuse('restore_failed');
            };
            try {
                await control('stop');
                if (destination.hasMeaningfulData) {
                    completed(await execute({ kind: 'sqlite', operation: 'snapshotRecovery', destination, operationId: prepare.operationId }));
                    recoveryReady = true;
                }
                activationAttempted = true;
                await steps.run('restore', async () => completed(await execute({ kind: 'sqlite', operation: 'activate', destination, operationId: prepare.operationId })));
                await control('start');
                await steps.run('health', health);
                return result('restored', 'none');
            } catch (error) {
                steps.failRunning();
                if (activationAttempted && recoveryReady && !input.signal.aborted) {
                    try {
                        // A lost resume acknowledgement may leave some writers live.
                        await control('stop');
                        completed(await execute({ kind: 'sqlite', operation: 'recover', destination, operationId: prepare.operationId }));
                        await control('start');
                        await health();
                        return result('rolledBack', 'none', codeOf(error), error);
                    } catch (recoveryError) {
                        return result('recoveryRequired', 'inspectStagingDatabase', codeOf(recoveryError), recoveryError);
                    }
                }
                if (writersStopped && !input.signal.aborted) {
                    try { await control('start'); }
                    catch (restartError) { return result('recoveryRequired', 'checkServiceHealth', codeOf(restartError), restartError); }
                }
                return result('recoveryRequired', 'inspectStagingDatabase', codeOf(error), error);
            }
        });
    }

    if (destination.adapter === 'volume-v1') {
        let switchAttempted = false;
        try {
            await verifySource(input);
            const source = input.source;
            await steps.run('restore', async () => completed(await execute(source.kind === 'upload'
                ? { kind: 'volumeArchive', mode: 'extract', source, destination }
                : { kind: 'stageVolume', destination, request: buildResticRequestV1({ environmentId: source.environmentId,
                    access: input.access ?? refuse('backup_required'), command: { kind: 'restoreVolume', snapshotId: source.snapshot.snapshotId } }) })));
            return await input.runProtectedStage(async () => {
                try {
                    await steps.run('stop', async () => completed(await execute({ kind: 'writers', operation: 'stop', services: destination.writerServices })));
                    switchAttempted = true;
                    const health = await steps.run('start', () => execute({ kind: 'switchVolume', destination, physicalName: destination.stagingVolume }));
                    if (health.kind !== 'health' || health.status !== 'healthy') refuse(health.kind === 'health' && health.status === 'unhealthy'
                        ? 'restore_failed' : 'outcome_unknown');
                    steps.record('health', 'completed');
                    return result('restored', 'none');
                } catch (error) {
                    if (switchAttempted) {
                        const recovered = await execute({ kind: 'switchVolume', destination, physicalName: destination.currentVolume });
                        if (recovered.kind === 'health' && recovered.status === 'healthy') return result('rolledBack', 'checkServiceHealth', codeOf(error), error);
                    } else completed(await execute({ kind: 'writers', operation: 'start', services: destination.writerServices }));
                    return result('recoveryRequired', 'restorePreviousVolume', codeOf(error), error);
                }
            });
        } catch (error) {
            steps.failRunning();
            return result('recoveryRequired', switchAttempted ? 'restorePreviousVolume' : 'inspectStagingVolume', codeOf(error), error);
        }
    }
    let writersStopped = false;
    const observeNames = async () => {
        const observed = completed(await execute(sql(destination, `SELECT COALESCE(json_agg(datname), '[]'::json) FROM pg_database WHERE datname IN (${[
            destination.database, destination.stagingDatabase, destination.recoveryDatabase].map(literal).join(',')})`)));
        if (observed.stdoutTruncated) refuse('outcome_unknown');
        const names: unknown = readResticNativeJsonV1(observed.stdout);
        if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) return refuse('outcome_unknown');
        return { canonical: names.includes(destination.database), stage: names.includes(destination.stagingDatabase), old: names.includes(destination.recoveryDatabase) };
    };
    const undo = async (names: Awaited<ReturnType<typeof observeNames>>, code?: RestoreFailureCode, error?: unknown) => {
        const fullSwap = names.canonical && !names.stage && names.old === destination.databaseExists;
        const halfSwap = !names.canonical && names.stage && names.old && destination.databaseExists;
        if (fullSwap || halfSwap) {
            if (!writersStopped && destination.writerServices.length) {
                writersStopped = true;
                await steps.run('stop', async () => completed(await execute({ kind: 'writers', operation: 'stop', services: destination.writerServices })));
            }
            if (fullSwap) completed(await execute(rename(destination, destination.database, destination.stagingDatabase)));
            if (names.old) completed(await execute(rename(destination, destination.recoveryDatabase, destination.database)));
            return result('rolledBack', 'checkServiceHealth', code, error);
        }
        return names.canonical === destination.databaseExists && names.stage && !names.old
            ? result('recoveryRequired', 'inspectStagingDatabase', code, error)
            : result('outcome_unknown', 'observeDatabaseNames', code, error);
    };
    const recoveryFailure = (error: unknown) => {
        const code = codeOf(error);
        return code === 'outcome_unknown' ? result('outcome_unknown', 'observeDatabaseNames', code, error)
            : result('recoveryRequired', input.signal.aborted ? 'observeDatabaseNames' : 'restoreRecoveryDatabase', code, error);
    };
    const restartWriters = async (outcome: DeploymentRestoreResultV1) => {
        if (!writersStopped || input.signal.aborted) return { ...outcome, steps: steps.snapshot() };
        try { await steps.run('start', async () => completed(await execute({ kind: 'writers', operation: 'start', services: destination.writerServices }))); }
        catch (error) { return result('recoveryRequired', 'checkServiceHealth', codeOf(error), error); }
        return { ...outcome, steps: steps.snapshot() };
    };
    try {
        steps.record('restore', 'running');
        // A killed/force-stopped predecessor cannot execute recovery. A fresh
        // admission observes only these operation-owned names before any import.
        const names = await observeNames();
        const stagedBeforeActivation = names.stage && names.canonical === destination.databaseExists && !names.old;
        const activatedEmptyDestination = !destination.databaseExists && names.canonical && !names.stage && !names.old;
        if (names.old || stagedBeforeActivation || activatedEmptyDestination) return await input.runProtectedStage(async () => {
            steps.record('restore', 'failed');
            let recovered: DeploymentRestoreResultV1;
            // Stop may have landed just before the first rename. The incumbent
            // names are intact; resume only this restore's exact admitted writers.
            if (stagedBeforeActivation) writersStopped = destination.writerServices.length > 0;
            try { recovered = await undo(names); }
            catch (error) { recovered = recoveryFailure(error); }
            return restartWriters(recovered);
        });
        if (names.stage || names.canonical !== destination.databaseExists) {
            steps.record('restore', 'failed');
            return result('outcome_unknown', 'observeDatabaseNames');
        }
        const path = await verifySource(input);
        // PostgreSQL, rather than a SQL keyword filter, is the import authority.
        // Keep this nonprivileged owner after activation: promoting SECURITY
        // DEFINER objects to the administration user would promote dump code too.
        const role = destination.stagingDatabase;
        const password = globalThis.crypto.randomUUID().replaceAll('-', '') + globalThis.crypto.randomUUID().replaceAll('-', '');
        const environmentOverrides = { PGPASSWORD: password };
        const roleCommand = async (statement: string) => completed(await execute({ kind: 'service', mode: 'exec',
            service: destination.service, argv: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '--dbname=postgres'],
            stdin: statement, sensitiveValues: [password] }));
        await roleCommand(`CREATE ROLE ${identifier(role)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);
        try {
            completed(await execute(service(destination, ['createdb', '--maintenance-db=postgres', '--template=template0',
                `--owner=${role}`, '--', destination.stagingDatabase])));
            const authority = completed(await execute({ kind: 'service', mode: 'exec', service: destination.service,
                argv: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', `--username=${role}`, `--dbname=${destination.stagingDatabase}`, '-At', '-c',
                    `SELECT current_user = ${literal(role)} AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER') AND NOT pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') AND NOT pg_has_role(current_user, 'pg_write_server_files', 'MEMBER') FROM pg_roles WHERE rolname = current_user`],
                environmentOverrides, sensitiveValues: [password] }));
            if (authority.stdout.trim() !== 't' || authority.stdoutTruncated) refuse('unsupported_action');
            const consumer = { mode: 'exec' as const, service: destination.service, environmentOverrides,
                argv: [input.sourceFormat === 'postgresSql' ? 'psql' : 'pg_restore', `--username=${role}`,
                    ...(input.sourceFormat === 'postgresSql' ? ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction']
                        : ['--no-owner', '--no-acl', '--clean', '--if-exists', '--exit-on-error', '--single-transaction']),
                    `--dbname=${destination.stagingDatabase}`] };
            const restored = completed(await execute(input.source.kind === 'upload'
                ? { kind: 'restoreUpload', source: input.source, consumer }
                : { kind: 'restoreStream', producer: buildResticRequestV1({ environmentId: input.source.environmentId,
                    access: input.access ?? refuse('backup_required'), command: { kind: 'dump', snapshotId: input.source.snapshot.snapshotId,
                        path: path ?? refuse('backup_integrity_failed') } }), consumer }));
            if (input.source.kind !== 'upload' && (restored.producer?.exitCode !== 0
                || restored.producer.checksumSha256 !== input.source.producerChecksumSha256
                || restored.producer.bytes !== input.source.totalBytesProcessed)) refuse('backup_integrity_failed');
            // Existing administration/app identity can inherit the restored objects;
            // functions retain the restricted owner, including on later re-backup.
            await roleCommand(`ALTER ROLE ${identifier(role)} NOLOGIN PASSWORD NULL; GRANT ${identifier(role)} TO CURRENT_USER;`);
        } catch (error) {
            // Keep failed stage and its restricted owner for visible inspection.
            // Retire the temporary login even when parsing/import failed.
            if (!input.signal.aborted) await roleCommand(`ALTER ROLE ${identifier(role)} NOLOGIN PASSWORD NULL;`);
            throw error;
        }
        completed(await execute({ kind: 'integrity', service: destination.service, database: destination.stagingDatabase }));
        return await input.runProtectedStage(async () => {
            let activationAttempted = false;
            let outcome: DeploymentRestoreResultV1;
            try {
                if (destination.writerServices.length) {
                    // A failed/unknown stop may have stopped some writers. Own their restart.
                    writersStopped = true;
                    await steps.run('stop', async () => completed(await execute({ kind: 'writers', operation: 'stop', services: destination.writerServices })));
                } else {
                    steps.record('stop', 'skipped');
                }
                activationAttempted = true;
                if (destination.databaseExists) completed(await execute(rename(destination, destination.database, destination.recoveryDatabase)));
                completed(await execute(rename(destination, destination.stagingDatabase, destination.database)));
                completed(await execute({ kind: 'integrity', service: destination.service, database: destination.database }));
                steps.record('restore', 'completed');
                if (writersStopped) {
                    // A lost start acknowledgement may mean writers are already live;
                    // recovery must stop them again before renaming databases.
                    writersStopped = false;
                    await steps.run('start', async () => completed(await execute({ kind: 'writers', operation: 'start', services: destination.writerServices })));
                } else {
                    steps.record('start', 'skipped');
                }
                await steps.run('health', async () => {
                    const health = await execute({ kind: 'health', service: destination.service });
                    if (health.kind !== 'health' || health.status === 'unknown') refuse('outcome_unknown');
                    if (health.status !== 'healthy') refuse('restore_failed');
                });
                outcome = result('restored', 'none');
            } catch (error) {
                steps.failRunning();
                const code = codeOf(error);
                outcome = result('recoveryRequired', 'inspectStagingDatabase', code, error);
                if (activationAttempted && !input.signal.aborted) {
                    // Unknown exit is not permission to replay a rename. Observe
                    // the exact operation-bound names, then undo only a proven swap.
                    try { outcome = await undo(await observeNames(), code, error); }
                    catch (recoveryError) { outcome = recoveryFailure(recoveryError); }
                } else if (activationAttempted) outcome = result('recoveryRequired', 'observeDatabaseNames', code, error);
            }
            return restartWriters(outcome);
        });
    } catch (error) {
        steps.failRunning();
        return result('recoveryRequired', 'inspectStagingDatabase', codeOf(error), error);
    }
}
