import { describe, expect, it } from 'vitest';
import * as owner from './manifestV1.js';
const readResticBackupManifestV1 = (...args: unknown[]) => {
    const implementation = Reflect.get(owner, 'readResticBackupManifestV1');
    expect(implementation, 'readResticBackupManifestV1 is the required owner behavior').toBeTypeOf('function');
    const [input] = args;
    const raw = input as typeof manifestInput;
    return implementation({ ...raw, summary: owner.readResticBackupSummaryV1(raw.backupStdout, raw.backupExitCode),
        snapshots: owner.readResticSnapshotsV1(raw.snapshotsStdout, raw.snapshotsExitCode) });
};
const readResticRepositoryConfigV1 = (...args: unknown[]) => {
    const implementation = Reflect.get(owner, 'readResticRepositoryConfigV1');
    expect(implementation, 'readResticRepositoryConfigV1 is the required owner behavior').toBeTypeOf('function');
    return implementation(...args);
};
const readResticSnapshotsV1 = (...args: unknown[]) => {
    const implementation = Reflect.get(owner, 'readResticSnapshotsV1');
    expect(implementation, 'readResticSnapshotsV1 is the required owner behavior').toBeTypeOf('function');
    return implementation(...args);
};

const snapshotId = 'a'.repeat(64), treeId = 'b'.repeat(64), repositoryId = 'c'.repeat(64);
// Field names follow restic v0.19.1 internal/ui/backup/json.go and internal/data/snapshot.go.
const nativeSnapshot = { id: snapshotId, short_id: snapshotId.slice(0, 8), tree: treeId, hostname: 'happier-env-env-one',
    time: '2026-10-28T16:00:00Z', paths: ['/db.dump'], tags: ['happier', 'env:env-one', 'kind:dump', 'src:main'] };
const summary = JSON.stringify({ message_type: 'summary', snapshot_id: snapshotId, total_bytes_processed: 123, total_files_processed: 1 });
const manifestInput = { backupStdout: [JSON.stringify({ message_type: 'status', percent_done: 0.5 }), summary].join('\n'),
    backupExitCode: 0, snapshotsStdout: JSON.stringify([nativeSnapshot]), snapshotsExitCode: 0,
    environmentId: 'env-one', sourceId: 'main', kind: 'dump' as const, configRevision: 3, repositoryId,
    producerChecksumSha256: 'd'.repeat(64) };
const input = manifestInput;

describe('native restic evidence', () => {
    it('binds the actual summary to read-back native snapshot/tree/source metadata after both processes succeed', () => {
        expect(readResticBackupManifestV1(input)).toEqual({ schemaVersion: 1, environmentId: 'env-one', sourceId: 'main', kind: 'dump',
            configRevision: 3, repositoryId, snapshot: { snapshotId, treeId, hostname: nativeSnapshot.hostname,
                time: nativeSnapshot.time, paths: ['/db.dump'], tags: nativeSnapshot.tags },
            totalBytesProcessed: 123, totalFilesProcessed: 1, producerChecksumSha256: 'd'.repeat(64) });
        expect(readResticRepositoryConfigV1(JSON.stringify({ version: 2, id: repositoryId, chunker_polynomial: 'abc' }), 0))
            .toEqual({ repositoryId, repositoryVersion: 2 });
        expect(readResticSnapshotsV1('[]', 0)).toEqual([]);
    });

    it('never accepts partial restic exit, dry-run or missing exact identity as successful evidence', () => {
        expect(Reflect.get(owner, 'readResticBackupManifestV1')).toBeTypeOf('function');
        for (const invalid of [{ ...input, backupExitCode: 3 }, { ...input, snapshotsExitCode: 1 },
            { ...input, backupStdout: JSON.stringify({ message_type: 'status', percent_done: 1 }) },
            { ...input, backupStdout: [summary, summary].join('\n') },
            { ...input, backupStdout: JSON.stringify({ message_type: 'summary', snapshot_id: snapshotId, dry_run: true }) },
            { ...input, snapshotsStdout: JSON.stringify([{ ...nativeSnapshot, id: 'e'.repeat(64) }]) },
            { ...input, snapshotsStdout: JSON.stringify([{ ...nativeSnapshot, tags: ['happier', 'env:foreign', 'kind:dump', 'src:main'] }]) },
            { ...input, snapshotsStdout: JSON.stringify([{ ...nativeSnapshot, hostname: 'random-container' }]) }]) {
            expect(() => readResticBackupManifestV1(invalid)).toThrow();
        }
        expect(() => readResticRepositoryConfigV1(JSON.stringify({ version: 1, id: repositoryId }), 0)).toThrow();
        expect(() => readResticRepositoryConfigV1(JSON.stringify({ version: 2, id: repositoryId }), 1)).toThrow();
    });
});
