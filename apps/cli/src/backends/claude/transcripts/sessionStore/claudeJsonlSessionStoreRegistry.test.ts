import { existsSync, readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreKey,
    FileBackedTranscriptSessionStoreLifecycleState,
} from '@/api/session/fileBackedTranscripts/store';

import {
    acquireClaudeJsonlSessionStore,
    createClaudeJsonlSessionStoreRegistry,
    clearClaudeJsonlSessionStoreRegistriesForTests,
    withClaudeJsonlSessionStore,
} from './claudeJsonlSessionStoreRegistry';
import {
    resolveClaudeJsonlSessionStoreColdIdleMs,
    resolveClaudeJsonlSessionStoreDetachedGraceMs,
} from './claudeJsonlSessionStoreCachePolicy';

class TestStore implements FileBackedTranscriptSessionStore {
    public readonly lifecycleStates: FileBackedTranscriptSessionStoreLifecycleState[] = [];
    public warmCount = 0;
    public disposeCount = 0;

    async warm(): Promise<void> {
        this.warmCount += 1;
    }

    async dispose(): Promise<void> {
        this.disposeCount += 1;
    }

    async setLifecycleState(state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> {
        this.lifecycleStates.push(state);
    }

    async pageOlder(): Promise<{ items: readonly unknown[]; nextCursor: string | null; hasMore: boolean; tailCursor: string | null; truncated: boolean }> {
        return { items: [], nextCursor: null, hasMore: false, tailCursor: null, truncated: false };
    }

    async readAfter(): Promise<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> {
        return { items: [], nextCursor: null, truncated: false };
    }

    getTailCursor(): string | null {
        return null;
    }

    subscribe(): () => void {
        return () => {};
    }

    async getTitle(): Promise<string | null> {
        return null;
    }

    async getWorkingDirectory(): Promise<string | null> {
        return null;
    }

    async getActivity(): Promise<null> {
        return null;
    }

    async getPreview(): Promise<string | null> {
        return null;
    }
}

function buildKey(overrides?: Partial<FileBackedTranscriptSessionStoreKey>): FileBackedTranscriptSessionStoreKey {
    return {
        providerId: overrides?.providerId ?? 'claude',
        source: overrides?.source ?? { kind: 'claudeConfig', configDir: '/tmp/claude', projectId: 'proj-a' },
        remoteSessionId: overrides?.remoteSessionId ?? 'session-1',
    };
}

afterEach(() => {
    clearClaudeJsonlSessionStoreRegistriesForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('claudeJsonlSessionStoreRegistry', () => {
    it('does not keep the unused projected session store factory adapter', () => {
        expect(existsSync(new URL('./createClaudeJsonlSessionAdapter.ts', import.meta.url))).toBe(false);

        const barrelSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
        expect(barrelSource).not.toContain('createClaudeJsonlSessionStoreFactory');
        expect(barrelSource).not.toContain('createClaudeJsonlSessionAdapter');
    });

    it('clamps cache policy values to the documented Claude bounds', () => {
        const detachedGraceMs = resolveClaudeJsonlSessionStoreDetachedGraceMs({
            HAPPIER_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS: '1',
        } as NodeJS.ProcessEnv);
        const coldIdleMs = resolveClaudeJsonlSessionStoreColdIdleMs({
            HAPPIER_CLAUDE_JSONL_SESSION_STORE_COLD_IDLE_MS: '999999',
        } as NodeJS.ProcessEnv);

        expect(detachedGraceMs).toBe(5000);
        expect(coldIdleMs).toBe(300000);
    });

    it('reuses one warmed store per cache key while multiple leases are active', async () => {
        const created: TestStore[] = [];
        const registry = createClaudeJsonlSessionStoreRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => {
                const store = new TestStore();
                created.push(store);
                return store;
            },
        });

        const lease1 = await acquireClaudeJsonlSessionStore({
            key: buildKey(),
            registry,
        });
        const lease2 = await acquireClaudeJsonlSessionStore({
            key: buildKey(),
            registry,
        });

        expect(created).toHaveLength(1);
        expect(lease1.store).toBe(lease2.store);
        expect(created[0]?.warmCount).toBe(1);
        expect(created[0]?.lifecycleStates).toEqual(['hot_attached']);

        await lease1.release();
        await lease2.release();
    });

    it('releases the lease after withClaudeJsonlSessionStore resolves', async () => {
        vi.useFakeTimers();

        const registry = createClaudeJsonlSessionStoreRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => new TestStore(),
        });

        const store = await withClaudeJsonlSessionStore({
            key: buildKey(),
            registry,
        }, async (leasedStore) => {
            expect(leasedStore).toBeTruthy();
            return leasedStore;
        }) as TestStore;

        await vi.advanceTimersByTimeAsync(100);
        expect(store.lifecycleStates).toEqual(['hot_attached', 'warm_detached']);

        await vi.advanceTimersByTimeAsync(200);
        expect(store.lifecycleStates).toEqual(['hot_attached', 'warm_detached', 'cold_idle']);
    });
});
