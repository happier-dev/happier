import { describe, expect, it } from 'vitest';
import * as owners from '../index.js';
import type { DeploymentBackupConfigurationV1, DeploymentBackupManifestV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupRunInputV1 } from '../actions/backups.js';
import type { ResticRequestV1 } from './resticExecutor.js';

const environmentId = 'environment-a';
const snapshotId = 'a'.repeat(64), treeId = 'b'.repeat(64), repositoryId = 'c'.repeat(64), checksum = 'd'.repeat(64);
const otherId = 'e'.repeat(64), protectedId = 'f'.repeat(64);
const configuration: DeploymentBackupConfigurationV1 = { configRevision: 1,
    destinationRef: { pluginId: 'example.storage', localId: 's3' }, occurrenceId: 'storage', config: { bucket: 'recovery' },
    credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
    sources: [{ kind: 'dump', sourceId: 'main', service: 'db', consistency: 'logical' }],
    ownership: { environmentId, prefix: environmentId }, retention: { kind: 'keep', last: 2 } };
const access: DeploymentBackupRunInputV1['access'] = { repository: 's3:https://storage.invalid/recovery/environment-a',
    passwordFilePath: '/run/secrets/password', credentialFiles: [], environmentVariableNames: [] };
const snapshot = { snapshotId, treeId, hostname: `happier-env-${environmentId}`, time: '2026-10-30T19:00:00Z',
    paths: ['/db.dump'], tags: ['happier', `env:${environmentId}`, 'kind:dump', 'src:main'] };
const manifest: DeploymentBackupManifestV1 = { schemaVersion: 1, environmentId, sourceId: 'main', kind: 'dump',
    configRevision: 1, repositoryId, snapshot, totalBytesProcessed: 123, totalFilesProcessed: 1, producerChecksumSha256: checksum };
const rawSnapshot = (id = snapshotId) => ({ id, tree: treeId, hostname: snapshot.hostname, time: snapshot.time,
    paths: snapshot.paths, tags: snapshot.tags, summary: { total_bytes_processed: 123, total_files_processed: 1 } });
function boundary(options: Readonly<{ inventory?: unknown[]; repository?: string; readBackChecksum?: string;
    candidates?: unknown[]; fail?: string; unknown?: string; truncated?: string }> = {}) {
    const requests: ResticRequestV1[] = [];
    // Substitute only the native process boundary; all request and evidence owners remain real.
    const execute: DeploymentBackupRunInputV1['execute'] = async request => {
        requests.push(request);
        const command = request.argv.includes('config') ? 'config' : request.argv.includes('tree') ? 'tree'
            : ['snapshots', 'dump', 'forget', 'prune', 'check'].find(command => request.argv.includes(command));
        if (!command) throw new Error('Unexpected native command');
        if (options.unknown === command) return { kind: 'outcome_unknown' };
        const value = command === 'config' ? { id: options.repository ?? repositoryId, version: 2 }
            : command === 'snapshots' ? options.inventory ?? [rawSnapshot()]
            : command === 'tree' ? { nodes: [{ name: 'db.dump', type: 'file', size: 123, content: ['1'.repeat(64)] }] }
            : command === 'forget' && request.argv.includes('--dry-run')
                ? [{ remove: options.candidates ?? [rawSnapshot(), rawSnapshot(otherId), rawSnapshot(protectedId)] }]
            : null;
        return { kind: 'completed', exitCode: options.fail === command ? 7 : 0,
            stdout: value === null ? '' : JSON.stringify(value), stdoutTruncated: options.truncated === command,
            ...(command === 'dump' ? { stdoutChecksumSha256: options.readBackChecksum ?? checksum, stdoutBytes: 123 } : {}) };
    };
    return { execute, requests };
}
function operation(name: string) {
    const result = Reflect.get(owners, name);
    expect(result, `${name} must execute the actual native contract`).toBeTypeOf('function');
    return result;
}
const input = (native: ReturnType<typeof boundary>) => ({ environmentId, configuration, access,
    signal: new AbortController().signal, execute: native.execute });
const verification = { kind: 'verified' as const, level: 'manifestReadBack' as const, manifest };

