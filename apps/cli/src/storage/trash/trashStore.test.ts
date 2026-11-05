import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createTrashStore } from './trashStore';
import { measureNativeDisk } from '../measure/nativeDiskMeasure';
import { resolveTrashOsUserId } from './trashStore';
import { writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';
import { createStorageFilesystemAdapter } from './filesystemAdapter';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { sessionFolders } from '../categories/sessionFolders';
import { MachineGuardActivityStoredReadV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';

let disposeNative: (() => Promise<void>) | undefined;
let scratch: string;
const emptySize = { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false };

async function fixture(name: string) {
    const base = join(scratch, name); const home = join(base, 'home'); const source = join(base, 'cache');
    await mkdir(home, { recursive: true }); await mkdir(source);
    await writeFile(join(source, 'bytes'), Buffer.alloc(8192, 9));
    const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction() {} } });
    const deps = { happyHomeDir: home, osUserId: await resolveTrashOsUserId(), target: { machineId: 'machine', serverId: 'home' },
        readVolumes: () => [{ id: 'fixture', mount: scratch }], activityLog,
        attributionFor: (accountId: string) => ({ serverId: 'home', machineId: 'machine', installationId: 'install', accountId }),
        classifyRestorePath: async () => null, readEmptyAfterDays: () => 7 };
    const store = createTrashStore(deps);
    return { base, home, source, activityLog, deps, store,
        prepare: () => store.prepare({ path: source, batchId: name, title: 'Cache', size: emptySize,
            movedBy: { accountId: 'alice', kind: 'person' } }) };
}

