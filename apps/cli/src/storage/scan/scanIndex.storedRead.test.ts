import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStorageScanIndex } from './scanIndex';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';

it('drops retired scan state and node fields when reopening the stored index', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-scan-stored-'));
    const volume = { id: 'volume', mountPath: home, usedBytes: 0 };
    let index = createStorageScanIndex({ activeServerDir: home });
    try {
        await index.initialize([volume], true);
        const state = await index.begin({ volumeId: volume.id, root: home, target: { volumeId: volume.id }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        const path = join(home, 'file');
        index.ingest(volume.id, { v: 1, type: 'dir-entry', parent: home,
            node: { id: path, name: 'file', kind: 'file', allocatedBytes: 1, logicalBytes: 1, items: 1, mtimeMs: 1, flags: { atLeast: false } },
            visible: true, retained: false, replaceFacts: false,
        });
        const node = index.readNode(path)!.node;
        index.close();
        const directory = join(home, 'storage', 'scans');
        const filename = (await readdir(directory)).find(file => file.endsWith('.sqlite'))!;
        const database = openProtectedSqliteDatabaseSync(join(directory, filename));
        database.prepare("UPDATE meta SET value=? WHERE key='state'").run(JSON.stringify({ ...state,
            retired: true, target: { ...state.target, retired: true },
        }));
        database.prepare('UPDATE nodes SET data=? WHERE id=?').run(JSON.stringify({ ...node, retired: true, flags: { ...node.flags, retired: true } }), path);
        database.close();
        index = createStorageScanIndex({ activeServerDir: home });
        await index.initialize([volume], true, new Set([state.scanId]));
        expect(index.state()).toEqual(state);
        expect(index.readNode(path)?.node).toEqual(node);
    } finally { index.close(); await rm(home, { recursive: true, force: true }); }
});

it('rejects changed malformed scan state before ingesting another entry, then accepts repaired state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-scan-admission-'));
    const volume = { id: 'volume', mountPath: home, usedBytes: 0 };
    const index = createStorageScanIndex({ activeServerDir: home });
    try {
        await index.initialize([volume], true);
        const state = await index.begin({ volumeId: volume.id, root: home, target: { volumeId: volume.id }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        const entry = (name: string) => ({ v: 1 as const, type: 'dir-entry' as const, parent: home,
            node: { id: join(home, name), name, kind: 'file' as const, allocatedBytes: 0, logicalBytes: 0, items: 1,
                mtimeMs: 1, flags: { atLeast: false } }, visible: true, retained: false, replaceFacts: false });
        index.ingest(volume.id, entry('first'));
        const directory = join(home, 'storage', 'scans');
        const filename = (await readdir(directory)).find(file => file.endsWith('.sqlite'))!;
        const database = openProtectedSqliteDatabaseSync(join(directory, filename));
        try {
            database.prepare("UPDATE meta SET value=? WHERE key='state'").run(JSON.stringify({ ...state, status: 'invalid' }));
            expect(() => index.ingest(volume.id, entry('second'))).toThrow();
            expect(database.prepare('SELECT COUNT(*) AS count FROM entries').get()).toEqual({ count: 1 });
            database.prepare("UPDATE meta SET value=? WHERE key='state'").run(JSON.stringify(state));
            index.ingest(volume.id, entry('second'));
            expect(database.prepare('SELECT COUNT(*) AS count FROM entries').get()).toEqual({ count: 2 });
        } finally { database.close(); }
    } finally { index.close(); await rm(home, { recursive: true, force: true }); }
});

it('reads a stopped legacy invocation counter as the retained target total before resuming', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-scan-retained-'));
    const volume = { id: 'volume', mountPath: home, usedBytes: 0 };
    let index = createStorageScanIndex({ activeServerDir: home });
    try {
        await index.initialize([volume], true);
        const state = await index.begin({ volumeId: volume.id, root: home, target: { folderPath: home }, usedBytes: 0,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        index.ingest(volume.id, { v: 1, type: 'dir', id: home, name: 'root', allocatedBytes: 8192, logicalBytes: 8192,
            items: 2, mtimeMs: 1, flags: { atLeast: true }, children: [], files: [],
            folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 },
            ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false });
        index.close();
        const directory = join(home, 'storage', 'scans');
        const filename = (await readdir(directory)).find(file => file.endsWith('.sqlite'))!;
        const database = openProtectedSqliteDatabaseSync(join(directory, filename));
        database.prepare("UPDATE meta SET value=? WHERE key='state'").run(JSON.stringify({ ...state,
            status: 'cancelled', progress: { sizedBytes: 1024, usedBytes: 0, items: 1 } }));
        database.close();
        index = createStorageScanIndex({ activeServerDir: home });
        await index.initialize([volume], true);
        expect(index.state()?.progress).toEqual({ sizedBytes: 8192, items: 2 });
        expect(index.readView().state?.progress).toEqual(index.state()?.progress);
        const resumed = await index.begin({ volumeId: volume.id, root: home, target: { folderPath: home }, resume: true,
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
        expect(resumed.progress).toEqual({ sizedBytes: 8192, items: 2 });
    } finally { index.close(); await rm(home, { recursive: true, force: true }); }
});