describe('selected repository backup operations', () => {
    it('lists only exact Environment snapshots with native size and exact receipt verification, in one scoped inventory read', async () => {
        const native = boundary({ inventory: [rawSnapshot(), rawSnapshot(otherId)] });
        const result = await operation('inventoryDeploymentBackupsV1')({ ...input(native), verificationEvidence: [manifest] });
        expect(result).toMatchObject({ kind: 'listed', entries: [
            { snapshot: { snapshotId }, sourceId: 'main', kind: 'dump', totalBytesProcessed: 123, verified: true },
            { snapshot: { snapshotId: otherId }, sourceId: 'main', kind: 'dump', totalBytesProcessed: 123, verified: false },
        ] });
        const snapshots = native.requests.filter(request => request.argv.includes('snapshots'));
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.argv).toEqual(expect.arrayContaining(['--host', 'happier-env-environment-a', '--tag', 'happier,env:environment-a']));
        expect(native.requests.some(request => request.argv.some(arg => ['backup', 'forget', 'prune', 'dump'].includes(arg)))).toBe(false);
    });

    it('never presents foreign inventory or a matching snapshot from another repository as verified', async () => {
        const native = boundary({ repository: otherId });
        expect(await operation('inventoryDeploymentBackupsV1')({ ...input(native), verificationEvidence: [manifest] }))
            .toMatchObject({ entries: [{ verified: false }] });
        const foreign = boundary({ inventory: [{ ...rawSnapshot(), hostname: 'happier-env-foreign' }] });
        await expect(operation('inventoryDeploymentBackupsV1')(input(foreign))).rejects.toMatchObject({ code: 'backup_integrity_failed', step: 'inventory' });
    });

    it('preserves historical verification and leaves absent native size unknown when no exact receipt supplies it', async () => {
        const withoutSummary = { ...rawSnapshot(), summary: undefined };
        const native = boundary({ inventory: [withoutSummary, { ...withoutSummary, id: otherId }] });
        const result = await operation('inventoryDeploymentBackupsV1')({ ...input(native),
            configuration: { ...configuration, configRevision: 2 }, verificationEvidence: [manifest] });
        expect(result.entries[0]).toMatchObject({ verified: true, totalBytesProcessed: 123, manifest });
        expect(result.entries[1]).toMatchObject({ verified: false });
        expect(result.entries[1]).not.toHaveProperty('totalBytesProcessed');
    });

    it('verifies the exact receipt snapshot/tree and payload before an optional repository check, without mutations', async () => {
        const native = boundary();
        const result = await operation('verifyDeploymentBackupV1')({ ...input(native), configRevision: 1, manifest, level: 'repositoryCheck' });
        expect(result).toEqual({ kind: 'verified', level: 'repositoryCheck', manifest });
        expect(native.requests.find(request => request.argv.includes('snapshots'))!.argv).toContain(snapshotId);
        expect(native.requests.find(request => request.argv.includes('tree'))!.argv).toContain(treeId);
        expect(native.requests.at(-1)!.argv).toContain('check');
        expect(native.requests.some(request => request.argv.some(arg => ['backup', 'forget', 'prune', 'restore'].includes(arg)))).toBe(false);
    });

    it.each([
        [{ repository: otherId }, 'repository'], [{ inventory: [{ ...rawSnapshot(), tree: otherId }] }, 'snapshot'],
        [{ readBackChecksum: otherId }, 'payload'], [{ fail: 'check' }, 'repositoryCheck'],
    ] as const)('refuses exact verification mismatch/failure at its named step', async (options, step) => {
        const native = boundary(options);
        await expect(operation('verifyDeploymentBackupV1')({ ...input(native), configRevision: 1, manifest, level: 'repositoryCheck' }))
            .rejects.toMatchObject({ code: options.fail ? 'backup_failed' : 'backup_integrity_failed', step });
    });

    it('applies the configured native policy and protects verified and unsettled recovery snapshots before exact forget', async () => {
        const native = boundary();
        const result = await operation('pruneDeploymentBackupsV1')({ ...input(native), verification, protectedSnapshotIds: [protectedId] });
        expect(result).toEqual({ kind: 'pruned', removedSnapshotIds: [otherId] });
        const forget = native.requests.filter(request => request.argv.includes('forget'));
        expect(forget[0]!.argv).toEqual(expect.arrayContaining(['--group-by', 'host,tags', '--keep-last', '2', '--dry-run']));
        expect(forget[1]!.argv).toEqual(['--repo', access.repository, '--json', 'forget', otherId]);
        expect(native.requests.slice(-2).map(request => request.argv.at(-1))).toEqual(['prune', 'check']);
    });

    it('refuses foreign deletion candidates and stale verification before any deletion', async () => {
        const native = boundary({ candidates: [{ ...rawSnapshot(otherId), hostname: 'happier-env-foreign' }] });
        await expect(operation('pruneDeploymentBackupsV1')({ ...input(native), verification, protectedSnapshotIds: [] }))
            .rejects.toMatchObject({ code: 'backup_integrity_failed', step: 'retention' });
        expect(native.requests.some(request => request.argv.includes('forget') && !request.argv.includes('--dry-run'))).toBe(false);
        const stale = boundary();
        await expect(operation('pruneDeploymentBackupsV1')({ ...input(stale), verification: { ...verification,
            manifest: { ...manifest, configRevision: 2 } }, protectedSnapshotIds: [] })).rejects.toMatchObject({ code: 'stale_input', step: 'verification' });
        expect(stale.requests).toEqual([]);
    });

    it('keeps everything without native deletion, and exposes post-forget maintenance failure with exact removed ids', async () => {
        const keep = boundary();
        expect(await operation('pruneDeploymentBackupsV1')({ ...input(keep), configuration: { ...configuration, retention: { kind: 'keepEverything' } },
            verification, protectedSnapshotIds: [] })).toEqual({ kind: 'kept', removedSnapshotIds: [] });
        expect(keep.requests).toEqual([]);
        const partial = boundary({ fail: 'prune' });
        await expect(operation('pruneDeploymentBackupsV1')({ ...input(partial), verification, protectedSnapshotIds: [protectedId] }))
            .rejects.toMatchObject({ code: 'backup_failed', step: 'prune', details: { removedSnapshotIds: [otherId] } });
    });

    it('keeps all protected points and reports uncertain exact deletions without claiming removed data', async () => {
        const protectedOnly = boundary({ candidates: [rawSnapshot(), rawSnapshot(protectedId)] });
        expect(await operation('pruneDeploymentBackupsV1')({ ...input(protectedOnly), verification, protectedSnapshotIds: [protectedId] }))
            .toEqual({ kind: 'kept', removedSnapshotIds: [] });
        expect(protectedOnly.requests.some(request => request.argv.includes('prune'))).toBe(false);
        const native = boundary();
        const execute: DeploymentBackupRunInputV1['execute'] = async request => request.argv.includes('forget') && !request.argv.includes('--dry-run')
            ? { kind: 'outcome_unknown' } : native.execute(request);
        await expect(operation('pruneDeploymentBackupsV1')({ ...input(native), execute, verification, protectedSnapshotIds: [protectedId] }))
            .rejects.toMatchObject({ code: 'outcome_unknown', step: 'forget', details: { removedSnapshotIds: [], uncertainSnapshotIds: [otherId] } });
        expect(native.requests.some(request => request.argv.includes('prune'))).toBe(false);
    });

    it('projects only exact native deletion evidence from maintenance failures without exposing other details', async () => {
        const native = boundary({ fail: 'prune' });
        let failure: unknown;
        try { await operation('pruneDeploymentBackupsV1')({ ...input(native), verification, protectedSnapshotIds: [protectedId] }); }
        catch (error) { failure = error; }
        const read = operation('readDeploymentBackupMaintenanceFailureEvidenceV1');
        expect(read(failure)).toEqual({ removedSnapshotIds: [otherId], uncertainSnapshotIds: [] });
        expect(read({ details: { removedSnapshotIds: [], uncertainSnapshotIds: [snapshotId],
            secret: 'never-return-native-payload' } })).toEqual({ removedSnapshotIds: [], uncertainSnapshotIds: [snapshotId] });
        for (const error of [null, {}, { details: { removedSnapshotIds: ['latest'], uncertainSnapshotIds: [] } },
            { details: { removedSnapshotIds: [], uncertainSnapshotIds: ['repository-password'] } }]) expect(read(error)).toBeUndefined();
    });

    it('distinguishes unavailable/truncated inventory from a successful empty inventory and honors local cancellation', async () => {
        const empty = boundary({ inventory: [] });
        expect(await operation('inventoryDeploymentBackupsV1')(input(empty))).toEqual({ kind: 'listed', repositoryId, entries: [] });
        for (const options of [{ unknown: 'snapshots' }, { truncated: 'snapshots' }]) {
            const native = boundary(options);
            await expect(operation('inventoryDeploymentBackupsV1')(input(native))).rejects.toMatchObject({ code: 'outcome_unknown', step: 'inventory' });
        }
        const cancelled = boundary(), controller = new AbortController(); controller.abort();
        await expect(operation('verifyDeploymentBackupV1')({ ...input(cancelled), signal: controller.signal,
            configRevision: 1, manifest, level: 'manifestReadBack' })).rejects.toMatchObject({ code: 'cancelled' });
        expect(cancelled.requests).toEqual([]);
    });
});