describe('Trash with the real filesystem and native measurement', () => {
    beforeAll(async () => {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-trash-test-')));
        disposeNative = await createProcessCustodyFixture();
    });
    afterAll(async () => {
        await disposeNative?.();
        if (scratch) await rm(scratch, { recursive: true, force: true });
    });
    it('moves an item without freeing it and emits its actual measured bytes', async () => {
        const home = join(scratch, 'first', 'home');
        const source = join(scratch, 'first', 'cache');
        await mkdir(home, { recursive: true });
        await mkdir(source);
        await writeFile(join(source, 'bytes'), Buffer.alloc(8192, 7));
        const size = { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false };
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction() {} } });
        const store = createTrashStore({ happyHomeDir: home, osUserId: await resolveTrashOsUserId(), target: { machineId: 'machine', serverId: 'home' },
            readVolumes: () => [{ id: 'fixture', mount: scratch }], activityLog,
            attributionFor: (accountId: string) => ({ serverId: 'home', machineId: 'machine', installationId: 'install', accountId }),
            classifyRestorePath: async () => null, readEmptyAfterDays: () => 7,
        });
        const prepared = await store.prepare({ path: source, batchId: 'batch', title: 'Cache', size,
            movedBy: { accountId: 'alice', kind: 'person' } });
        const entry = await prepared.commit();
        const actual = await measureNativeDisk({ paths: [prepared.payloadPath] });
        expect(entry.size.allocatedBytes).toBe(actual.totalAllocatedBytes);
        expect(entry.size.allocatedBytes).toBeGreaterThan(0);
        expect(await readFile(join(prepared.payloadPath, 'bytes'))).toEqual(Buffer.alloc(8192, 7));
        const receipt = (await activityLog.list({ range: 'today' })).entries[0];
        expect(receipt).toMatchObject({ kind: 'trash_moved', inTrashBytes: actual.totalAllocatedBytes, freedBytes: 0 });
    });
    it('projects changed retention onto existing protected manifests in both Never directions', async () => {
        const f = await fixture('policy-change'); let days: number | null = 7;
        const store = createTrashStore({ ...f.deps, readEmptyAfterDays: () => days });
        const prepared = await store.prepare({ path: f.source, batchId: 'policy', title: 'Cache', size: emptySize, movedBy: { accountId: 'alice', kind: 'person' } });
        const entry = await prepared.commit();
        days = 1; await store.refreshRetention(days);
        expect((await store.list())[0].emptiesAt).toBe(entry.movedAt + 86_400_000);
        days = null; await store.refreshRetention(days);
        expect((await store.read(entry.entryId))?.emptiesAt).toBeNull();
        const raw = JSON.parse(await readFile(join(prepared.payloadPath, '..', 'entry.json'), 'utf8'));
        expect(raw.entry.emptiesAt).toBeNull();
        days = 30; await store.refreshRetention(days);
        const restarted = createTrashStore({ ...f.deps, readEmptyAfterDays: () => days });
        expect((await restarted.list())[0].emptiesAt).toBe(entry.movedAt + 30 * 86_400_000);
    });
    it('finds entries after restart, drops stored unknown fields, and restores byte-identical data', async () => {
        const f = await fixture('restart'); const prepared = await f.prepare(); const entry = await prepared.commit();
        const manifestPath = join(prepared.payloadPath, '..', 'entry.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.futureAuthority = { canDeleteAnything: true }; manifest.entry.future = true;
        await writeProtectedLocalStateFileAtomic(manifestPath, JSON.stringify(manifest));
        const restarted = createTrashStore(f.deps);
        expect(await restarted.list()).toEqual([entry]);
        expect(await restarted.restore({ batchId: 'restart' }, { actorAccountId: 'alice' })).toMatchObject({ outcomes: [{ status: 'restored', path: f.source }] });
        expect(await readFile(join(f.source, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
        expect(await restarted.list()).toEqual([]);
    });
    it.each(['missing', 'malformed', 'mismatched'] as const)('retains a %s manifest without blocking healthy Trash reads or recovery', async kind => {
        const f = await fixture(`unreadable-${kind}`);
        const prepared = await f.prepare();
        const entry = await prepared.commit();
        const incompleteId = 'unfinished-entry';
        const incomplete = join(f.home, 'trash', incompleteId);
        await mkdir(incomplete, { mode: 0o700 });
        await writeFile(join(incomplete, 'payload'), 'unknown retained bytes');
        if (kind !== 'missing') {
            const manifest = JSON.parse(await readFile(join(prepared.payloadPath, '..', 'entry.json'), 'utf8'));
            await writeProtectedLocalStateFileAtomic(join(incomplete, 'entry.json'), kind === 'malformed' ? '{' : JSON.stringify(manifest));
        }
        const recoveringSource = join(f.base, 'recovering');
        await mkdir(recoveringSource); await writeFile(join(recoveringSource, 'bytes'), 'recover these bytes');
        const recovering = await f.store.prepare({ path: recoveringSource, batchId: 'recovery', title: 'Recovering', size: emptySize,
            movedBy: { accountId: 'alice', kind: 'person' } });
        await rename(recoveringSource, recovering.payloadPath);
        const restarted = createTrashStore(f.deps);
        expect(await restarted.list()).toEqual([entry]);
        expect(await restarted.list({ entryIds: [entry.entryId] })).toEqual([entry]);
        await restarted.reconcile();
        expect((await restarted.list()).map(row => row.entryId)).toEqual(expect.arrayContaining([entry.entryId, recovering.entry.entryId]));
        expect(await f.activityLog.read(`${recovering.entry.entryId}-trash_moved`)).not.toBeNull();
        const result = await restarted.empty({}, { actorAccountId: 'alice', custodianAccountId: 'owner' });
        expect(result.outcomes).toEqual(expect.arrayContaining([
            { entryId: entry.entryId, status: 'deleted' },
            { entryId: recovering.entry.entryId, status: 'deleted' },
        ]));
        expect(await readFile(join(incomplete, 'payload'), 'utf8')).toBe('unknown retained bytes');
    });
    it.skipIf(process.platform === 'win32')('roundtrips an invalid UTF-8 POSIX name without touching its replacement-character twin', async context => {
        const f = await fixture('byte-name');
        const path = Buffer.concat([Buffer.from(`${f.base}/invalid-`), Buffer.from([0xff]), Buffer.from('.bin')]);
        const twin = join(f.base, 'invalid-\ufffd.bin');
        try { await writeFile(path, 'exact byte payload'); } catch (error) {
            if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EILSEQ') {
                context.skip('Filesystem rejects non-UTF8 names'); return;
            }
            throw error;
        }
        await writeFile(twin, 'untouched twin');
        const encoded = `bytes:${path.toString('base64')}`;
        const prepared = await f.store.prepare({ path: encoded, batchId: 'byte-name', title: 'Invalid name', size: emptySize,
            movedBy: { accountId: 'alice', kind: 'person' } });
        const entry = await prepared.commit();
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(twin, 'utf8')).toBe('untouched twin');
        const restarted = createTrashStore(f.deps);
        expect((await restarted.list())[0].originalPath).toBe(encoded);
        expect(await restarted.restore({ entryIds: [entry.entryId] }, { actorAccountId: 'alice' }))
            .toMatchObject({ outcomes: [{ status: 'restored', path: encoded }] });
        expect(await readFile(path, 'utf8')).toBe('exact byte payload');
        expect(await readFile(twin, 'utf8')).toBe('untouched twin');
        const second = await restarted.prepare({ path: encoded, batchId: 'byte-empty', title: 'Invalid name', size: emptySize,
            movedBy: { accountId: 'alice', kind: 'person' } });
        const again = await second.commit();
        await writeFile(path, 'occupied exact bytes');
        const beside = Buffer.concat([path, Buffer.from(' (restored)')]); const encodedBeside = `bytes:${beside.toString('base64')}`;
        expect(await restarted.restore({ entryIds: [again.entryId] }, { actorAccountId: 'alice', beside: true }))
            .toMatchObject({ outcomes: [{ status: 'restored', path: encodedBeside }] });
        expect(await readFile(path, 'utf8')).toBe('occupied exact bytes');
        expect(await readFile(beside, 'utf8')).toBe('exact byte payload');
        const final = await restarted.prepare({ path: encodedBeside, batchId: 'byte-empty', title: 'Invalid beside name', size: emptySize,
            movedBy: { accountId: 'alice', kind: 'person' } });
        const discarded = await final.commit();
        expect(await restarted.empty({ entryIds: [discarded.entryId] }, { actorAccountId: 'alice', custodianAccountId: 'owner' }))
            .toMatchObject({ outcomes: [{ status: 'deleted' }] });
        await expect(lstat(beside)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(path, 'utf8')).toBe('occupied exact bytes');
        expect(await readFile(twin, 'utf8')).toBe('untouched twin');
    });
    it.each(['restore', 'empty'] as const)('consumes admitted Manage entry authority for %s across Accounts', async operation => {
        const f = await fixture(`manage-${operation}`); const prepared = await f.prepare(); await prepared.commit();
        const input = { actorAccountId: 'manager', custodianAccountId: 'owner', assertEntryAuthority: async () => {} };
        const result = operation === 'restore' ? await f.store.restore({}, input) : await f.store.empty({}, input);
        expect(result.outcomes).toMatchObject([{ status: operation === 'restore' ? 'restored' : 'deleted' }]);
        if (operation === 'restore') expect(await readFile(join(f.source, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
        else await expect(lstat(prepared.payloadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses another Account before restore or early empty; the custodian may empty', async () => {
        const f = await fixture('shared'); const prepared = await f.prepare(); await prepared.commit();
        expect(await f.store.restore({}, { actorAccountId: 'bob', custodianAccountId: 'owner' })).toMatchObject({ outcomes: [{ status: 'refused' }] });
        expect(await f.store.empty({}, { actorAccountId: 'bob', custodianAccountId: 'owner' })).toMatchObject({ freedBytes: 0, outcomes: [{ status: 'refused' }] });
        expect(await readFile(join(prepared.payloadPath, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
        const result = await f.store.empty({}, { actorAccountId: 'owner', custodianAccountId: 'owner' });
        expect(result.outcomes).toMatchObject([{ status: 'deleted' }]); expect(result.freedBytes).toBeGreaterThan(0);
        expect((await f.activityLog.list({ range: 'today' })).entries.find(row => row.kind === 'trash_emptied'))
            .toMatchObject({ attribution: { accountId: 'owner' }, freedBytes: result.freedBytes });
        const moved = await f.activityLog.read(`${prepared.entry.entryId}-trash_moved`);
        expect(moved?.wayBack ?? []).toEqual([]);
        expect(moved?.inTrashBytes).toBe(0);
    });
    it('never overwrites, permits the one beside destination, and refuses a missing parent', async () => {
        const f = await fixture('beside'); const prepared = await f.prepare(); await prepared.commit();
        await mkdir(f.source); await writeFile(join(f.source, 'new'), 'keep');
        expect(await f.store.restore({}, { actorAccountId: 'alice' })).toMatchObject({ outcomes: [{ status: 'refused' }] });
        expect(await f.store.restore({}, { actorAccountId: 'alice', beside: true })).toMatchObject({ outcomes: [{ status: 'restored', path: `${f.source} (restored)` }] });
        expect(await readFile(join(f.source, 'new'), 'utf8')).toBe('keep');
        const second = await fixture('missing-parent'); const moved = await second.prepare(); await moved.commit();
        await rename(second.base, `${second.base}-gone`);
        const restarted = createTrashStore({ ...second.deps, happyHomeDir: join(`${second.base}-gone`, 'home') });
        expect(await restarted.restore({}, { actorAccountId: 'alice' })).toMatchObject({ outcomes: [{ status: 'refused' }] });
    });
    it('does not follow a symlink leaf and can empty read-only nested directories', async () => {
        const f = await fixture('permissions'); const outside = join(f.home, 'retained'); await writeFile(outside, 'retained');
        await mkdir(join(f.source, 'nested')); await writeFile(join(f.source, 'nested', 'readonly'), 'bytes');
        await chmod(join(f.source, 'nested'), 0o555);
        await symlink(outside, join(f.source, 'link'));
        const prepared = await f.prepare(); await prepared.commit();
        expect(await f.store.empty({}, { actorAccountId: 'alice', custodianAccountId: 'owner' })).toMatchObject({ outcomes: [{ status: 'deleted' }] });
        expect(await readFile(outside, 'utf8')).toBe('retained');
        const leaf = join(f.base, 'leaf'); await symlink(outside, leaf);
        const moved = await f.store.prepare({ path: leaf, batchId: 'leaf', title: 'Link', size: emptySize, movedBy: { accountId: 'alice', kind: 'person' } });
        await moved.commit(); expect((await lstat(moved.payloadPath)).isSymbolicLink()).toBe(true);
        await f.store.empty({}, { actorAccountId: 'alice', custodianAccountId: 'owner' });
        expect(await readFile(outside, 'utf8')).toBe('retained');
    });
    it('reconciles a prepared payload and a crash after the empty commit point without inventing freed bytes', async () => {
        const f = await fixture('crash'); const prepared = await f.prepare();
        const restarted = createTrashStore(f.deps);
        let changes = 0;
        const release = restarted.subscribe(() => { changes++; });
        await rename(f.source, prepared.payloadPath); await restarted.reconcile();
        expect((await restarted.list())[0]?.size.allocatedBytes).toBeGreaterThan(0);
        expect(changes).toBe(1);
        await restarted.reconcile();
        expect(changes, 'reconciled retained bytes must not invalidate their observers again').toBe(1);
        const path = join(prepared.payloadPath, '..', 'entry.json'); const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.phase = 'emptying'; await writeProtectedLocalStateFileAtomic(path, JSON.stringify(manifest));
        await rm(prepared.payloadPath, { recursive: true }); await restarted.reconcile();
        expect(await restarted.list()).toEqual([]);
        expect((await f.activityLog.list({ range: 'today' })).entries.filter(row => row.kind === 'trash_emptied')).toHaveLength(1);
        expect(changes).toBe(2);
        await restarted.reconcile();
        expect(changes, 'an empty Trash reconciliation must also remain silent').toBe(2);
        release();
    });
    it('rejects an identity swap, but a growing item moves with the grown receipt size', async () => {
        const f = await fixture('identity'); const prepared = await f.prepare();
        await rename(f.source, `${f.source}-original`); await mkdir(f.source);
        await expect(prepared.commit()).rejects.toMatchObject({ code: 'changed_since_review' });
        const growing = await fixture('growing'); const move = await growing.prepare();
        await writeFile(join(growing.source, 'bytes'), Buffer.alloc(32768, 8));
        const entry = await move.commit();
        expect(entry.size.allocatedBytes).toBeGreaterThanOrEqual(32768);
        expect(await readFile(join(move.payloadPath, 'bytes'))).toEqual(Buffer.alloc(32768, 8));
    });
    it('rechecks authority immediately before effects and leaves payloads untouched when admission expires', async () => {
        const f = await fixture('expired'); const prepared = await f.prepare(); await prepared.commit();
        const denied = async () => { throw Object.assign(new Error('Admission expired'), { code: 'unauthorized' }); };
        expect(await f.store.empty({}, { actorAccountId: 'alice', custodianAccountId: 'owner', assertCurrentAuthority: denied }))
            .toMatchObject({ outcomes: [{ status: 'refused' }], freedBytes: 0 });
        expect(await readFile(join(prepared.payloadPath, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
        expect(await f.store.restore({}, { actorAccountId: 'alice', assertCurrentAuthority: denied }))
            .toMatchObject({ outcomes: [{ status: 'refused' }] });
        expect(await readFile(join(prepared.payloadPath, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
    });
    it('derives both root kinds afresh from current mounted volumes without a roots file', async () => {
        const f = await fixture('volumes'); const other = join(f.base, 'other-volume'); await mkdir(other);
        const source = join(other, 'bytes'); await writeFile(source, Buffer.alloc(8192, 4));
        const deps = { ...f.deps, readVolumes: () => [{ id: 'fixture', mount: scratch }, { id: 'second', mount: other }] };
        const store = createTrashStore(deps);
        const moved = await store.prepare({ path: source, batchId: 'second-volume', title: 'Bytes', size: emptySize,
            movedBy: { accountId: 'alice', kind: 'person' } });
        await moved.commit();
        const restarted = createTrashStore(deps);
        expect((await restarted.list({ volumeId: 'second' })).map(entry => entry.volumeId)).toEqual(['second']);
        expect((await restarted.roots()).find(root => root.volumeId === 'second')?.path)
            .toBe(process.platform === 'win32' ? join(other, '.happier-trash', deps.osUserId) : join(other, `.happier-trash-${deps.osUserId}`));
        expect(await restarted.restore({ volumeId: 'second' }, { actorAccountId: 'alice' })).toMatchObject({ outcomes: [{ status: 'restored' }] });
        expect(await readFile(source)).toEqual(Buffer.alloc(8192, 4));
    });
    it('exposes an Activity write failure and recovers its receipt from the protected manifest', async () => {
        const f = await fixture('receipt-failure'); const prepared = await f.prepare();
        const log = join(f.home, 'machine-guard'); const retained = `${log}-retained`;
        const wrong = join(f.base, 'wrong-log'); await mkdir(wrong);
        await rename(log, retained); await symlink(wrong, log, process.platform === 'win32' ? 'junction' : 'dir');
        await expect(prepared.commit()).rejects.toThrow();
        expect(await readFile(join(prepared.payloadPath, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
        await unlink(log); await rename(retained, log);
        await f.store.reconcile(); await f.store.reconcile();
        expect((await f.activityLog.list({ range: 'today' })).entries.filter(row => row.kind === 'trash_moved')).toHaveLength(1);
    });
    it('does not reconcile away a preparation still owned by the current store', async () => {
        const f = await fixture('live-preparation'); const prepared = await f.prepare();
        await f.store.reconcile(); await prepared.commit();
        expect((await f.store.list()).map(entry => entry.entryId)).toEqual([prepared.entry.entryId]);
    });
    it('refuses a payload identity replacement without restoring or deleting its replacement', async () => {
        const f = await fixture('payload-identity'); const prepared = await f.prepare(); await prepared.commit();
        await rename(prepared.payloadPath, `${prepared.payloadPath}-retained`);
        await mkdir(prepared.payloadPath); await writeFile(join(prepared.payloadPath, 'replacement'), 'keep');
        expect(await f.store.restore({}, { actorAccountId: 'alice' }))
            .toMatchObject({ outcomes: [{ status: 'refused', reason: { code: 'changed_since_review' } }] });
        expect(await f.store.empty({}, { actorAccountId: 'alice', custodianAccountId: 'owner' }))
            .toMatchObject({ outcomes: [{ status: 'refused', reason: { code: 'changed_since_review' } }], freedBytes: 0 });
        expect(await readFile(join(prepared.payloadPath, 'replacement'), 'utf8')).toBe('keep');
    });
    it('rechecks trusted entry scope after restart before restore or empty effects', async () => {
        const f = await fixture('entry-scope');
        const ownerData = { sessionId: 'trusted-session' };
        const deps = { ...f.deps, resolveOwnerAdapter: () => createStorageFilesystemAdapter({ sourcePath: f.source, allowedRoot: f.base, ownerData }) };
        const store = createTrashStore(deps);
        const prepared = await store.prepare({ path: f.source, batchId: 'scope', title: 'Cache', size: emptySize,
            categoryId: 'sessionFolders', movedBy: { accountId: 'alice', kind: 'person' }, ownerData });
        await prepared.commit(); const restarted = createTrashStore(deps);
        const assertEntryAuthority = async (_entry: unknown, data?: unknown) => {
            expect(data).toEqual(ownerData);
            throw Object.assign(new Error('Scope no longer admitted'), { code: 'unauthorized' });
        };
        expect(await restarted.restore({}, { actorAccountId: 'alice', assertEntryAuthority }))
            .toMatchObject({ outcomes: [{ status: 'refused', reason: { code: 'unauthorized' } }] });
        expect(await restarted.empty({}, { actorAccountId: 'alice', custodianAccountId: 'owner', assertEntryAuthority }))
            .toMatchObject({ outcomes: [{ status: 'refused', reason: { code: 'unauthorized' } }], freedBytes: 0 });
        expect(await readFile(join(prepared.payloadPath, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
    });
    it('scheduled empty waits for the configured age and leaves Never entries intact', async () => {
        const f = await fixture('scheduled'); let at = Date.now();
        const store = createTrashStore({ ...f.deps, nowMs: () => at });
        const input = { path: f.source, batchId: 'scheduled', title: 'Cache', size: emptySize,
            movedBy: { accountId: 'alice', kind: 'person' as const } };
        const prepared = await store.prepare(input); const entry = await prepared.commit();
        expect(await store.empty({}, { actorAccountId: 'owner', custodianAccountId: 'owner', scheduled: true }))
            .toMatchObject({ outcomes: [{ status: 'refused' }], freedBytes: 0 });
        at = entry.emptiesAt!;
        expect(await store.empty({}, { actorAccountId: 'owner', custodianAccountId: 'owner', scheduled: true }))
            .toMatchObject({ outcomes: [{ status: 'deleted' }] });
        const never = await fixture('never');
        const neverStore = createTrashStore({ ...never.deps, nowMs: () => at, readEmptyAfterDays: () => null });
        const retained = await neverStore.prepare({ ...input, path: never.source }); await retained.commit();
        at += 100 * 86_400_000;
        expect(await neverStore.empty({}, { actorAccountId: 'owner', custodianAccountId: 'owner', scheduled: true }))
            .toMatchObject({ outcomes: [{ status: 'refused' }], freedBytes: 0 });
        expect(await readFile(join(retained.payloadPath, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
    });
    it('reconciles restored session bytes through the canonical owner before marking the move undone', async () => {
        const f = await fixture('managed-restore-crash');
        const owner = createManagedSessionDirectories({ activeServerDir: f.home });
        const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'crash-tag' });
        await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
        await writeFile(join(allocation.directory, 'bytes'), 'session bytes');
        const ownerData = { kind: 'allocation', allocationId: allocation.allocationId };
        const categoryDeps = { happyHomeDir: f.home, activeServerDir: f.home, managedSessionDirectories: owner };
        const deps = { ...f.deps, resolveOwnerAdapter: (_category: unknown, data: Parameters<NonNullable<typeof sessionFolders.adapterForEntry>>[0]) => sessionFolders.adapterForEntry!(data, categoryDeps) };
        const store = createTrashStore(deps);
        const prepared = await store.prepare({ path: allocation.directory, batchId: 'managed', title: 'Session folder', size: emptySize,
            categoryId: 'sessionFolders', ownerData, movedBy: { accountId: 'alice', kind: 'person' } });
        const adapter = await sessionFolders.adapterForEntry!(ownerData, categoryDeps);
        await prepared.commit(adapter.retire);
        const manifestPath = join(prepared.payloadPath, '..', 'entry.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.phase = 'restoring'; manifest.restorePath = allocation.directory;
        await writeProtectedLocalStateFileAtomic(manifestPath, JSON.stringify(manifest));
        await rename(prepared.payloadPath, allocation.directory);
        expect((await owner.listRecords({ includeTrashed: true }))[0]?.inTrash).toBeDefined();
        const restarted = createTrashStore(deps); await restarted.reconcile();
        expect((await owner.listRecords({ includeTrashed: true }))[0]?.inTrash).toBeUndefined();
        expect(await owner.resolveForSession({ sessionId: 'session', path: allocation.directory })).toMatchObject({ ok: true });
        expect(await readFile(join(allocation.directory, 'bytes'), 'utf8')).toBe('session bytes');
        expect(await restarted.list()).toEqual([]);
        expect((await f.activityLog.read(`${prepared.entry.entryId}-trash_moved`))?.undoneAt).toBeDefined();
    });
    it('empties a retired Session folder and settles its canonical owner after payload removal', async () => {
        const f = await fixture('managed-empty');
        const owner = createManagedSessionDirectories({ activeServerDir: f.home });
        const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'empty-tag' });
        await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
        await writeFile(join(allocation.directory, 'bytes'), 'session bytes');
        const ownerData = { kind: 'allocation', allocationId: allocation.allocationId };
        const categoryDeps = { happyHomeDir: f.home, activeServerDir: f.home, managedSessionDirectories: owner };
        const store = createTrashStore({ ...f.deps,
            resolveOwnerAdapter: (_category, data) => sessionFolders.adapterForEntry!(data, categoryDeps) });
        const prepared = await store.prepare({ path: allocation.directory, batchId: 'managed', title: 'Session folder', size: emptySize,
            categoryId: 'sessionFolders', ownerData, movedBy: { accountId: 'alice', kind: 'person' } });
        const adapter = await sessionFolders.adapterForEntry!(ownerData, categoryDeps);
        await prepared.commit(adapter.retire);
        const result = await store.empty({ entryIds: [prepared.entry.entryId] }, { actorAccountId: 'alice', custodianAccountId: 'owner' });
        expect(result, JSON.stringify(result)).toMatchObject({ outcomes: [{ entryId: prepared.entry.entryId, status: 'deleted' }] });
        expect(await owner.listRecords({ includeTrashed: true })).toEqual([]);
        expect(await store.list()).toEqual([]);
        expect(await f.activityLog.read(`${prepared.entry.entryId}-trash_emptied`)).toMatchObject({ outcome: 'done' });
    });
    it('finishes the canonical session owner after an empty crash at the payload deletion commit point', async () => {
        const f = await fixture('managed-empty-crash');
        const owner = createManagedSessionDirectories({ activeServerDir: f.home });
        const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'empty-crash-tag' });
        await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
        await writeFile(join(allocation.directory, 'bytes'), 'session bytes');
        const ownerData = { kind: 'allocation', allocationId: allocation.allocationId };
        const categoryDeps = { happyHomeDir: f.home, activeServerDir: f.home, managedSessionDirectories: owner };
        const deps = { ...f.deps, resolveOwnerAdapter: (_category: unknown, data: Parameters<NonNullable<typeof sessionFolders.adapterForEntry>>[0]) => sessionFolders.adapterForEntry!(data, categoryDeps) };
        const store = createTrashStore(deps);
        const prepared = await store.prepare({ path: allocation.directory, batchId: 'managed', title: 'Session folder', size: emptySize,
            categoryId: 'sessionFolders', ownerData, movedBy: { accountId: 'alice', kind: 'person' } });
        const adapter = await sessionFolders.adapterForEntry!(ownerData, categoryDeps); await prepared.commit(adapter.retire);
        const manifestPath = join(prepared.payloadPath, '..', 'entry.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.phase = 'emptying'; await writeProtectedLocalStateFileAtomic(manifestPath, JSON.stringify(manifest));
        await rm(prepared.payloadPath, { recursive: true });
        const log = join(f.home, 'machine-guard'); const retainedLog = `${log}-retained`;
        const wrongLog = join(f.base, 'wrong-log'); await mkdir(wrongLog);
        await rename(log, retainedLog); await symlink(wrongLog, log, process.platform === 'win32' ? 'junction' : 'dir');
        const restarted = createTrashStore(deps);
        await expect(restarted.reconcile()).rejects.toThrow();
        expect(await owner.listRecords({ includeTrashed: true })).toEqual([]);
        await unlink(log); await rename(retainedLog, log);
        await restarted.reconcile(); await restarted.reconcile();
        expect(await restarted.list()).toEqual([]);
        expect((await f.activityLog.list({ range: 'today' })).entries.filter(entry => entry.kind === 'trash_emptied')).toHaveLength(1);
    });
    it('finishes session retirement bookkeeping before publishing an interrupted prepared payload as moved', async () => {
        const f = await fixture('managed-retire-crash');
        const owner = createManagedSessionDirectories({ activeServerDir: f.home });
        const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'retire-crash-tag' });
        await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
        await writeFile(join(allocation.directory, 'bytes'), 'session bytes');
        const ownerData = { kind: 'allocation', allocationId: allocation.allocationId };
        const categoryDeps = { happyHomeDir: f.home, activeServerDir: f.home, managedSessionDirectories: owner };
        const deps = { ...f.deps, resolveOwnerAdapter: (_category: unknown, data: Parameters<NonNullable<typeof sessionFolders.adapterForEntry>>[0]) => sessionFolders.adapterForEntry!(data, categoryDeps) };
        const prepared = await createTrashStore(deps).prepare({ path: allocation.directory, batchId: 'managed', title: 'Session folder', size: emptySize,
            categoryId: 'sessionFolders', ownerData, movedBy: { accountId: 'alice', kind: 'person' } });
        await rename(allocation.directory, prepared.payloadPath);
        const restarted = createTrashStore(deps); await restarted.reconcile();
        expect((await owner.listRecords({ includeTrashed: true }))[0]?.inTrash).toEqual({ payloadPath: prepared.payloadPath });
        expect((await restarted.list()).map(entry => entry.entryId)).toEqual([prepared.entry.entryId]);
        expect(await f.activityLog.read(`${prepared.entry.entryId}-trash_moved`)).not.toBeNull();
    });
    it.skipIf(process.platform !== 'linux')('keeps a mounted second-filesystem payload and its Trash root on that same device', async (context) => {
        const mountedPath = await realpath('/dev/shm').catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        });
        const mount = mountedPath ? await lstat(mountedPath) : null;
        if (!mount || mount.dev === (await lstat(scratch)).dev) { context.skip(); return; }
        const second = await realpath(await mkdtemp(join(mountedPath!, 'happier-trash-second-')));
        try {
            const f = await fixture('physical-volume'); const source = join(second, 'bytes');
            await writeFile(source, Buffer.alloc(8192, 5));
            const deps = { ...f.deps, readVolumes: () => [{ id: 'fixture', mount: scratch }, { id: 'second-physical', mount: second }] };
            const store = createTrashStore(deps);
            const prepared = await store.prepare({ path: source, batchId: 'physical-volume', title: 'Second filesystem', size: emptySize,
                movedBy: { accountId: 'alice', kind: 'person' } });
            await prepared.commit();
            expect((await lstat(prepared.payloadPath)).dev).toBe(mount.dev);
            expect((await lstat(prepared.payloadPath)).dev).not.toBe((await lstat(f.home)).dev);
            const restarted = createTrashStore(deps);
            expect((await restarted.list({ volumeId: 'second-physical' })).map(entry => entry.entryId)).toEqual([prepared.entry.entryId]);
            expect(await restarted.restore({ volumeId: 'second-physical' }, { actorAccountId: 'alice' })).toMatchObject({ outcomes: [{ status: 'restored' }] });
            expect(await readFile(source)).toEqual(Buffer.alloc(8192, 5));
        } finally { await rm(second, { recursive: true, force: true }); }
    });
    it.each([{ name: 'custodian', historical: false, expected: { accountId: 'owner' } },
        { name: 'historical', historical: true, expected: { kind: 'unknown' } }])('recovers $name restore receipt attribution without inventing a mover actor', async ({ name, historical, expected }) => {
        const f = await fixture(`restore-actor-${name}`); const prepared = await f.prepare(); await prepared.commit();
        const log = join(f.home, 'machine-guard'); const retained = `${log}-retained`;
        const wrong = join(f.base, 'wrong-log'); await mkdir(wrong);
        await rename(log, retained); await symlink(wrong, log, process.platform === 'win32' ? 'junction' : 'dir');
        expect(await f.store.restore({}, { actorAccountId: 'owner', custodianAccountId: 'owner' }))
            .toMatchObject({ outcomes: [{ status: 'failed' }] });
        expect(await readFile(join(f.source, 'bytes'))).toEqual(Buffer.alloc(8192, 9));
        if (historical) {
            const path = join(prepared.payloadPath, '..', 'entry.json'); const manifest = JSON.parse(await readFile(path, 'utf8'));
            delete manifest.restoreAttribution; await writeProtectedLocalStateFileAtomic(path, JSON.stringify(manifest));
        }
        await unlink(log); await rename(retained, log);
        await createTrashStore(f.deps).reconcile();
        const rows = (await Promise.all((await readdir(log)).filter(path => path.endsWith('.jsonl'))
            .map(async path => (await readFile(join(log, path), 'utf8')).split('\n').filter(Boolean)
                .map(line => MachineGuardActivityStoredReadV1Schema.parse(JSON.parse(line) as unknown))))).flat();
        expect(rows.find(row => row.kind === 'undone' && row.ref === `${prepared.entry.entryId}-trash_moved`))
            .toMatchObject({ attribution: expected });
    });
});
