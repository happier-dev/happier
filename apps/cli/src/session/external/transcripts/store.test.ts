import { describe, expect, it } from 'vitest';

import type {
    ExternalSessionsSource,
    ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';
import type { FileBackedTranscriptSessionStore } from '@/api/session/fileBackedTranscripts/store';

import {
    createExternalSessionTranscriptStoreService,
    type ExternalSessionTranscriptStoreAdapter,
} from './store';

const source = {
    kind: 'codexHome',
    home: 'user',
    homePath: '/home/user/.codex',
} satisfies ExternalSessionsSource;

function createRawMessage(id: string, createdAtMs: number, text: string): ExternalSessionTranscriptRawMessageV1 {
    return {
        id,
        createdAtMs,
        raw: { text },
    };
}

function createStore(): FileBackedTranscriptSessionStore<ExternalSessionTranscriptRawMessageV1, { lastActivityAtMs: number }, string | null> {
    return {
        warm: async () => undefined,
        dispose: async () => undefined,
        setLifecycleState: async () => undefined,
        pageOlder: async (params?: unknown) => ({
            items: [createRawMessage('msg-1', 1, 'hello')],
            nextCursor: 'older-cursor',
            hasMore: true,
            tailCursor: 'tail-cursor',
            truncated: false,
            params,
        }),
        readAfter: async (params?: unknown) => ({
            items: [createRawMessage('msg-2', 2, 'world')],
            nextCursor: 'after-cursor',
            truncated: true,
            params,
        }),
        getTailCursor: () => 'tail-cursor',
        subscribe: () => () => undefined,
        getTitle: async () => 'Session title',
        getWorkingDirectory: async () => '/repo/project',
        getActivity: async () => ({ lastActivityAtMs: 42 }),
        getPreview: async () => 'preview',
    };
}

describe('external-session transcript store service', () => {
    it('delegates page/read/activity/metadata/follow requests through the matching provider adapter', async () => {
        const releases: string[] = [];
        const store = createStore();
        const adapter: ExternalSessionTranscriptStoreAdapter = {
            providerId: 'codex',
            withStore: async (_input, handler) => await handler(store),
            acquireStore: async (input) => ({
                key: {
                    providerId: input.providerId,
                    source: input.source,
                    remoteSessionId: input.providerSessionId,
                },
                store,
                release: async () => {
                    releases.push(input.providerSessionId);
                },
            }),
            resolveFollowTranscriptPath: async (input) => ({
                path: `/transcripts/${input.providerSessionId}.jsonl`,
                sourceId: input.providerSessionId,
            }),
            getProviderHome: async () => '/home/user/.codex',
        };
        const service = createExternalSessionTranscriptStoreService({ adapters: [adapter] });
        expect(Object.isFrozen(service)).toBe(true);

        await expect(service.getActivity({ providerId: 'codex', source, providerSessionId: 'codex-1' }))
            .resolves.toEqual({ lastActivityAtMs: 42, isRunning: false });
        await expect(service.page({
            providerId: 'codex',
            source,
            providerSessionId: 'codex-1',
            direction: 'older',
            maxBytes: 4096,
            maxItems: 10,
        })).resolves.toMatchObject({
            nextCursor: 'older-cursor',
            tailCursor: 'tail-cursor',
            hasMore: true,
            truncated: false,
        });
        await expect(service.readAfter({
            providerId: 'codex',
            source,
            providerSessionId: 'codex-1',
            cursor: 'tail-cursor',
            maxBytes: 4096,
            maxItems: 10,
        })).resolves.toMatchObject({
            nextCursor: 'after-cursor',
            truncated: true,
        });
        await expect(service.getWorkingDirectory({ providerId: 'codex', source, providerSessionId: 'codex-1' }))
            .resolves.toBe('/repo/project');
        await expect(service.getProviderHome({ providerId: 'codex', source, providerSessionId: 'codex-1' }))
            .resolves.toBe('/home/user/.codex');
        await expect(service.resolveFollowTranscriptPath({
            providerId: 'codex',
            source,
            providerSessionId: 'codex-1',
            reason: 'attached_view',
        })).resolves.toEqual({ path: '/transcripts/codex-1.jsonl', sourceId: 'codex-1' });

        const lease = await service.acquireFollowLease({
            providerId: 'codex',
            source,
            providerSessionId: 'codex-1',
            reason: 'attached_view',
        });
        expect(lease.getTailCursor?.()).toBe('tail-cursor');
        await lease.release();
        expect(releases).toEqual(['codex-1']);
    });

    it('fails closed when no transcript adapter owns the provider', async () => {
        const service = createExternalSessionTranscriptStoreService({ adapters: [] });

        await expect(service.page({
            providerId: 'codex',
            source,
            providerSessionId: 'codex-1',
            direction: 'older',
            maxBytes: 4096,
            maxItems: 10,
        })).rejects.toThrow(/transcript store adapter/i);
    });
});
