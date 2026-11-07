import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { expect, it, onTestFinished, vi } from 'vitest';
import { HappierStorageSummaryV1Schema, MachineStorageScanGetResultV1Schema, type MachineStorageScanGetInputV1 } from '@happier-dev/protocol/storage/storageV1';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { createStorageScanIndex } from './scan/scanIndex';
import { createStorageService, type StorageOperationActor } from './storageService';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { measureNativeDisk } from './measure/nativeDiskMeasure';
import { withScmWorktreeMutationActivity } from '@/scm/worktreeMutationActivity';
import { createStoragePolicyFixture } from './storagePolicy.testkit';
import { withStorageReadTrace } from '@/daemon/externalActions/webLatencyTrace';
import { logger } from '@/ui/logger';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Diagnostic instrumentation stays at SQLite/OS boundaries; the real service,
// runner, native parser, index and catalog remain in the measured path.
it.skipIf(process.env.STO13_PROFILE !== '1' && process.env.STO19_PROFILE !== '1')('profiles a retained large tree with a real native scan writer', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { Session } = await import('node:inspector');
    const fixture = await retainedFixture(process.env.STO19_PROFILE === '1' ? 1704 : 568, 8,
        process.env.STO19_WHOLE_VOLUME === '1');
    const target = fixture.children[0];
    const childProcess = await import('node:child_process');
    const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const batchReady = deferred(); const terminal = deferred();
    let scanChild: ReturnType<typeof childProcess.spawn> | undefined; let childClosed = false;
    let scanId: string | undefined;
    const spawn = vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
        const child = actualProcess.spawn(command, args, options);
        if (args?.[0] === 'disk-scan') {
            scanChild = child;
            child.once('close', () => { childClosed = true; });
            child.stdout?.prependOnceListener('data', () => { child.stdout?.pause(); batchReady.resolve(); });
        }
        return child;
    });
    const unsubscribe = fixture.service.subscribe(() => { if (childClosed) terminal.resolve(); });
    const disposeNative = await createProcessCustodyFixture({ repoRoot: resolve(__dirname, '../../../..') });
    const session = new Session(); session.connect();
    const post = (method: string): Promise<Record<string, unknown>> => new Promise((done, fail) => {
        session.post(method, (error, result) => error ? fail(error) : done({ ...result }));
    });
    let profiling = false;
    let savingProfile: Promise<void> | undefined;
    const saveProfile = () => savingProfile ??= (async () => {
        if (!profiling) return;
        const profile = await post('Profiler.stop'); profiling = false;
        await writeFile(process.env.STO13_PROFILE_OUTPUT ?? '/tmp/sto13-read.cpuprofile', JSON.stringify(profile.profile));
    })();
    // Preserve the deciding CPU evidence when a diagnostic run fails or times
    // out, rather than publishing profiles only from successful observations.
    onTestFinished(saveProfile);
    let phase = 'setup';
    let chargePlan: unknown;
    let projectingPage = false;
    const visits = new Map<string, number>(); const serialized = new Map<string, number>();
    const transactions = new Map<InstanceType<typeof DatabaseSync>, number>();
    const locks = { begins: 0, beginMs: 0, maxBeginMs: 0, commits: 0, commitMs: 0, maxCommitMs: 0, maxTransactionMs: 0, busyErrors: 0 };
    const observed = new WeakSet<InstanceType<typeof DatabaseSync>>();
    const observeDatabase = (db: InstanceType<typeof DatabaseSync>) => {
        if (observed.has(db)) return;
        observed.add(db);
        db.function('sto13_visit', _ref => { visits.set(phase, (visits.get(phase) ?? 0) + 1); return 1; });
        db.function('sto13_serialize', value => {
            if (projectingPage) serialized.set(phase, (serialized.get(phase) ?? 0) + 1);
            if (typeof value !== 'string') throw new Error('Expected retained JSON text');
            return value;
        });
    };
    const statements = new Map<string, { calls: number; rows: number; ms: number }>();
    const prepare = DatabaseSync.prototype.prepare;
    const exec = DatabaseSync.prototype.exec;
    const execution = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        const selection = sql.split(';').find(value => value.includes('INSERT OR IGNORE INTO scan_charge_owners SELECT'));
        const counted = selection?.replace(/\bWHERE /, 'WHERE sto13_visit(e.ref) AND ');
        if (selection) observeDatabase(this);
        const start = performance.now();
        try { return exec.call(this, selection && counted ? sql.replace(selection, counted) : sql); }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'errcode' in error && (error.errcode === 5 || error.errcode === 6)) locks.busyErrors++;
            throw error;
        } finally {
            if (this.location()?.includes(`${sep}storage${sep}scans${sep}`)) {
                const elapsed = performance.now() - start;
                if (sql === 'BEGIN IMMEDIATE') {
                    transactions.set(this, start); locks.begins++; locks.beginMs += elapsed; locks.maxBeginMs = Math.max(locks.maxBeginMs, elapsed);
                } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
                    locks.maxTransactionMs = Math.max(locks.maxTransactionMs, performance.now() - (transactions.get(this) ?? start));
                    transactions.delete(this);
                    if (sql === 'COMMIT') { locks.commits++; locks.commitMs += elapsed; locks.maxCommitMs = Math.max(locks.maxCommitMs, elapsed); }
                }
                const key = `${phase}: exec ${sql.replaceAll(/\d{13}/g, '<clock>')}`; const value = statements.get(key) ?? { calls: 0, rows: 0, ms: 0 };
                value.calls++; value.ms += performance.now() - start; statements.set(key, value);
                if (!chargePlan && sql.includes('INSERT OR IGNORE INTO scan_charge_owners SELECT')) {
                    const statement = sql.split(';').find(value => value.includes('INSERT OR IGNORE INTO scan_charge_owners SELECT'))!;
                    const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${statement}`).all(); chargePlan = plan;
                    expect(prepare.call(this, `EXPLAIN QUERY PLAN ${counted}`).all().map(row => row.detail))
                        .toEqual(plan.map(row => row.detail));
                }
            }
        }
    });
    const observe = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
        if (!this.location()?.includes(`${sep}storage${sep}scans${sep}`)) return prepare.call(this, sql);
        observeDatabase(this);
        const projection = sql.startsWith('SELECT id,parent,data FROM nodes');
        const statement = prepare.call(this, projection
            ? sql.replace('SELECT id,parent,data FROM nodes', 'SELECT id,parent,sto13_serialize(data) AS data FROM nodes') : sql);
        const all = statement.all.bind(statement); const get = statement.get.bind(statement); const run = statement.run.bind(statement);
        const iterate = statement.iterate.bind(statement);
        const record = (start: number, rows: number) => {
            const key = `${phase}: ${sql}`; const value = statements.get(key) ?? { calls: 0, rows: 0, ms: 0 };
            value.calls++; value.rows += rows; value.ms += performance.now() - start; statements.set(key, value);
        };
        // Preserve SQLite's named/positional binding overload at the native boundary.
        statement.all = (...args) => { const start = performance.now(); projectingPage = projection;
            try { const rows: ReturnType<typeof statement.all> = Reflect.apply(all, undefined, args);
                record(start, rows.length); return rows; } finally { projectingPage = false; } };
        statement.get = (...args) => { const start = performance.now(); projectingPage = projection;
            try { const row: ReturnType<typeof statement.get> = Reflect.apply(get, undefined, args);
                record(start, Number(row !== undefined)); return row; } finally { projectingPage = false; } };
        statement.run = (...args) => { const start = performance.now();
            const result: ReturnType<typeof statement.run> = Reflect.apply(run, undefined, args); record(start, Number(result.changes)); return result; };
        statement.iterate = function* (...args) { const start = performance.now(); let rows = 0;
            const iterator: ReturnType<typeof statement.iterate> = Reflect.apply(iterate, undefined, args);
            try { for (const row of iterator) { rows++; yield row; } } finally { record(start, rows); } };
        return statement;
    });
    try {
        await Promise.all(Array.from({ length: 32 }, async (_, folder) => {
            const path = join(target, `package-${folder}`, 'objects'); await mkdir(path, { recursive: true });
            await Promise.all(Array.from({ length: 64 }, (_, file) => writeFile(join(path, `file-${file}`), 'native-writer')));
        }));
        const db = new DatabaseSync(join(fixture.home, 'storage', 'scans', `${createHash('sha256').update('retained').digest('hex')}.sqlite`));
        const pragmas = { journal: db.prepare('PRAGMA journal_mode').get(), busy: db.prepare('PRAGMA busy_timeout').get() };
        const plans = {
            children: db.prepare('EXPLAIN QUERY PLAN SELECT id FROM nodes WHERE parent=? AND visible=1').all(join(fixture.root, 'cache')),
            aggregate: db.prepare('EXPLAIN QUERY PLAN SELECT allocated,items FROM nodes WHERE id=?').all(join(fixture.root, 'cache')),
        };
        db.close();
        const runRead = async (label: string) => {
            phase = label;
            const start = performance.now();
            let listMs = 0; let summaryMs = 0;
            const [page, summary] = await Promise.all([
                fixture.service.scanGet({ ...fixture.request, scanId: undefined, view: { ...fixture.request.view, nodeId: join(fixture.root, 'cache') } }, { actor }).then(page => { listMs = performance.now() - start; return page; }),
                fixture.service.summary().then(summary => { summaryMs = performance.now() - start; return summary; }),
            ]);
            console.log(JSON.stringify({ qa: 'sto13-read', phase, ms: performance.now() - start, listMs, summaryMs, state: page.state?.status,
                root: page.root && { bytes: page.root.size.allocatedBytes, items: page.root.items }, nodes: page.nodes.length,
                summaryStates: summary.wholeDisk.scans.map(state => state.status) }));
            MachineStorageScanGetResultV1Schema.parse(page); HappierStorageSummaryV1Schema.parse(summary);
            expect(page.root?.size.allocatedBytes).toBe(page.nodes.reduce((bytes, node) => bytes + node.size.allocatedBytes, 0));
            expect(page.root?.items).toBe(1 + page.nodes.reduce((items, node) => items + node.items, 0));
            // Only page rows, cursor lookahead, root and the runner's trusted
            // node lookup may construct public JSON; retained descendants do not.
            expect(serialized.get(label)).toBeLessThanOrEqual(page.nodes.length + Number(Boolean(page.nextCursor)) + 2);
            return { page, summary };
        };
        await post('Profiler.enable'); await post('Profiler.start'); profiling = true;
        await runRead('idle');
        if (process.env.STO19_PROFILE === '1') {
            for (const label of ['actor-summary-first', 'actor-summary-repeated']) {
                phase = label;
                const start = performance.now();
                const summary = await fixture.service.summary({ actor });
                HappierStorageSummaryV1Schema.parse(summary);
                console.log(JSON.stringify({ qa: 'sto19-summary', phase, ms: performance.now() - start, suggestions: summary.suggestionsTop.length }));
            }
        }
        phase = 'start';
        const state = await fixture.service.scanStart({ machineId: 'machine', target: { folderPath: target } }, { actor });
        scanId = state.scanId;
        await batchReady.promise;
        expect(scanChild?.stdout?.isPaused()).toBe(true);
        expect(transactions.size).toBe(0);
        const paused = await runRead('paused-after-committed-batch');
        expect(paused.page.state?.status).toBe('running');
        expect(paused.summary.wholeDisk.scans[0]?.status).toBe('running');
        expect(childClosed).toBe(false);
        const reading = runRead('writing'); scanChild?.stdout?.resume(); await reading;
        await terminal.promise;
        const finished = await runRead('finished');
        expect(finished.page.state?.status).toBe('complete');
        const measured = await measureNativeDisk({ paths: [target] });
        expect(finished.page.root?.size.allocatedBytes).toBe(21 * 8 * (process.env.STO19_PROFILE === '1' ? 1704 : 568) * 81920 + measured.totalAllocatedBytes);
        await saveProfile();
        console.log(JSON.stringify({ qa: 'sto13-sql', pragmas, locks, plans, chargePlan, entryVisits: Object.fromEntries(visits),
            serializedReadNodes: Object.fromEntries(serialized),
            statements: [...statements].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12) }));
    } finally {
        scanChild?.stdout?.resume();
        if (scanId) await fixture.service.scanCancel({ machineId: 'machine', scanId }, { actor });
        unsubscribe(); spawn.mockImplementation(actualProcess.spawn);
        observe.mockRestore(); execution.mockRestore(); await saveProfile(); session.disconnect(); await fixture.dispose(); await disposeNative();
    }
}, 120_000);

it.skipIf(process.env.STO15_PROFILE !== '1')('returns a retained page before an unpaused native writer finishes', async () => {
    const fixture = await retainedFixture(process.env.STO19_PROFILE === '1' ? 1704 : 568, 8);
    const target = fixture.children[0];
    const childProcess = await import('node:child_process');
    const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const batchReady = deferred();
    let childClosed = false;
    let batches = 0;
    let scanId: string | undefined;
    const spawn = vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
        const child = actualProcess.spawn(command, args, options);
        if (args?.[0] === 'disk-scan') {
            child.once('close', () => { childClosed = true; });
            child.stdout?.on('data', () => { batches++; batchReady.resolve(); });
        }
        return child;
    });
    const disposeNative = await createProcessCustodyFixture({ repoRoot: resolve(__dirname, '../../../..') });
    try {
        await Promise.all(Array.from({ length: 64 }, async (_, folder) => {
            const path = join(target, `package-${folder}`, 'objects'); await mkdir(path, { recursive: true });
            await Promise.all(Array.from({ length: 128 }, (_, file) => writeFile(join(path, `file-${file}`), 'native-writer')));
        }));
        const state = await fixture.service.scanStart({ machineId: 'machine', target: { folderPath: target } }, { actor });
        scanId = state.scanId;
        await batchReady.promise;
        const start = performance.now(); const before = batches;
        const page = MachineStorageScanGetResultV1Schema.parse(await fixture.service.scanGet({ ...fixture.request,
            scanId, view: { ...fixture.request.view, nodeId: join(fixture.root, 'cache') } }, { actor }));
        console.log(JSON.stringify({ qa: 'sto15-unpaused-read', ms: performance.now() - start, before, batches, childClosed }));
        expect(childClosed).toBe(false);
        expect(batches).toBeGreaterThan(before);
        expect(page.state?.status).toBe('running');
        expect(page.root?.size.allocatedBytes).toBe(page.nodes.reduce((sum, node) => sum + node.size.allocatedBytes, 0));
        expect(page.root?.items).toBe(1 + page.nodes.reduce((sum, node) => sum + node.items, 0));
    } finally {
        if (scanId) await fixture.service.scanCancel({ machineId: 'machine', scanId }, { actor });
        spawn.mockImplementation(actualProcess.spawn); await fixture.dispose(); await disposeNative();
    }
}, 120_000);

// Observe the genuine OS boundary; classification and index queries stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, realpath: vi.fn(actual.realpath), readdir: vi.fn(actual.readdir), open: vi.fn(actual.open) };
});

const actor: StorageOperationActor = { accountId: 'owner', kind: 'person', custodianAccountId: 'owner',
    assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function retainedFixture(files = 1414, packages = 0, wholeVolume = false, logCount = 650) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-read-')));
    const home = join(root, 'home'); const scanRoot = join(root, 'cache'); const system = join(root, 'system');
    await Promise.all([mkdir(home), mkdir(scanRoot), mkdir(system)]);
    const children = Array.from({ length: 22 }, (_, index) => join(scanRoot, `folder-${index}`));
    await Promise.all(children.map(path => mkdir(path)));
    await mkdir(join(home, 'logs'));
    await Promise.all(Array.from({ length: logCount }, (_, index) => writeFile(join(home, 'logs', `${index}.log`), 'fixture')));
    const volume = { id: 'retained', mountPath: wholeVolume ? scanRoot : root, usedBytes: 0 };
    const index = createStorageScanIndex({ activeServerDir: home });
    await index.initialize([volume], true);
    const state = await index.begin({ volumeId: volume.id, root: scanRoot,
        target: wholeVolume ? { volumeId: volume.id } : { folderPath: scanRoot }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    index.ingest(volume.id, { v: 1, type: 'dir', id: scanRoot, name: 'cache', allocatedBytes: 0, logicalBytes: 0,
        items: 1, mtimeMs: 2000, flags: { atLeast: true }, children: [], files: [],
        folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 },
        ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false });
    const db = openProtectedSqliteDatabaseSync(join(home, 'storage', 'scans', `${createHash('sha256').update(volume.id).digest('hex')}.sqlite`));
    // Reopened normalized index, as in the settlement fixture. The default is
    // 31k entries; the profile adds package fan-out and retains 100k entries.
    // No file contents or per-file JS objects are needed for these retained facts.
    const folderCount = children.length * (1 + packages);
    const firstPackage = children.length + 2;
    const firstFile = folderCount + 2;
    const leafCount = children.length * (packages || 1);
    const last = folderCount + 1 + leafCount * files;
    const folderPrefix = join(scanRoot, 'folder-').replaceAll("'", "''");
    const packagePath = (position: string) => `'${folderPrefix}'||((${position})/${packages || 1})||'${sep}package-'||((${position})%${packages || 1})`;
    const leafPath = packages ? packagePath(`(i-${firstFile})/${files}`) : `'${folderPrefix}'||((i-${firstFile})/${files})`;
    db.exec(`BEGIN;
        WITH RECURSIVE ids(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM ids WHERE i<${last})
        INSERT INTO paths(ref,path) SELECT i,CASE WHEN i<${firstPackage} THEN '${folderPrefix}'||(i-2)
            ${packages ? `WHEN i<${firstFile} THEN ${packagePath(`i-${firstPackage}`)}` : ''}
            ELSE ${leafPath}||'${sep}file-'||i END FROM ids;
        INSERT INTO entries SELECT ref,CASE WHEN ref<${firstPackage} THEN 1
            ${packages ? `WHEN ref<${firstFile} THEN 2+(ref-${firstPackage})/${packages}` : ''}
            ELSE ${packages ? firstPackage : 2}+(ref-${firstFile})/${files} END,
            CASE WHEN ref<${firstPackage} THEN 'folder-'||(ref-2) WHEN ref<${firstFile} THEN 'package-'||ref ELSE 'file-'||ref END,
            CASE WHEN ref<${firstFile} THEN 'folder' ELSE 'file' END,
            CASE WHEN ref<${firstPackage} THEN ${files * (packages || 1) * 81920} WHEN ref<${firstFile} THEN ${files * 81920} ELSE 81920 END,2000,
            CASE WHEN ref<${firstPackage} THEN ${1 + (packages ? packages * (files + 1) : files)} WHEN ref<${firstFile} THEN ${files + 1} ELSE 1 END,1,
            '{"logicalBytes":0,"size":{"freesBytes":0,"sharedBytes":0,"sharedExtentsUnmeasured":false,"atLeast":false},"flags":{"happier":false,"protection":"none","atLeast":false,"inUse":false},"childCount":0}',1,0
            FROM paths WHERE ref>1;
        INSERT INTO dirs SELECT p.path,1,100,0,0,0,0,e.allocated,1,0,1,1 FROM paths p JOIN entries e USING(ref) WHERE ref BETWEEN 2 AND ${firstFile - 1};
        INSERT INTO coverage SELECT id,100,1 FROM dirs WHERE complete=1;
        INSERT INTO allocation_observations SELECT ref,ref,'physical:'||ref,81920,2000,1 FROM paths WHERE ref>=${firstFile};
        UPDATE entries SET allocated=${leafCount * files * 81920},items=${last} WHERE ref=1;
        ${packages ? 'UPDATE dirs SET enumerated=1,materialized=2,complete=1 WHERE id=(SELECT path FROM paths WHERE ref=1);' : ''}
        COMMIT;`);
    db.close(); index.finish(volume.id, wholeVolume ? 'complete' : 'cancelled'); index.close();
    let held = children[0];
    // Real process inventories repeat cwd/executable facts for descendants.
    const processPaths = Array.from({ length: 1800 }, (_, i) => join(root, 'work', `project-${i % 180}`));
    let volumeListener: (() => void) | undefined;
    let additionalVolume = false;
    const service = createStorageService({ machineId: 'machine', homeDir: root,
        catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(root, 'no-temp'), bootedAt: 5_000,
            readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths: [...processPaths, held],
                sessions: processPaths.map((path, i) => ({ path, sessionId: `session-${i % 180}` })) }) },
        resourcesPolicy: await createStoragePolicyFixture({ wholeDiskEnabled: true }),
        readStorageProtectionFacts: () => ({ systemPaths: [system] }),
        subscribeChanges: listener => { volumeListener = listener; return () => { volumeListener = undefined; }; },
        readVolumes: () => [{ id: volume.id, label: 'Volume', mount: volume.mountPath, totalBytes: 10_000_000_000, availableBytes: 5_000_000_000 },
            ...(additionalVolume ? [{ id: 'additional', label: 'Additional', mount: join(root, 'additional'), totalBytes: 1_000_000, availableBytes: 500_000 }] : [])] });
    await service.initialize();
    return { root, home, system, children, scanId: state.scanId, service, setHeld: (path: string) => { held = path; },
        addVolume: () => { additionalVolume = true; volumeListener?.(); },
        request: { machineId: 'machine', scanId: state.scanId, view: { tab: 'folders', depth: 1, sort: { by: 'size', direction: 'desc' } } } satisfies MachineStorageScanGetInputV1,
        dispose: async () => { service.dispose(); await rm(root, { recursive: true, force: true }); } };
}

it('does not multiply unrelated catalog comparisons by the returned page size', async () => {
    const { Session } = await import('node:inspector');
    const profiler = new Session(); profiler.connect();
    const post = <T>(method: string, params: object = {}) => new Promise<T>((done, fail) => {
        profiler.post(method, params, (error, result) => error ? fail(error) : done(result as T));
    });
    type Coverage = { result: { url: string; functions: { functionName: string; ranges: { count: number }[] }[] }[] };
    try {
        await post('Profiler.enable');
        const comparisons: number[] = [];
        for (const logs of [65, 650]) {
            const fixture = await retainedFixture(1, 0, false, logs);
            try {
                // Warm the genuine catalog/index. Count only the subsequent public read.
                await fixture.service.scanGet(fixture.request, { actor });
                await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
                const page = await fixture.service.scanGet(fixture.request, { actor });
                const coverage = await post<Coverage>('Profiler.takePreciseCoverage');
                await post('Profiler.stopPreciseCoverage');
                expect(page.nodes).toHaveLength(22);
                const owner = coverage.result.filter(script => script.url.endsWith('/storage/storagePath.ts'));
                expect(owner).toHaveLength(1);
                comparisons.push(owner.flatMap(script => script.functions)
                    .filter(fn => fn.functionName === 'equal' || fn.functionName === 'contains')
                    .reduce((count, fn) => count + fn.ranges[0].count, 0));
            } finally { await fixture.dispose(); }
        }
        expect(comparisons[0]).toBeGreaterThan(0);
        // More unrelated logs may be indexed once; they must add no per-row joins.
        expect(comparisons[1]).toBe(comparisons[0]);
    } finally {
        await post('Profiler.stopPreciseCoverage');
        profiler.disconnect();
    }
}, 60_000);

it('shares one fresh physical protection rule set across a retained 31k-item page', async () => {
    const fixture = await retainedFixture();
    const resolution = vi.mocked(filesystem.realpath);
    try {
        const read = async () => {
            resolution.mockClear();
            const page = MachineStorageScanGetResultV1Schema.parse(await fixture.service.scanGet(fixture.request, { actor }));
            return { page, resolutions: resolution.mock.calls.filter(([path]) => String(path) === fixture.system).length };
        };
        const first = await read(); fixture.setHeld(fixture.children[1]); const second = await read();
        expect(first.page.nodes).toHaveLength(22);
        expect(first.page.root).toMatchObject({ size: { allocatedBytes: 22 * 1414 * 81920 }, items: 31131 });
        expect(first.page.nodes.find(node => node.nodeId === fixture.children[0])?.flags).toMatchObject({ protection: 'keep', inUse: true });
        expect(second.page.nodes.find(node => node.nodeId === fixture.children[0])?.flags).toMatchObject({ protection: 'none', inUse: false });
        expect(second.page.nodes.find(node => node.nodeId === fixture.children[1])?.flags).toMatchObject({ protection: 'keep', inUse: true });
        expect([first.resolutions, second.resolutions]).toEqual([1, 1]);
        const paged: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await fixture.service.scanGet({ ...fixture.request,
                view: { ...fixture.request.view, pageSize: 7, ...(cursor ? { cursor } : {}) } }, { actor });
            paged.push(...page.nodes.map(node => node.nodeId)); cursor = page.nextCursor;
        } while (cursor);
        expect(paged).toEqual(first.page.nodes.map(node => node.nodeId));
    } finally { await fixture.dispose(); }
}, 60_000);

it('reads a cold 300k-item scan page without unrelated catalog walks, retaining fresh protection after invalidation', async () => {
    const fixture = await retainedFixture(1704, 8, true);
    const directory = vi.mocked(filesystem.readdir);
    const logReads = () => directory.mock.calls.filter(([path]) => String(path) === join(fixture.home, 'logs')).length;
    const previousTrace = process.env.HAPPIER_WEB_LATENCY_TRACE;
    const trace = vi.spyOn(logger, 'debug');
    try {
        directory.mockClear();
        process.env.HAPPIER_WEB_LATENCY_TRACE = '1';
        const started = performance.now();
        const first = await withStorageReadTrace('fx-fst-b-cold', () => fixture.service.scanGet(fixture.request, { actor }));
        const coldMs = performance.now() - started;
        if (previousTrace === undefined) delete process.env.HAPPIER_WEB_LATENCY_TRACE;
        else process.env.HAPPIER_WEB_LATENCY_TRACE = previousTrace;
        expect(first.root?.items).toBe(300103);
        expect(first.state?.status).toBe('complete');
        expect(first.nodes).toHaveLength(22);
        const coldLogReads = logReads();
        const coldTempReads = directory.mock.calls.filter(([path]) => String(path).startsWith(join(fixture.root, 'no-temp'))).length;
        const stages = trace.mock.calls.flatMap(([label, value]) => label === '[storage-read]'
            && typeof value === 'object' && value !== null && 'status' in value && value.status === 'settled' ? [value] : []);
        console.log(JSON.stringify({ qa: 'FX-FST-B', requestId: 'fx-fst-b-cold', coldMs, coldLogReads, coldTempReads,
            returnedNodes: first.nodes.length, stages }));
        expect.soft(coldLogReads).toBe(0);
        expect.soft(coldTempReads).toBe(0);
        directory.mockClear();
        fixture.setHeld(fixture.children[1]);
        const second = await fixture.service.scanGet(fixture.request, { actor });
        // A page takes fresh protection even when no inventory event was emitted.
        expect(second.nodes.find(node => node.nodeId === fixture.children[0])?.flags.inUse).toBe(false);
        expect(second.nodes.find(node => node.nodeId === fixture.children[1])?.flags.inUse).toBe(true);
        expect(logReads()).toBe(0);
        // Invalidating the summary catalog must not make a scan page rediscover it.
        await withScmWorktreeMutationActivity(async () => {});
        fixture.setHeld(fixture.children[2]);
        const afterInvalidation = await fixture.service.scanGet(fixture.request, { actor });
        expect(afterInvalidation.nodes.find(node => node.nodeId === fixture.children[1])?.flags.inUse).toBe(false);
        expect(afterInvalidation.nodes.find(node => node.nodeId === fixture.children[2])?.flags.inUse).toBe(true);
        expect(logReads()).toBe(0);
    } finally {
        trace.mockRestore();
        if (previousTrace === undefined) delete process.env.HAPPIER_WEB_LATENCY_TRACE;
        else process.env.HAPPIER_WEB_LATENCY_TRACE = previousTrace;
        await fixture.dispose();
    }
}, 60_000);

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('serves honest retained snapshots during concurrent index ingestion', async () => {
    const fixture = await retainedFixture();
    const legacyTemporary = join(fixture.root, 'no-temp', 'happier-running-scan');
    await mkdir(legacyTemporary, { recursive: true });
    await writeFile(join(legacyTemporary, 'bytes'), 'retained temporary output');
    const actualFilesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const temporaryEntered = deferred(); const temporaryRelease = deferred();
    const directory = vi.mocked(filesystem.readdir).mockImplementation(async (path, options) => {
        const result = await actualFilesystem.readdir(path, options);
        if (String(path) === legacyTemporary) { temporaryEntered.resolve(); await temporaryRelease.promise; }
        return result;
    });
    const childProcess = await import('node:child_process');
    const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const runtime = process.execPath;
    const firstBatch = deferred(); const continuedWriting = deferred();
    let scanChild: ReturnType<typeof childProcess.spawn> | undefined;
    let batches = 0; let readFinished = false;
    let scanId: string | undefined;
    let disposeNative: (() => Promise<void>) | undefined;
    let pendingReads: Promise<unknown> | undefined;
    const spawn = vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
        if (args?.[0] !== 'disk-scan') return actualProcess.spawn(command, args, options);
        // Substitute only the OS process: this faithful NDJSON producer keeps
        // the real runner/parser/index writing until Cancel, respects pipe
        // backpressure, and has no artificial batch ceiling or stdout pause.
        const root = join(fixture.root, 'cache');
        const records = Array.from({ length: 32 }, (_, i) => ({ v: 1, type: 'dir-entry', parent: root,
            visible: true, retained: false, replaceFacts: false,
            node: { id: join(root, `new-${i}`), name: `new-${i}`, kind: 'file', allocatedBytes: 0,
                logicalBytes: 0, items: 1, mtimeMs: 2000, flags: { atLeast: false } } }));
        const batch = [...records, { v: 1, type: 'progress', sizedBytes: 0, items: 32 }]
            .map(record => JSON.stringify(record)).join('\n') + '\n';
        const child = actualProcess.spawn(runtime, ['-e', `
            const batch = Buffer.from(${JSON.stringify(batch)});
            function write() { while (process.stdout.write(batch)) {} }
            process.stdout.on('drain', write);
            process.stdin.once('data', write);
        `], options);
        scanChild = child;
        child.stdout?.on('data', (chunk: Buffer) => {
            batches++;
            // This marker follows all 32 entries. The production data handler
            // commits the chunk before this promise's continuation can read.
            if (chunk.includes('"type":"progress"')) firstBatch.resolve();
            if (readFinished) continuedWriting.resolve();
        });
        return child;
    });
    let cleanup: Promise<void> | undefined;
    const dispose = () => cleanup ??= (async () => {
        temporaryRelease.resolve();
        if (scanId) await fixture.service.scanCancel({ machineId: 'machine', scanId }, { actor });
        await pendingReads?.catch(() => {});
        spawn.mockImplementation(actualProcess.spawn); directory.mockImplementation(actualFilesystem.readdir);
        await fixture.dispose(); await disposeNative?.();
    })();
    try {
        disposeNative = await createProcessCustodyFixture({ repoRoot: resolve(__dirname, '../../../..') });
        // A regressed read may never settle. The test timeout must still retire
        // this perpetual producer, rather than leave it writing after failure.
        onTestFinished(dispose);
        const state = await fixture.service.scanStart({ machineId: 'machine', target: { folderPath: join(fixture.root, 'cache') }, resume: true }, { actor });
        scanId = state.scanId;
        await firstBatch.promise;
        const reads = Promise.all([
            fixture.service.scanGet(fixture.request, { actor }), fixture.service.summary(),
        ]);
        pendingReads = reads;
        // A post-boot legacy directory cannot become Safe by inspecting its
        // descendants. Both real read paths must finish while that OS result
        // remains parked and the scan's pipe producer continues writing.
        expect(await Promise.race([reads.then(() => 'completed'), temporaryEntered.promise.then(() => 'blocked-temporary')])).toBe('completed');
        const [list, summary] = await reads;
        const page = MachineStorageScanGetResultV1Schema.parse(list);
        expect(page.state).toMatchObject({ status: 'running', progress: { sizedBytes: 22 * 1414 * 81920, items: 31163 } });
        expect(page.nodes).toHaveLength(54);
        expect(page.root).toMatchObject({ size: { allocatedBytes: 22 * 1414 * 81920 }, items: 31163 });
        expect(HappierStorageSummaryV1Schema.parse(summary).wholeDisk.scans).toMatchObject([{ scanId: fixture.scanId, status: 'running' }]);
        expect(scanChild?.exitCode).toBeNull();
        readFinished = true; await continuedWriting.promise;
        expect(batches).toBeGreaterThan(1);
        await fixture.service.scanCancel({ machineId: 'machine', scanId }, { actor }); scanId = undefined;
        const stopped = MachineStorageScanGetResultV1Schema.parse(await fixture.service.scanGet(fixture.request, { actor }));
        expect(stopped.state).toMatchObject({ status: 'cancelled', progress: { sizedBytes: 22 * 1414 * 81920, items: 31163 } });
        expect(stopped.root).toEqual(page.root);
    } finally { await dispose(); }
}, 120_000);

it('admits Cancel without waiting for unrelated volume index discovery', async () => {
    const fixture = await retainedFixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const projectionEntered = deferred(); const projectionRelease = deferred();
    const discoveryEntered = deferred(); const discoveryRelease = deferred(); const authorityEntered = deferred();
    let cancellation: ReturnType<typeof fixture.service.scanCancel> | undefined;
    const open = vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (String(path).endsWith('prior.ndjson')) { projectionEntered.resolve(); await projectionRelease.promise; }
        return handle;
    });
    const directory = vi.mocked(filesystem.readdir).mockImplementation(async (path, options) => {
        const result = await actual.readdir(path, options);
        if (String(path) === join(fixture.home, 'storage', 'scans')) { discoveryEntered.resolve(); await discoveryRelease.promise; }
        return result;
    });
    try {
        const running = await fixture.service.scanStart({ machineId: 'machine', target: { folderPath: join(fixture.root, 'cache') }, resume: true }, { actor });
        await projectionEntered.promise;
        fixture.addVolume(); await discoveryEntered.promise;
        cancellation = fixture.service.scanCancel({ machineId: 'machine', scanId: running.scanId }, {
            actor: { ...actor, assertCurrentAuthority: async () => { authorityEntered.resolve(); } },
        });
        expect(await Promise.race([authorityEntered.promise.then(() => true), yieldToEventLoop().then(() => false)])).toBe(true);
        projectionRelease.resolve();
        const stopped = await cancellation;
        expect(stopped.status).toBe('cancelled');
        expect(stopped.progress).toMatchObject({ sizedBytes: 22 * 1414 * 81920, items: 31131 });
    } finally {
        projectionRelease.resolve(); discoveryRelease.resolve(); await cancellation?.catch(() => {});
        await fixture.service.initializeScans();
        open.mockImplementation(actual.open); directory.mockImplementation(actual.readdir);
        await fixture.dispose();
    }
}, 60_000);

it('settles a real scan Cancel while retained list and explicit refresh await filesystem work', async () => {
    const fixture = await retainedFixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const projectionEntered = deferred(); const projectionRelease = deferred();
    const listEntered = deferred(); const listRelease = deferred();
    const summaryEntered = deferred(); const summaryRelease = deferred();
    const summaryController = new AbortController();
    let listFinished = false; let summaryFinished = false; let holdSummary = false;
    let list: Promise<unknown> | undefined; let summary: Promise<unknown> | undefined;
    const open = vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (String(path).endsWith('prior.ndjson')) { projectionEntered.resolve(); await projectionRelease.promise; }
        return handle;
    });
    const resolution = vi.mocked(filesystem.realpath).mockImplementation(async (path, options) => {
        const result = await actual.realpath(path, options);
        if (String(path) === fixture.system) { listEntered.resolve(); await listRelease.promise; }
        return result;
    });
    const directory = vi.mocked(filesystem.readdir).mockImplementation(async (path, options) => {
        const result = await actual.readdir(path, options);
        if (holdSummary && String(path) === join(fixture.home, 'logs')) { summaryEntered.resolve(); await summaryRelease.promise; }
        return result;
    });
    try {
        const running = await fixture.service.scanStart({ machineId: 'machine', target: { folderPath: join(fixture.root, 'cache') }, resume: true }, { actor });
        await projectionEntered.promise;
        list = fixture.service.scanGet(fixture.request, { actor }).finally(() => { listFinished = true; });
        await listEntered.promise;
        // The list has already acquired the shared catalog snapshot. An owner
        // edge makes the concurrent summary require genuinely new inventory.
        fixture.service.invalidate();
        holdSummary = true;
        summary = fixture.service.refresh({ signal: summaryController.signal }).catch(error => error).finally(() => { summaryFinished = true; });
        await summaryEntered.promise;
        const cancel = fixture.service.scanCancel({ machineId: 'machine', scanId: running.scanId }, { actor });
        projectionRelease.resolve();
        const stopped = await cancel;
        expect(stopped.status).toBe('cancelled');
        expect(stopped.progress).toMatchObject({ sizedBytes: 22 * 1414 * 81920, items: 31131 });
        expect(listFinished).toBe(false); expect(summaryFinished).toBe(false);
        summaryController.abort(); listRelease.resolve(); summaryRelease.resolve();
        expect(MachineStorageScanGetResultV1Schema.parse(await list).nodes).toHaveLength(22);
        expect(await summary).toMatchObject({ name: 'AbortError' });
    } finally {
        projectionRelease.resolve(); listRelease.resolve(); summaryRelease.resolve(); summaryController.abort();
        await Promise.allSettled([list, summary]);
        open.mockImplementation(actual.open); resolution.mockImplementation(actual.realpath); directory.mockImplementation(actual.readdir);
        await fixture.dispose();
    }
}, 60_000);
