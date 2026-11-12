import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareWarmCacheEncryptionKey } from './warmCacheEncryptionKey';
import { resetReactNativeMmkvStub } from '@/dev/reactNativeMmkvStub';
import { MMKV } from 'react-native-mmkv';

import {
    deleteEvictedSessionTranscript,
    hydrateEvictedSessionTranscript,
    persistEvictedSessionTranscript,
    readEvictedSessionTranscript,
} from './sessionTranscriptDiskCache';

// Uses the shared global MMKV stub (vitestSetup) rather than a file-local mock: the stub is the
// single owner of the storage boundary surface in tests, and resetReactNativeMmkvStub clears it
// in place exactly like the canonical warm-cache persistence tests do.

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const otherScope = { serverId: 'server-b', accountId: 'account-b' } as const;

function message(id: string, text: string) {
    return { id, seq: 1, createdAt: 1_000, kind: 'user-text', text } as any;
}
function transcriptOf(...messages: readonly any[]) {
    const messagesById: Record<string, any> = {};
    for (const m of messages) messagesById[m.id] = m;
    return { messageIdsOldestFirst: messages.map((m) => m.id), messagesById };
}

describe('sessionTranscriptDiskCache', () => {
    beforeEach(async () => {
        // Nothing reads or writes the cache until its at-rest key resolves, exactly as on a device.
        resetReactNativeMmkvStub();
        await prepareWarmCacheEncryptionKey();
    });

    it('roundtrips a transcript oldest-first under its server+account scope', () => {
        const transcript = transcriptOf(message('m1', 'hello'), message('m2', 'world'));

        expect(persistEvictedSessionTranscript(scope, 's1', transcript)).toBe(true);

        const restored = readEvictedSessionTranscript(scope, 's1') as readonly any[] | null;
        expect(restored?.map((m) => m.id)).toEqual(['m1', 'm2']);
        expect(restored?.[1]?.text).toBe('world');
        // Scope isolation: another server/account scope has no copy.
        expect(readEvictedSessionTranscript(otherScope, 's1')).toBeNull();
    });

    it('skips persistence without a scope or with an empty transcript, and retires a stale copy', () => {
        expect(persistEvictedSessionTranscript(null, 's1', transcriptOf(message('m1', 'x')))).toBe(false);
        expect(persistEvictedSessionTranscript(scope, 's1', transcriptOf())).toBe(false);

        expect(persistEvictedSessionTranscript(scope, 's1', transcriptOf(message('m1', 'x')))).toBe(true);
        expect(persistEvictedSessionTranscript(scope, 's1', transcriptOf())).toBe(false);
        expect(readEvictedSessionTranscript(scope, 's1')).toBeNull();
    });

    it('treats a corrupt record as a miss and deletes it', () => {
        persistEvictedSessionTranscript(scope, 's1', transcriptOf(message('m1', 'x')));
        // Corrupt every session-transcript key the stub holds.
        const storage = new MMKV({ id: 'warm-cache-v2' });
        for (const key of storage.getAllKeys()) {
            if (key.startsWith('session-transcript-v1:')) storage.set(key, '{not-json');
        }

        expect(readEvictedSessionTranscript(scope, 's1')).toBeNull();
        expect(storage.getAllKeys().some((key) => key.startsWith('session-transcript-v1:'))).toBe(false);
    });

    it('deletes the persisted copy', () => {
        persistEvictedSessionTranscript(scope, 's1', transcriptOf(message('m1', 'x')));
        deleteEvictedSessionTranscript(scope, 's1');
        expect(readEvictedSessionTranscript(scope, 's1')).toBeNull();
    });

    describe('hydrateEvictedSessionTranscript', () => {
        it('applies the persisted baseline through the canonical ingest when the store is empty', () => {
            persistEvictedSessionTranscript(scope, 's1', transcriptOf(message('m1', 'hello')));
            const applied: any[][] = [];
            const applyMessages = vi.fn((_sessionId: string, messages: readonly any[]) => {
                applied.push([...messages]);
            });

            expect(hydrateEvictedSessionTranscript({
                scope,
                sessionId: 's1',
                hasMaterializedMessages: false,
                applyMessages,
            })).toBe(true);
            expect(applied).toHaveLength(1);
            expect(applied[0]!.map((m: any) => m.id)).toEqual(['m1']);
        });

        it('never overrides a store that already has materialized messages', () => {
            persistEvictedSessionTranscript(scope, 's1', transcriptOf(message('m1', 'hello')));
            const applyMessages = vi.fn();

            expect(hydrateEvictedSessionTranscript({
                scope,
                sessionId: 's1',
                hasMaterializedMessages: true,
                applyMessages,
            })).toBe(false);
            expect(applyMessages).not.toHaveBeenCalled();
        });

        it('is a no-op without a scope or a persisted copy', () => {
            const applyMessages = vi.fn();
            expect(hydrateEvictedSessionTranscript({
                scope: null,
                sessionId: 's1',
                hasMaterializedMessages: false,
                applyMessages,
            })).toBe(false);
            expect(hydrateEvictedSessionTranscript({
                scope,
                sessionId: 'never-persisted',
                hasMaterializedMessages: false,
                applyMessages,
            })).toBe(false);
            expect(applyMessages).not.toHaveBeenCalled();
        });
    });
});
