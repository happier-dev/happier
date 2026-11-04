import type { DeploymentBackupManifestV1 } from '@happier-dev/deployment-protocol';

import { runDeploymentBackupV1, type DeploymentBackupNativeResultV1, type DeploymentBackupRunInputV1,
    type DeploymentBackupRunResultV1 } from '../actions/backups.js';
import { readResticNativeJsonV1 } from './manifestV1.js';
import { verifyDeploymentBackupV1 } from './verificationV1.js';
import { buildResticRequestV1, type ResticAccessV1, type ResticRequestV1 } from './resticExecutor.js';

/** Exact native identities and supported tools are captured by P41/P30 at admission.
 * Staging/recovery names belong to this operation, not a caller-selected live database. */
export type DeploymentRestoreDestinationV1 = Readonly<{
    environmentId: string; revision: number; service: string; adapter: 'postgres-v1';
    database: string; stagingDatabase: string; recoveryDatabase: string;
    databaseExists: boolean; hasMeaningfulData: boolean;
    /** Exact admitted writers to stop/resume; excludes deliberately stopped services. */
    writerServices: readonly string[];
}>;
/** These requests describe native IO, not lifecycle callbacks. P30 owns process,
 * stream checksum/EOF, cancellation and settlement; P41 owns exact service control,
 * supported engine integrity checks and service/app health. No adapter is supplied
 * by default: registration must remain unavailable until these real producers exist. */
export type DeploymentRestoreNativeRequestV1 =
    | Readonly<{ kind: 'restic'; request: ResticRequestV1 }>
    | Readonly<{ kind: 'service'; mode: 'exec'; service: string; argv: readonly string[] }>
    | Readonly<{ kind: 'restoreStream'; producer: ResticRequestV1;
        consumer: Readonly<{ mode: 'exec'; service: string; argv: readonly string[] }> }>
    | Readonly<{ kind: 'writers'; operation: 'stop' | 'start'; services: readonly string[] }>
    | Readonly<{ kind: 'integrity'; service: string; database: string }>
    | Readonly<{ kind: 'health'; service: string }>;
export type DeploymentRestoreNativeResultV1 = Readonly<{ kind: 'outcome_unknown' }>
    | (Omit<Extract<DeploymentBackupNativeResultV1, { kind: 'completed' }>, 'producer'> & Readonly<{
        producer?: Readonly<{ exitCode: number; checksumSha256: string; bytes: number }>;
    }>)
    | Readonly<{ kind: 'health'; status: 'healthy' | 'unhealthy' | 'unknown' }>;
type NativeExecute = (request: DeploymentRestoreNativeRequestV1) => Promise<DeploymentRestoreNativeResultV1>;
type RestoreCapture = Readonly<{
    source: DeploymentBackupManifestV1; destination: DeploymentRestoreDestinationV1;
    /** Captured by the source/tool preflight; a dump manifest alone does not prove format. */
    sourceFormat: 'postgresCustom';
    access: ResticAccessV1; signal: AbortSignal; execute: NativeExecute;
}>;
export type DeploymentRestorePrepareInputV1 = RestoreCapture & Readonly<{
    operationId: string; safetyBackup?: DeploymentBackupRunInputV1;
}>;
/** Stored in the existing prepare Action receipt. No prepared-token/state store. */
export type DeploymentRestorePrepareReceiptV1 = Readonly<{
    kind: 'prepared'; operationId: string; source: DeploymentBackupManifestV1;
    sourceFormat: 'postgresCustom'; destination: DeploymentRestoreDestinationV1; safetyBackup?: DeploymentBackupRunResultV1;
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
    source: DeploymentBackupManifestV1; destination: DeploymentRestoreDestinationV1;
    safetyBackup?: DeploymentBackupRunResultV1; code?: RestoreFailureCode;
}> & (Readonly<{ kind: 'restored'; verified: true; nextAction: 'none' }>
    | Readonly<{ kind: 'rolledBack' | 'outcome_unknown' | 'recoveryRequired'; verified: false;
        nextAction: 'none' | 'inspectStagingDatabase' | 'observeDatabaseNames' | 'restoreRecoveryDatabase' | 'checkServiceHealth' }>);

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
function completed(result: DeploymentRestoreNativeResultV1) {
    if (result.kind !== 'completed') return refuse('outcome_unknown');
    if (result.exitCode !== 0) return refuse('restore_failed');
    return result;
}
function identifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function service(destination: DeploymentRestoreDestinationV1, argv: readonly string[]): DeploymentRestoreNativeRequestV1 {
    return { kind: 'service', service: destination.service, mode: 'exec', argv };
}
function sql(destination: DeploymentRestoreDestinationV1, statement: string) {
    return service(destination, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '--dbname=postgres', '-At', '-c', statement]);
}
function rename(destination: DeploymentRestoreDestinationV1, from: string, to: string) {
    return sql(destination, `ALTER DATABASE ${identifier(from)} RENAME TO ${identifier(to)}`);
}
function sameMembers(left: readonly string[], right: readonly string[]) {
    const leftSet = new Set(left), rightSet = new Set(right);
    return leftSet.size === rightSet.size && [...leftSet].every(member => rightSet.has(member));
}
function sameSource(left: DeploymentBackupManifestV1, right: DeploymentBackupManifestV1) {
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
    await verifyDeploymentBackupV1({ environmentId: source.environmentId, configRevision: source.configRevision,
        manifest: source, access: input.access, signal: input.signal, level: 'manifestReadBack', execute: async request => {
            const result = await input.execute({ kind: 'restic', request });
            if (result.kind !== 'completed') return refuse('outcome_unknown');
            return result;
        } });
    return source.snapshot.paths[0]!;
}

