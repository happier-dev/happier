import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

import { createTriageListWindowStore } from './listWindowStore.js';
import {
    createNoPersistenceTriageFixture,
    NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS,
    NO_PERSISTENCE_INSTANCE_IDS,
} from './noPersistence.test-support.js';

/** Runs in an actual child process loaded with the package's source config.
 * Only genuine browser/native storage and OS file-write ports are trapped;
 * the store, coordinator, Action, qualification and folds are production code. */
function installDeviceWriteTraps() {
    const attempts: string[] = [];
    const restorers: Array<() => void> = [];
    const refuse = (port: string): never => {
        attempts.push(port);
        throw new Error(`Provider-derived durable write: ${port}`);
    };
    const replace = (target: object, key: string, value: unknown) => {
        const previous = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, { configurable: true, writable: true, value });
        restorers.push(() => {
            if (previous) Object.defineProperty(target, key, previous);
            else Reflect.deleteProperty(target, key);
        });
    };
    const localStorage = {
        length: 0, key: () => null, getItem: () => null,
        setItem: () => refuse('localStorage.setItem'),
        removeItem: () => refuse('localStorage.removeItem'),
        clear: () => refuse('localStorage.clear'),
    };
    replace(globalThis, 'localStorage', localStorage);
    replace(globalThis, 'window', { localStorage });

    // The installed AsyncStorage adapter is the genuine package API boundary.
    // No native device is required to refuse calls to its mutation ports.
    const require = createRequire(new URL('../../../../../apps/ui/package.json', import.meta.url));
    const asyncStorageModule: { default: Record<string, unknown> } = require('@react-native-async-storage/async-storage');
    for (const method of ['setItem', 'mergeItem', 'multiSet', 'multiMerge', 'removeItem', 'multiRemove', 'clear']) {
        assert.equal(typeof asyncStorageModule.default[method], 'function');
        replace(asyncStorageModule.default, method, () => refuse(`AsyncStorage.${method}`));
    }
    for (const method of ['writeFile', 'appendFile', 'writeFileSync', 'appendFileSync', 'createWriteStream']) {
        replace(fs, method, () => refuse(`fs.${method}`));
    }
    for (const method of ['writeFile', 'appendFile']) {
        replace(fs.promises, method, () => refuse(`fs.promises.${method}`));
    }
    syncBuiltinESMExports();

    // A disconnected trap must not let a no-write claim pass vacuously.
    assert.throws(() => localStorage.setItem(), /Provider-derived durable write/);
    const setItem = asyncStorageModule.default.setItem;
    assert.ok(typeof setItem === 'function');
    assert.throws(() => Reflect.apply(setItem, asyncStorageModule.default, ['probe', 'probe']), /Provider-derived durable write/);
    assert.throws(() => fs.writeFileSync('qb84-write-must-never-exist', 'probe'), /Provider-derived durable write/);
    assert.deepEqual(attempts, ['localStorage.setItem', 'AsyncStorage.setItem', 'fs.writeFileSync']);
    attempts.length = 0;
    return {
        attempts,
        restore() {
            for (const restore of restorers.reverse()) restore();
            syncBuiltinESMExports();
        },
    };
}

const phase = process.argv.at(-1);
assert.ok(phase === 'populate' || phase === 'fresh');
const fixture = createNoPersistenceTriageFixture();
const traps = installDeviceWriteTraps();
const nowMs = 1_760_000_000_000;
const store = createTriageListWindowStore({ readEntries: fixture.readEntries, nowMs: () => nowMs });
try {
    // The same Account/configured source identities and clock enter both
    // processes. Rehydrated rows, deadlines or frontiers would be observable.
    assert.equal(store.getSnapshot().window, undefined);
    assert.equal(store.getSnapshot().refreshBlocked, undefined);
    assert.equal(store.getSnapshot().pending, 'idle');
    assert.equal(store.getSnapshot().passes, 0);
    assert.equal(fixture.actionInputs.length, 0);
    await store.refresh('view');
    assert.equal(store.getSnapshot().window?.rows.length, NO_PERSISTENCE_INSTANCE_IDS.length);
    assert.deepEqual(store.getSnapshot().loadMore, { kind: 'available' });
    assert.deepEqual(fixture.scannedPages, new Map(NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS.map(id => [id, ['initial']])));
    assert.ok(fixture.actionInputs.every(input => input.resume === undefined));

    // Complete the entire configured catalogue under every write trap, proving
    // the path actually read both pages rather than simply avoiding all work.
    await store.loadMore();
    assert.equal(store.getSnapshot().window?.coverage, 'complete');
    assert.deepEqual(fixture.scannedPages, new Map(NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS.map(id => [id, ['initial', 'continuation']])));
    assert.deepEqual(store.getSnapshot().loadMore, { kind: 'exhausted' });

    if (phase === 'populate') {
        const [activeInstanceId, pacedInstanceId] = NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS;
        let holdActive = false;
        let started!: () => void;
        const activeStarted = new Promise<void>(resolve => { started = resolve; });
        fixture.setScan(async (...args) => {
            const id = args[1].instance.instance.sourceInstanceId;
            if (id === pacedInstanceId) return { kind: 'failed', failure: {
                class: 'rateLimit', code: 'provider-deadline', retryNotBeforeMs: nowMs + 60_000,
            } };
            if (id === activeInstanceId && holdActive) {
                assert.equal(args[1].page.kind, 'continuation');
                started();
                await new Promise<void>(() => {});
            }
            return await fixture.defaultScan(...args);
        });
        await store.refresh('manual');
        assert.ok((store.getSnapshot().window?.rows.length ?? 0) > 0);
        assert.deepEqual(store.getSnapshot().loadMore, { kind: 'available' });
        assert.ok(store.getSnapshot().window?.lanes.some(lane => lane.sourceInstanceId === pacedInstanceId
            && lane.health.kind === 'failed' && lane.health.failure.retryNotBeforeMs === nowMs + 60_000));
        const pacedCalls = fixture.scannedPages.get(pacedInstanceId)?.length;
        holdActive = true;
        void store.loadMore();
        await activeStarted;
        let followupSettled = false;
        void store.refresh('manual').then(() => { followupSettled = true; });
        await Promise.resolve();
        assert.equal(followupSettled, false);
        assert.notEqual(store.getSnapshot().pending, 'idle');
        assert.equal(fixture.scannedPages.get(pacedInstanceId)?.length, pacedCalls);
        // The append retains its active provider frontier until it settles.
        // Leave that read and queued manual follow-up in this process: exiting,
        // rather than dispose/recreate, loses them alongside projection/pacing.
    } else {
        assert.equal(store.getSnapshot().refreshBlocked, undefined);
        assert.ok(store.getSnapshot().window?.lanes.every(lane => lane.health.kind !== 'failed'));
        assert.equal(store.getSnapshot().pending, 'idle');
        store.dispose();
    }
    assert.deepEqual(fixture.durableWriteAttempts, []);
    assert.deepEqual(traps.attempts, []);
    console.info(`QB84_PROCESS ${JSON.stringify({ phase, pid: process.pid,
        scans: [...fixture.scannedPages], durableWrites: fixture.durableWriteAttempts,
        deviceWrites: traps.attempts, pending: store.getSnapshot().pending })}`);
} finally {
    traps.restore();
}
