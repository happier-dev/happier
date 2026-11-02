import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { getPersistenceStorage } from './persistenceStorage';
import { createPersistentUiState, UiStatePersistenceError } from './persistentUiState';
import { parseRecentWorkspaceFiles } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { appendFileEditorAiSuggestionUsage, FileEditorAiSuggestionDailyUsageSchema } from '@/sync/domains/workspaces/languageIntelligence/fileEditorAiSuggestionUsage';

describe('device-local keyed UI state', () => {
    it('persists an explicit repair even when it equals a tolerant fallback', () => {
        const state = createPersistentUiState<string | null>('fallback-repair', value => z.catch(z.nullable(z.string()), null).parse(value));
        const device = getPersistenceStorage();
        device.set('ui-state:fallback-repair:value', JSON.stringify({ future: true }));
        expect(state.read('value')).toBeNull();
        state.set('value', null);
        expect(device.getString('ui-state:fallback-repair:value')).toBe('null');
        expect(state.readStrict('value', value => z.nullable(z.string()).parse(value))).toBeNull();
    });

    it('admits exact stored bytes before migration can retire a source, including after a tolerant read', () => {
        const state = createPersistentUiState<string | null>('strict-admission', value => z.catch(z.nullable(z.string()), null).parse(value));
        const device = getPersistenceStorage();
        const key = 'ui-state:strict-admission:value';
        device.set(key, JSON.stringify({ future: true }));
        expect(state.read('value')).toBeNull();
        const admit = (value: unknown) => z.nullable(z.string()).parse(value);
        expect(() => state.readStrict('value', admit)).toThrow(UiStatePersistenceError);
        expect(device.getString(key)).toBe(JSON.stringify({ future: true }));
        expect(state.read('value')).toBeNull();
        const changed = vi.fn();
        const stop = state.subscribeKey('value', changed);
        try {
            state.set('value', 'repaired');
            expect(state.readStrict('value', admit)).toBe('repaired');
            expect(changed).toHaveBeenCalledTimes(1);
            expect(state.readStrict('missing', admit)).toBeUndefined();
            device.set('ui-state:strict-admission:cleared', 'null');
            expect(state.readStrict('cleared', admit)).toBeNull();
        } finally { stop(); }
    });

    it('keeps 153 restored keyed readers idle for 50 clock ticks and releases their subscriptions', async () => {
        vi.useFakeTimers();
        const state = createPersistentUiState('idle-153', value => z.object({ position: z.number() }).parse(value));
        const mmkv = getPersistenceStorage();
        for (let index = 0; index < 153; index += 1) mmkv.set(`ui-state:idle-153:scope-${index}`, JSON.stringify({ position: index }));
        const writes = vi.spyOn(mmkv, 'set');
        const notifications = vi.fn();
        const callbacks = vi.fn();
        const stop = state.subscribe(notifications);
        const stops = Array.from({ length: 153 }, (_, index) => state.subscribeKey(`scope-${index}`, callbacks));
        try {
            const retained = state.readAll();
            expect(Object.keys(retained)).toHaveLength(153);
            expect(writes).not.toHaveBeenCalled();
            expect(notifications).not.toHaveBeenCalled();
            expect(callbacks).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            for (let tick = 0; tick < 50; tick += 1) {
                await vi.advanceTimersByTimeAsync(1000);
                expect(state.readAll()).toBe(retained);
                for (let index = 0; index < 153; index += 1) expect(state.read(`scope-${index}`)).toBe(retained[`scope-${index}`]);
            }
            expect(writes).not.toHaveBeenCalled();
            expect(notifications).not.toHaveBeenCalled();
            expect(callbacks).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            // Equal reconstructed input must not replace retained records or notify readers.
            for (let index = 0; index < 153; index += 1) state.set(`scope-${index}`, { position: index });
            expect(state.readAll()).toBe(retained);
            expect(writes).not.toHaveBeenCalled();
            expect(notifications).not.toHaveBeenCalled();
            expect(callbacks).not.toHaveBeenCalled();
            stop();
            for (const unsubscribe of stops) unsubscribe();
            for (let index = 0; index < 153; index += 1) state.set(`scope-${index}`, { position: index + 1 });
            expect(writes).toHaveBeenCalledTimes(153);
            expect(notifications).not.toHaveBeenCalled();
            expect(callbacks).not.toHaveBeenCalled();
            expect(Object.keys(state.readAll())).toHaveLength(153);
        } finally {
            stop(); for (const unsubscribe of stops) unsubscribe();
            writes.mockRestore(); vi.useRealTimers();
        }
    });

    it('withdraws retained projections when the canonical persistence lifecycle clears device data', async () => {
        const state = createPersistentUiState('clear-lifecycle', value => z.string().parse(value));
        state.set('draft', 'private content');
        const listener = vi.fn();
        const unsubscribe = state.subscribeKey('draft', listener);
        try {
            const { clearPersistence } = await import('./persistenceLifecycle');
            await clearPersistence();
            expect(state.read('draft')).toBeUndefined();
            expect(state.readAll()).toEqual({});
            expect(listener).toHaveBeenCalledTimes(1);
        } finally { unsubscribe(); }
    });
    it('restores real recents and usage through their persisted readers after a new owner loads', () => {
        const recents = createPersistentUiState('reload-recents', value => parseRecentWorkspaceFiles({ paths: value }).paths);
        const usage = createPersistentUiState('reload-usage', value => FileEditorAiSuggestionDailyUsageSchema.parse(value));
        recents.set('workspace-a', ['src/a.ts', 'src/b.ts']);
        const event = appendFileEditorAiSuggestionUsage({}, 'account-a', { kind: 'acceptedFull', inputTokens: 50, costUsd: 0.01 });
        usage.set('account-a', event['account-a']);
        const restoredRecents = createPersistentUiState('reload-recents', value => parseRecentWorkspaceFiles({ paths: value }).paths);
        const restoredUsage = createPersistentUiState('reload-usage', value => FileEditorAiSuggestionDailyUsageSchema.parse(value));
        expect(restoredRecents.read('workspace-a')).toEqual(['src/a.ts', 'src/b.ts']);
        expect(restoredUsage.read('account-a')).toMatchObject({ acceptedFull: 1, inputTokens: 50, reportedCostUsd: 0.01 });
        expect(restoredUsage.read('account-b')).toBeUndefined();
    });

    it('writes only a changed record and keeps unrelated readers quiet across a thousand scopes', () => {
        const state = createPersistentUiState('cost-contract', value => z.object({ position: z.number() }).parse(value));
        replacePersistentUiStateForTest(state, Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`scope-${i}`, { position: i }])));
        const unchanged = state.read('scope-0');
        const unaffected = vi.fn();
        const changed = vi.fn();
        const unsubscribe = state.subscribeKey('scope-0', unaffected);
        const unsubscribeChanged = state.subscribeKey('scope-999', changed);
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            state.set('scope-999', { position: 1001 });
            state.set('scope-999', { position: 1001 });
            expect(writes).toHaveBeenCalledTimes(1);
            expect(writes.mock.calls[0][0]).toBe('ui-state:cost-contract:scope-999');
            expect(unaffected).not.toHaveBeenCalled();
            expect(changed).toHaveBeenCalledTimes(1);
            expect(state.read('scope-0')).toBe(unchanged);
            const loaded = createPersistentUiState('cost-contract', value => z.object({ position: z.number() }).parse(value));
            const reads = vi.spyOn(getPersistenceStorage(), 'getString');
            try {
                expect(loaded.read('scope-999')).toEqual({ position: 1001 });
                expect(reads).toHaveBeenCalledTimes(1);
            } finally { reads.mockRestore(); }
        } finally { writes.mockRestore(); unsubscribe(); unsubscribeChanged(); }
    });

    it('retains the last persisted value and does not notify when the device refuses a write', () => {
        const state = createPersistentUiState('write-failure', value => z.string().parse(value));
        state.set('draft', 'before');
        const listener = vi.fn();
        const unsubscribe = state.subscribeKey('draft', listener);
        const write = vi.spyOn(getPersistenceStorage(), 'set').mockImplementation(() => { throw new Error('storage refused'); });
        try {
            expect(() => state.set('draft', 'after')).toThrow(UiStatePersistenceError);
            expect(state.read('draft')).toBe('before');
            expect(listener).not.toHaveBeenCalled();
        } finally { write.mockRestore(); unsubscribe(); }
        state.set('draft', 'after');
        expect(state.read('draft')).toBe('after');
    });
});