export async function prepareDeploymentRestoreV1(input: DeploymentRestorePrepareInputV1): Promise<DeploymentRestorePrepareReceiptV1> {
    cancelled(input.signal);
    // Unsupported formats/engines are explicit; custom PostgreSQL archives alone
    // have a staged semantic producer here. Upload admission remains transfer-owned.
    if (input.destination.adapter !== 'postgres-v1' || input.source.kind !== 'dump' || input.sourceFormat !== 'postgresCustom') refuse('unsupported_action');
    const { destination } = input;
    if (new Set([destination.database, destination.stagingDatabase, destination.recoveryDatabase]).size !== 3) refuse('stale_input');
    if (destination.hasMeaningfulData && (!input.safetyBackup || input.safetyBackup.environmentId !== destination.environmentId
        || !input.safetyBackup.configuration.sources.some(source => source.kind === 'dump' && source.service === destination.service))) refuse('backup_required');
    await verifySource(input);
    const safetyBackup = destination.hasMeaningfulData && input.safetyBackup
        ? await runDeploymentBackupV1({ ...input.safetyBackup, signal: input.signal }) : undefined;
    return { kind: 'prepared', operationId: input.operationId, source: input.source, sourceFormat: input.sourceFormat, destination,
        ...(safetyBackup ? { safetyBackup } : {}) };
}

/** Invoked inside a fresh host admission. Source/target authority, target revision
 * CAS and credential acquisition are the host owners' work, once at that boundary.
 * This exact receipt comparison prevents substitution; it is not a phase authority loop. */
