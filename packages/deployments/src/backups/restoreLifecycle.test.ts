import { describe, expect, it } from 'vitest';
import * as owners from '../index.js';
import type { DeploymentRestoreConfirmInputV1, DeploymentRestoreNativeRequestV1, DeploymentRestoreNativeResultV1,
    DeploymentRestorePrepareInputV1, DeploymentRestorePrepareReceiptV1 } from '../index.js';
import type { DeploymentBackupRunInputV1 } from '../actions/backups.js';
import type { DeploymentBackupManifestV1 } from '@happier-dev/deployment-protocol';

const snapshotId = 'a'.repeat(64), treeId = 'b'.repeat(64), repositoryId = 'c'.repeat(64), checksum = 'd'.repeat(64);
const manifest: DeploymentBackupManifestV1 = { schemaVersion: 1, environmentId: 'source', sourceId: 'main', kind: 'dump', configRevision: 1,
    repositoryId, snapshot: { snapshotId, treeId, hostname: 'happier-env-source', time: '2026-10-30T19:00:00Z',
        paths: ['/db.dump'], tags: ['happier', 'env:source', 'src:main', 'kind:dump'] },
    totalBytesProcessed: 123, totalFilesProcessed: 1, producerChecksumSha256: checksum };
const access = { repository: '/repository', passwordFilePath: '/run/password', credentialFiles: [], environmentVariableNames: [] } as const;
const destination = { environmentId: 'target', revision: 2, service: 'db', adapter: 'postgres-v1', database: 'app',
    stagingDatabase: 'restore_stage', recoveryDatabase: 'restore_old', databaseExists: true,
    hasMeaningfulData: false, writerServices: ['web'] } as const;
const complete = (stdout = '') => ({ kind: 'completed', exitCode: 0, stdout, stdoutTruncated: false } as const);

function safetyBackup(producerExitCode = 0, onPayloadRead?: () => void): DeploymentBackupRunInputV1 {
    return { environmentId: 'target', access, signal: new AbortController().signal,
        configuration: { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 's3' }, occurrenceId: 'storage',
            config: {}, credentialBindings: [], sources: [{ kind: 'dump', sourceId: 'main', service: 'db', consistency: 'logical' }],
            ownership: { environmentId: 'target', prefix: 'target' }, retention: { kind: 'keepEverything' } },
        data: { engine: 'postgres', service: 'db', logicalBackup: { adapter: 'postgres-v1', database: 'DATABASE_NAME' } },
        async execute(request) {
            if (request.argv.includes('config')) return complete(JSON.stringify({ id: repositoryId, version: 2 }));
            if (request.argv.includes('backup')) return { ...complete(JSON.stringify({ message_type: 'summary', snapshot_id: 'e'.repeat(64),
                total_bytes_processed: 123, total_files_processed: 1 })), producer: { exitCode: producerExitCode, checksumSha256: checksum } };
            if (request.argv.includes('snapshots')) return complete(JSON.stringify([{ id: 'e'.repeat(64), tree: treeId,
                hostname: 'happier-env-target', time: manifest.snapshot.time, paths: ['/db.dump'], tags: ['happier', 'env:target', 'src:main', 'kind:dump'] }]));
            if (request.argv.includes('tree')) return complete(JSON.stringify({ nodes: [{ name: 'db.dump', type: 'file', size: 123 }] }));
            onPayloadRead?.();
            return { ...complete(), stdoutChecksumSha256: checksum, stdoutBytes: 123 };
        } };
}

