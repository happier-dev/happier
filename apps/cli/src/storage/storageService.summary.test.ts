import * as filesystem from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { HappierStorageSummaryV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { createStoragePolicyFixture } from './storagePolicy.testkit';
import { createStorageService } from './storageService';

// Hold and count only OS boundaries; catalog, measurement and publication stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof filesystem>();
    return { ...actual, readdir: vi.fn(actual.readdir) };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof childProcess>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

let scratch: string;
let disposeNative: () => Promise<void>;
beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'storage-summary-')));
    disposeNative = await createProcessCustodyFixture({ repoRoot: resolve(__dirname, '../../../..') });
});
afterAll(async () => { await disposeNative?.(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
async function fixture(name: string) {
    const home = join(scratch, name); const cache = join(home, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'bytes'), Buffer.alloc(8192, 1));
    const service = createStorageService({ resourcesPolicy: await createStoragePolicyFixture(),
        catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(home, 'tmp'),
            readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: () => ({ reliable: true, paths: [] }) },
        readVolumes: () => [{ id: 'main', label: 'Main', mount: home, totalBytes: 1_000_000, availableBytes: 500_000 }] });
    return { service, home, cache };
}
async function holdDirectory(path: string, fail?: () => boolean) {
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    const entered = deferred(); const release = deferred();
    const read = vi.mocked(filesystem.readdir);
    read.mockImplementation(async (...args: Parameters<typeof filesystem.readdir>) => {
        if (String(args[0]) === path) {
            entered.resolve(); await release.promise;
            if (fail?.()) throw Object.assign(new Error(`EIO: private path ${path}`), { code: 'EIO' });
        }
        return actual.readdir(...args);
    });
    return { entered, release, restore: () => read.mockImplementation(actual.readdir) };
}
const measurements = () => vi.mocked(childProcess.spawn).mock.calls.filter(([, args]) => args?.[0] === 'disk-measure').length;

it('returns prior figures while dirty sizing is held, shares one measurement and publishes fresh figures exactly once', async () => {
    const { service, cache } = await fixture('dirty');
    const before = await service.refresh();
    await writeFile(join(cache, 'bytes'), Buffer.alloc(65536, 2));
    service.invalidate();
    const hold = await holdDirectory(cache);
    let publications = 0;
    const published = deferred();
    const off = service.subscribe(() => { publications++; published.resolve(); });
    let reads: Promise<unknown>[] = [];
    try {
        const completed: unknown[] = [];
        const start = measurements();
        reads = Array.from({ length: 3 }, () => service.summary().then(value => { completed.push(value); return value; }));
        await hold.entered.promise;
        await nextTurn();
        expect(completed, 'all reads settle before the held filesystem measurement').toHaveLength(3);
        for (const summary of completed) expect(HappierStorageSummaryV1Schema.parse(summary)).toMatchObject({
            sizedAt: before.sizedAt, categories: before.categories, measurement: { status: 'measuring', hasMeasured: true },
        });
        expect(publications).toBe(0);
        hold.release.resolve(); await published.promise; await nextTurn();
        const fresh = HappierStorageSummaryV1Schema.parse(await service.summary());
        expect(fresh.measurement).toEqual({ status: 'ready' });
        expect(fresh.revision).toBeGreaterThan(HappierStorageSummaryV1Schema.parse(completed[0]).revision);
        expect(fresh.volumes[0]!.happierBytes).toBeGreaterThan(before.volumes[0]!.happierBytes);
        expect(measurements() - start).toBe(1);
        for (let index = 0; index < 3; index++) await service.summary();
        expect(measurements() - start).toBe(1);
        expect(publications).toBe(1);
    } finally {
        hold.release.resolve(); await Promise.allSettled(reads);
        hold.restore(); off(); service.dispose();
    }
});

it.each([false, true])('settles failed background work without read retries (prior measurement: %s), then recovers on explicit demand', async hasMeasured => {
    const { service, cache } = await fixture(`failure-${hasMeasured}`);
    if (hasMeasured) { await service.refresh(); service.invalidate(); }
    let failing = true;
    const hold = await holdDirectory(cache, () => failing);
    const published = deferred(); let publications = 0;
    const off = service.subscribe(() => { publications++; published.resolve(); });
    try {
        expect((await service.summary()).measurement).toEqual({ status: 'measuring', hasMeasured });
        await hold.entered.promise; hold.release.resolve(); await published.promise;
        for (let index = 0; index < 3; index++) {
            const failure = (await service.summary()).measurement;
            expect(failure).toEqual({ status: 'failed', hasMeasured, error: expect.any(String) });
            expect(JSON.stringify(failure)).not.toContain(cache);
        }
        expect(publications).toBe(1);
        failing = false;
        if (hasMeasured) {
            expect((await service.categoryList('caches')).items[0]?.size.allocatedBytes).toBeGreaterThan(0);
            expect((await service.summary()).measurement).toEqual({ status: 'ready' });
        } else expect((await service.refresh()).measurement).toEqual({ status: 'ready' });
        expect(publications).toBe(2);
    } finally { hold.release.resolve(); hold.restore(); off(); service.dispose(); }
});

it('keeps an in-flight refresh alive for a summary reader after its explicit waiter leaves', async () => {
    const { service, cache } = await fixture('reader-lifetime');
    await service.refresh();
    const hold = await holdDirectory(cache); const controller = new AbortController();
    const published = deferred(); const off = service.subscribe(published.resolve);
    let refresh: Promise<unknown> | undefined;
    try {
        refresh = service.refresh({ signal: controller.signal }).catch(error => error);
        await hold.entered.promise;
        expect((await service.summary()).measurement).toEqual({ status: 'measuring', hasMeasured: true });
        controller.abort(); hold.release.resolve();
        expect(await refresh).toMatchObject({ name: 'AbortError' });
        await published.promise;
        expect((await service.summary()).measurement).toEqual({ status: 'ready' });
    } finally { hold.release.resolve(); await refresh; hold.restore(); off(); service.dispose(); }
});

it('returns typed first-measurement progress without publishing a measured zero', async () => {
    const { service, cache } = await fixture('cold');
    const hold = await holdDirectory(cache); const settled = deferred();
    const off = service.subscribe(settled.resolve);
    let read: Promise<unknown> | undefined;
    try {
        const completed: unknown[] = [];
        read = service.summary().then(value => { completed.push(value); return value; });
        await hold.entered.promise; await nextTurn();
        expect(completed).toHaveLength(1);
        expect(HappierStorageSummaryV1Schema.parse(completed[0])).toMatchObject({
            measurement: { status: 'measuring', hasMeasured: false }, categories: [], suggestionsTop: [],
        });
        hold.release.resolve(); await settled.promise; await nextTurn();
        expect(HappierStorageSummaryV1Schema.parse(await service.summary())).toMatchObject({
            measurement: { status: 'ready' }, volumes: [{ happierBytes: expect.any(Number) }],
        });
    } finally { hold.release.resolve(); await read; hold.restore(); off(); service.dispose(); }
});

it('retains the measured snapshot cursor when sizing settles during actor disclosure', async () => {
    const { service, cache } = await fixture('disclosure-cursor');
    await service.refresh(); service.invalidate();
    const hold = await holdDirectory(cache); const published = deferred();
    const entered = deferred(); const release = deferred();
    const off = service.subscribe(published.resolve);
    let read: ReturnType<typeof service.summary> | undefined;
    try {
        read = service.summary({ actor: { accountId: 'owner', custodianAccountId: 'owner', kind: 'person',
            assertCurrent: async () => { entered.resolve(); await release.promise; }, assertCurrentAuthority: async () => {} } });
        await Promise.all([hold.entered.promise, entered.promise]);
        hold.release.resolve(); await published.promise; release.resolve();
        const disclosed = await read;
        expect(disclosed.measurement).toEqual({ status: 'measuring', hasMeasured: true });
        expect(disclosed.revision, 'a watch on this cursor must still see the sizing completion').toBeLessThan(service.revision());
        expect((await service.summary()).measurement).toEqual({ status: 'ready' });
    } finally { release.resolve(); hold.release.resolve(); await read; hold.restore(); off(); service.dispose(); }
});