export async function confirmDeploymentRestoreV1(input: DeploymentRestoreConfirmInputV1): Promise<DeploymentRestoreResultV1> {
    const { destination, prepare } = input;
    if (!sameSource(input.source, prepare.source) || input.sourceFormat !== prepare.sourceFormat
        || !sameDestination(destination, prepare.destination)) refuse('stale_input');
    if (destination.hasMeaningfulData && !prepare.safetyBackup) refuse('backup_required');
    const result = (kind: DeploymentRestoreResultV1['kind'], nextAction: DeploymentRestoreResultV1['nextAction'], code?: RestoreFailureCode): DeploymentRestoreResultV1 => {
        const evidence = { source: prepare.source, destination,
            ...(prepare.safetyBackup ? { safetyBackup: prepare.safetyBackup } : {}), ...(code ? { code } : {}) };
        return kind === 'restored' ? { ...evidence, kind, verified: true, nextAction: 'none' }
            : { ...evidence, kind, verified: false, nextAction };
    };
    const execute = async (request: DeploymentRestoreNativeRequestV1) => {
        cancelled(input.signal);
        return input.execute(request);
    };
    let writersStopped = false;
    const observeNames = async () => {
        const observed = completed(await execute(sql(destination, `SELECT COALESCE(json_agg(datname), '[]'::json) FROM pg_database WHERE datname IN (${[
            destination.database, destination.stagingDatabase, destination.recoveryDatabase].map(literal).join(',')})`)));
        if (observed.stdoutTruncated) refuse('outcome_unknown');
        const names: unknown = readResticNativeJsonV1(observed.stdout);
        if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) return refuse('outcome_unknown');
        return { canonical: names.includes(destination.database), stage: names.includes(destination.stagingDatabase), old: names.includes(destination.recoveryDatabase) };
    };
    const undo = async (names: Awaited<ReturnType<typeof observeNames>>, code?: RestoreFailureCode) => {
        const fullSwap = names.canonical && !names.stage && names.old === destination.databaseExists;
        const halfSwap = !names.canonical && names.stage && names.old && destination.databaseExists;
        if (fullSwap || halfSwap) {
            if (!writersStopped && destination.writerServices.length) {
                writersStopped = true;
                completed(await execute({ kind: 'writers', operation: 'stop', services: destination.writerServices }));
            }
            if (fullSwap) completed(await execute(rename(destination, destination.database, destination.stagingDatabase)));
            if (names.old) completed(await execute(rename(destination, destination.recoveryDatabase, destination.database)));
            return result('rolledBack', 'checkServiceHealth', code);
        }
        return names.canonical === destination.databaseExists && names.stage && !names.old
            ? result('recoveryRequired', 'inspectStagingDatabase', code)
            : result('outcome_unknown', 'observeDatabaseNames', code);
    };
    const recoveryFailure = (error: unknown) => {
        const code = codeOf(error);
        return code === 'outcome_unknown' ? result('outcome_unknown', 'observeDatabaseNames', code)
            : result('recoveryRequired', input.signal.aborted ? 'observeDatabaseNames' : 'restoreRecoveryDatabase', code);
    };
    const restartWriters = async (outcome: DeploymentRestoreResultV1) => {
        if (!writersStopped || input.signal.aborted) return outcome;
        try { completed(await execute({ kind: 'writers', operation: 'start', services: destination.writerServices })); }
        catch (error) { return result('recoveryRequired', 'checkServiceHealth', codeOf(error)); }
        return outcome;
    };
    try {
        // A killed/force-stopped predecessor cannot execute recovery. A fresh
        // admission observes only these operation-owned names before any import.
        const names = await observeNames();
        const stagedBeforeActivation = names.stage && names.canonical === destination.databaseExists && !names.old;
        const activatedEmptyDestination = !destination.databaseExists && names.canonical && !names.stage && !names.old;
        if (names.old || stagedBeforeActivation || activatedEmptyDestination) return await input.runProtectedStage(async () => {
            let recovered: DeploymentRestoreResultV1;
            // Stop may have landed just before the first rename. The incumbent
            // names are intact; resume only this restore's exact admitted writers.
            if (stagedBeforeActivation) writersStopped = destination.writerServices.length > 0;
            try { recovered = await undo(names); }
            catch (error) { recovered = recoveryFailure(error); }
            return restartWriters(recovered);
        });
        if (names.stage || names.canonical !== destination.databaseExists) return result('outcome_unknown', 'observeDatabaseNames');
        const path = await verifySource(input);
        completed(await execute(service(destination, ['createdb', '--maintenance-db=postgres', '--template=template0', '--', destination.stagingDatabase])));
        const restored = completed(await execute({ kind: 'restoreStream', producer: buildResticRequestV1({ environmentId: input.source.environmentId,
            access: input.access, command: { kind: 'dump', snapshotId: input.source.snapshot.snapshotId, path } }),
            consumer: { mode: 'exec', service: destination.service, argv: ['pg_restore', '--no-owner', '--no-acl', '--clean', '--if-exists',
                '--exit-on-error', '--single-transaction', `--dbname=${destination.stagingDatabase}`] } }));
        if (restored.producer?.exitCode !== 0 || restored.producer.checksumSha256 !== input.source.producerChecksumSha256
            || restored.producer.bytes !== input.source.totalBytesProcessed) refuse('backup_integrity_failed');
        completed(await execute({ kind: 'integrity', service: destination.service, database: destination.stagingDatabase }));
        return await input.runProtectedStage(async () => {
            let activationAttempted = false;
            let outcome: DeploymentRestoreResultV1;
            try {
                if (destination.writerServices.length) {
                    // A failed/unknown stop may have stopped some writers. Own their restart.
                    writersStopped = true;
                    completed(await execute({ kind: 'writers', operation: 'stop', services: destination.writerServices }));
                }
                activationAttempted = true;
                if (destination.databaseExists) completed(await execute(rename(destination, destination.database, destination.recoveryDatabase)));
                completed(await execute(rename(destination, destination.stagingDatabase, destination.database)));
                completed(await execute({ kind: 'integrity', service: destination.service, database: destination.database }));
                if (writersStopped) {
                    // A lost start acknowledgement may mean writers are already live;
                    // recovery must stop them again before renaming databases.
                    writersStopped = false;
                    completed(await execute({ kind: 'writers', operation: 'start', services: destination.writerServices }));
                }
                const health = await execute({ kind: 'health', service: destination.service });
                if (health.kind !== 'health' || health.status === 'unknown') refuse('outcome_unknown');
                if (health.status !== 'healthy') refuse('restore_failed');
                outcome = result('restored', 'none');
            } catch (error) {
                const code = codeOf(error);
                outcome = result('recoveryRequired', 'inspectStagingDatabase', code);
                if (activationAttempted && !input.signal.aborted) {
                    // Unknown exit is not permission to replay a rename. Observe
                    // the exact operation-bound names, then undo only a proven swap.
                    try { outcome = await undo(await observeNames(), code); }
                    catch (recoveryError) { outcome = recoveryFailure(recoveryError); }
                } else if (activationAttempted) outcome = result('recoveryRequired', 'observeDatabaseNames', code);
            }
            return restartWriters(outcome);
        });
    } catch (error) {
        return result('recoveryRequired', 'inspectStagingDatabase', codeOf(error));
    }
}