function boundary(options: Readonly<{ healthFails?: boolean; streamFails?: boolean; unknownActivation?: boolean;
    unknownObservation?: boolean; failSecondRename?: boolean; wrongRepository?: boolean; integrityFails?: boolean;
    abortAfterActivation?: AbortController; abortAfterFirstRename?: AbortController; abortAfterWriterStop?: AbortController; nativeSignal?: AbortSignal;
    initialNames?: readonly string[]; unknownFirstWriterStart?: boolean }> = {}) {
    let names = new Set(options.initialNames ?? ['app']);
    let startCount = 0;
    let writersRunning = true;
    let nativeSignal = options.nativeSignal;
    let callsAfterAbort = 0;
    const effects: string[] = [];
    // Substitute only native process, streaming and P41 health IO. All restore decisions and SQL remain real.
    const execute = async (request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1> => {
        if (nativeSignal?.aborted) {
            callsAfterAbort++;
            throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        }
        const argv = request.kind === 'service' ? request.argv : request.kind === 'restic' ? request.request.argv : [];
        effects.push(`${request.kind}:${argv.join(' ')}`);
        if (request.kind === 'restic') {
            if (argv.includes('config')) return complete(JSON.stringify({ id: options.wrongRepository ? 'f'.repeat(64) : repositoryId, version: 2 }));
            if (argv.includes('snapshots')) return complete(JSON.stringify([{ id: snapshotId, tree: treeId,
                hostname: manifest.snapshot.hostname, time: manifest.snapshot.time, paths: manifest.snapshot.paths, tags: manifest.snapshot.tags }]));
            if (argv.includes('tree')) return complete(JSON.stringify({ nodes: [{ name: 'db.dump', type: 'file', size: 123 }] }));
            return { ...complete(), stdoutChecksumSha256: checksum, stdoutBytes: 123 };
        }
        if (request.kind === 'restoreStream') return { ...complete(), exitCode: options.streamFails ? 1 : 0,
            producer: { exitCode: 0, checksumSha256: checksum, bytes: 123 } };
        if (request.kind === 'health') return { kind: 'health', status: options.healthFails ? 'unhealthy' : 'healthy' };
        if (request.kind === 'writers') {
            writersRunning = request.operation === 'start';
            if (request.operation === 'stop') options.abortAfterWriterStop?.abort();
            if (request.operation === 'start' && ++startCount === 1 && options.unknownFirstWriterStart) return { kind: 'outcome_unknown' };
            return complete();
        }
        if (argv[0] === 'createdb') {
            if (names.has('restore_stage')) return { ...complete(), exitCode: 1 };
            names.add('restore_stage'); return complete();
        }
        if (request.kind === 'integrity') return { ...complete(), exitCode: options.integrityFails ? 1 : 0 };
        const sql = argv.at(-1) ?? '';
        if (sql.startsWith('SELECT')) return options.unknownObservation && names.has('restore_old') ? { kind: 'outcome_unknown' }
            : complete(JSON.stringify([...names]));
        const match = /ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/u.exec(sql);
        if (match) {
            if (writersRunning) return { ...complete(), exitCode: 1 };
            const [, from, to] = match;
            if (!names.has(from!) || names.has(to!)) return { ...complete(), exitCode: 1 };
            if (options.failSecondRename && from === 'restore_stage') return { ...complete(), exitCode: 1 };
            names.delete(from!); names.add(to!);
            if (from === 'app') options.abortAfterFirstRename?.abort();
            if (from === 'restore_stage') options.abortAfterActivation?.abort();
            if (options.unknownActivation && from === 'restore_stage') return { kind: 'outcome_unknown' };
        }
        return complete();
    };
    return { execute, effects, get names() { return [...names].sort(); }, get writersRunning() { return writersRunning; },
        get callsAfterAbort() { return callsAfterAbort; }, setNativeSignal(signal: AbortSignal) { nativeSignal = signal; } };
}

async function prepare(native: ReturnType<typeof boundary>, overrides: Partial<DeploymentRestorePrepareInputV1> = {}) {
    return owners.prepareDeploymentRestoreV1({ operationId: 'prepare-1', source: manifest, sourceFormat: 'postgresCustom', destination, access, signal: new AbortController().signal,
        execute: native.execute, ...overrides });
}
async function confirm(native: ReturnType<typeof boundary>, receipt: DeploymentRestorePrepareReceiptV1, overrides: Partial<DeploymentRestoreConfirmInputV1> = {}) {
    return owners.confirmDeploymentRestoreV1({ prepare: receipt, source: manifest, sourceFormat: 'postgresCustom', destination, access, signal: new AbortController().signal,
        execute: native.execute,
        // Host port only: real cancellation forwarding is exercised by the CLI
        // composed test through createMachineNativeEffectAdmission, not emulated here.
        runProtectedStage: effect => effect(), ...overrides });
}

describe('exact PostgreSQL restore semantic owner', () => {
    it('verifies the exact repository source, stages and checks before activation, and verifies health before restored', async () => {
        const native = boundary();
        const receipt = await prepare(native);
        expect(receipt).toMatchObject({ operationId: 'prepare-1', source: { repositoryId, snapshot: { snapshotId } }, destination });
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'restored', verified: true, source: { snapshot: { snapshotId } }, destination });
        const stage = native.effects.findIndex(effect => effect.startsWith('restoreStream:'));
        const activation = native.effects.findIndex(effect => effect.includes('ALTER DATABASE'));
        expect(stage).toBeGreaterThan(-1);
        expect(activation).toBeGreaterThan(stage);
        expect(native.effects.filter(effect => effect.startsWith('integrity:'))).toHaveLength(2);
        expect(native.effects.filter(effect => effect.includes('SELECT COALESCE(json_agg(datname)'))).toHaveLength(1);
        expect(native.names).toEqual(['app', 'restore_old']);
    });

    it('requires a real verified safety backup before prepare can replace meaningful data', async () => {
        const native = boundary();
        await expect(prepare(native, { destination: { ...destination, hasMeaningfulData: true } }))
            .rejects.toMatchObject({ code: 'backup_required' });
        expect(native.effects).toEqual([]);
    });

    it('carries the canonical backup producer exact recovery snapshot and never accepts failed safety capture', async () => {
        const native = boundary(); const target = { ...destination, hasMeaningfulData: true };
        const receipt = await prepare(native, { destination: target, safetyBackup: safetyBackup() });
        expect(receipt).toMatchObject({ safetyBackup: { kind: 'verified', manifests: [{ environmentId: 'target', snapshot: { snapshotId: 'e'.repeat(64) } }] } });
        expect(await confirm(native, receipt, { destination: target })).toMatchObject({ kind: 'restored', verified: true,
            safetyBackup: { manifests: [{ snapshot: { snapshotId: 'e'.repeat(64) } }] } });
        await expect(prepare(boundary(), { destination: target, safetyBackup: safetyBackup(1) })).rejects.toMatchObject({ code: 'backup_failed' });
    });

    it('retains the exact safety backup settlement when Stop arrives after its canonical final check', async () => {
        const native = boundary(); const controller = new AbortController();
        const target = { ...destination, hasMeaningfulData: true };
        // Native IO and the backup owner's execute wrapper each resume once.
        // The third microtask reaches the gap after the child's final check.
        const backup = safetyBackup(0, () => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort()))));
        await expect(prepare(native, { destination: target, safetyBackup: backup, signal: controller.signal })).resolves.toMatchObject({
            kind: 'prepared', destination: target, safetyBackup: { kind: 'verified', manifests: [{ environmentId: 'target',
                snapshot: { snapshotId: 'e'.repeat(64) }, producerChecksumSha256: checksum }] },
        });
        expect(controller.signal.aborted).toBe(true);
        expect(native.names).toEqual(['app']);
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
    });

    it('retains child recovery evidence when Stop precedes the safety backup settlement', async () => {
        const native = boundary(); const controller = new AbortController();
        const backup = safetyBackup(0, () => queueMicrotask(() => queueMicrotask(() => controller.abort())));
        await expect(prepare(native, { destination: { ...destination, hasMeaningfulData: true }, safetyBackup: backup,
            signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled', details: {
            manifests: [{ environmentId: 'target', snapshot: { snapshotId: 'e'.repeat(64) } }],
        } });
        expect(native.names).toEqual(['app']);
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
    });

    it('rejects a different source or destination before any confirm mutation', async () => {
        const native = boundary(); const receipt = await prepare(native); native.effects.length = 0;
        await expect(confirm(native, receipt, { source: { ...manifest, snapshot: { ...manifest.snapshot, snapshotId: 'e'.repeat(64) } } }))
            .rejects.toMatchObject({ code: 'stale_input' });
        await expect(confirm(native, receipt, { destination: { ...destination, revision: 3 } }))
            .rejects.toMatchObject({ code: 'stale_input' });
        expect(native.effects).toEqual([]);
    });

    it('accepts the same exact receipt after JSON transport changes object property order', async () => {
        const native = boundary(); const receipt = await prepare(native);
        const { snapshot, ...sourceFields } = receipt.source;
        const reordered = { ...receipt, source: { snapshot, ...sourceFields } };
        expect(await confirm(native, reordered)).toMatchObject({ kind: 'restored', verified: true });
    });

    it('refuses a source opened from a different repository before any destination effect', async () => {
        const native = boundary({ wrongRepository: true });
        await expect(prepare(native)).rejects.toMatchObject({ code: 'backup_integrity_failed' });
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
    });

    it('never activates a failed import and preserves the original database', async () => {
        const native = boundary({ streamFails: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'recoveryRequired', verified: false });
        expect(native.names).toContain('app');
        expect(native.effects.some(effect => effect.includes('ALTER DATABASE'))).toBe(false);
    });

    it('does not activate a staged database whose integrity check fails', async () => {
        const native = boundary({ integrityFails: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'recoveryRequired', verified: false });
        expect(native.effects.some(effect => effect.includes('ALTER DATABASE'))).toBe(false);
    });

    it('restores the incumbent name after a known half-swap or failed activated health', async () => {
        for (const options of [{ failSecondRename: true }, { healthFails: true }]) {
            const native = boundary(options); const receipt = await prepare(native);
            expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
            expect(native.names).toEqual(['app', 'restore_stage']);
        }
    });

    it('observes names after unknown activation and never blindly replays it', async () => {
        const native = boundary({ unknownActivation: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
        const unknown = boundary({ unknownActivation: true, unknownObservation: true }); const other = await prepare(unknown);
        expect(await confirm(unknown, other)).toMatchObject({ kind: 'outcome_unknown', verified: false, nextAction: 'observeDatabaseNames' });
        expect(unknown.effects.filter(effect => effect.includes('ALTER DATABASE'))).toHaveLength(2);
    });

    it('local cancellation prevents mutation and unsupported adapters never claim native readiness', async () => {
        const native = boundary(); const receipt = await prepare(native); native.effects.length = 0;
        const abort = new AbortController(); abort.abort();
        expect(await confirm(native, receipt, { signal: abort.signal })).toMatchObject({ kind: 'recoveryRequired', verified: false, code: 'cancelled' });
        expect(native.effects).toEqual([]);
        // External malformed/unsupported adapter input is refused, not activated.
        await expect(prepare(native, { destination: { ...destination, adapter: 'mysql-v1' as 'postgres-v1' } })).rejects.toMatchObject({ code: 'unsupported_action' });
    });

    it('performs no native recovery after force-stop and repairs the half-swap at the next admission', async () => {
        const abort = new AbortController(); const native = boundary({ abortAfterFirstRename: abort, nativeSignal: abort.signal });
        const receipt = await prepare(native);
        expect(await confirm(native, receipt, { signal: abort.signal })).toMatchObject({ verified: false, code: 'cancelled' });
        expect(native.names).toEqual(['restore_old', 'restore_stage']);
        expect(native.callsAfterAbort).toBe(0);
        const nextAdmission = new AbortController(); native.setNativeSignal(nextAdmission.signal);
        native.effects.length = 0;
        expect(await confirm(native, receipt, { signal: nextAdmission.signal })).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
        expect(native.effects.filter(effect => effect.includes('SELECT COALESCE(json_agg(datname)'))).toHaveLength(1);
    });

    it('repairs a crash half-swap at the next restore admission before attempting a new import', async () => {
        const native = boundary({ initialNames: ['restore_old', 'restore_stage'] }); const receipt = await prepare(native);
        native.effects.length = 0;
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
    });

    it('restarts writers on next admission after force-stop just before the first rename', async () => {
        const abort = new AbortController(); const native = boundary({ abortAfterWriterStop: abort, nativeSignal: abort.signal });
        const receipt = await prepare(native);
        expect(await confirm(native, receipt, { signal: abort.signal })).toMatchObject({ verified: false, code: 'cancelled' });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(false);
        expect(native.callsAfterAbort).toBe(0);
        const nextAdmission = new AbortController(); native.setNativeSignal(nextAdmission.signal);
        native.effects.length = 0;
        expect(await confirm(native, receipt, { signal: nextAdmission.signal })).toMatchObject({ kind: 'recoveryRequired', nextAction: 'inspectStagingDatabase' });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('ALTER DATABASE') || effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
    });

    it('undoes a crash activation into a previously absent database at the next admission', async () => {
        const abort = new AbortController(); const native = boundary({ initialNames: [], abortAfterActivation: abort, nativeSignal: abort.signal });
        const empty = { ...destination, databaseExists: false };
        const receipt = await prepare(native, { destination: empty });
        expect(await confirm(native, receipt, { destination: empty, signal: abort.signal })).toMatchObject({ verified: false, code: 'cancelled' });
        expect(native.names).toEqual(['app']);
        expect(native.callsAfterAbort).toBe(0);
        const nextAdmission = new AbortController(); native.setNativeSignal(nextAdmission.signal);
        native.effects.length = 0;
        expect(await confirm(native, receipt, { destination: empty, signal: nextAdmission.signal })).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
    });

    it('stops possibly resumed writers again before recovery after a lost start acknowledgement', async () => {
        const native = boundary({ unknownFirstWriterStart: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
    });
});
