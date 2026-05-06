import { describe, expect, it, vi } from 'vitest';

import type {
    DirectSessionFollowLease,
    DirectSessionProviderOps,
} from '@/session/external/providerOps';

import { createPluginExternalSessionsService } from './pluginExternalSessionsService';

const source = Object.freeze({ kind: 'codexHome', home: 'user' } as const);
type TranscriptUpdateListener = Parameters<NonNullable<DirectSessionFollowLease['subscribeToTranscriptUpdates']>>[0];

function createProviderOps(overrides: Partial<DirectSessionProviderOps> = {}): DirectSessionProviderOps {
    return {
        validateSource: vi.fn(async ({ source: inputSource }) => ({ ok: true as const, source: inputSource })),
        listCandidates: vi.fn(async () => ({
            candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }],
            nextCursor: 'next',
        })),
        getActivity: vi.fn(async () => ({ lastActivityAtMs: 1, isRunning: true })),
        pageTranscript: vi.fn(async () => ({
            items: [{ id: 'msg-1', createdAtMs: 1, raw: { text: 'hello' } }],
            nextCursor: 'older',
            tailCursor: 'tail-1',
            hasMore: true,
            truncated: false,
        })),
        readAfterTranscript: vi.fn(async () => ({
            items: [{ id: 'msg-2', createdAtMs: 2, raw: { text: 'newer' } }],
            nextCursor: 'tail-2',
            truncated: false,
        })),
        acquireFollowLease: vi.fn(async () => ({
            release: vi.fn(async () => undefined),
            subscribeToTranscriptUpdates: (listener: TranscriptUpdateListener) => {
                void listener({ items: [{ id: 'msg-3', createdAtMs: 3, raw: { text: 'live' } }], nextCursor: 'tail-3', truncated: false });
                return vi.fn();
            },
        })),
        resolveTakeoverSpawnOptions: vi.fn(async () => null),
        ...overrides,
    };
}

describe('createPluginExternalSessionsService', () => {
    it('lists candidates through direct-session provider ops with bounded defaults', async () => {
        const ops = createProviderOps();
        const service = createPluginExternalSessionsService({
            defaultProviderId: 'codex',
            resolveProviderOps: async () => ops,
        });

        await expect(service.listCandidates({ source, searchTerm: 'repo' })).resolves.toEqual({
            candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }],
            nextCursor: 'next',
        });

        expect(ops.validateSource).toHaveBeenCalledWith({ source, env: process.env });
        expect(ops.listCandidates).toHaveBeenCalledWith({
            source,
            limit: 50,
            searchTerm: 'repo',
        });
    });

    it('pages and reads transcript rows through direct-session provider ops', async () => {
        const ops = createProviderOps();
        const service = createPluginExternalSessionsService({
            defaultProviderId: 'codex',
            resolveProviderOps: async () => ops,
        });

        await expect(service.pageTranscript({
            providerId: 'codex',
            remoteSessionId: 'remote-1',
            source,
            direction: 'older',
        })).resolves.toEqual({
            ok: true,
            items: [{ id: 'msg-1', createdAtMs: 1, raw: { text: 'hello' } }],
            nextCursor: 'older',
            tailCursor: 'tail-1',
            hasMore: true,
            truncated: false,
        });

        await expect(service.readAfterTranscript({
            providerId: 'codex',
            remoteSessionId: 'remote-1',
            source,
            cursor: 'tail-1',
        })).resolves.toEqual({
            ok: true,
            items: [{ id: 'msg-2', createdAtMs: 2, raw: { text: 'newer' } }],
            nextCursor: 'tail-2',
            truncated: false,
        });

        expect(ops.pageTranscript).toHaveBeenCalledWith({
            source,
            remoteSessionId: 'remote-1',
            direction: 'older',
            maxBytes: 512_000,
            maxItems: 200,
        });
        expect(ops.readAfterTranscript).toHaveBeenCalledWith({
            source,
            remoteSessionId: 'remote-1',
            cursor: 'tail-1',
            maxBytes: 512_000,
            maxItems: 200,
        });
    });

    it('follows transcript updates and releases the lease on unsubscribe', async () => {
        const release = vi.fn(async () => undefined);
        const unsubscribe = vi.fn();
        const ops = createProviderOps({
            acquireFollowLease: vi.fn(async () => ({
                release,
                subscribeToTranscriptUpdates: (listener: TranscriptUpdateListener) => {
                    void listener({ items: [{ id: 'msg-live', createdAtMs: 3, raw: {} }], nextCursor: 'tail-live', truncated: false });
                    return unsubscribe;
                },
            })),
        });
        const onEvent = vi.fn();
        const service = createPluginExternalSessionsService({
            defaultProviderId: 'codex',
            resolveProviderOps: async () => ops,
        });

        const subscription = service.followTranscript({
            providerId: 'codex',
            remoteSessionId: 'remote-1',
            source,
            cursor: 'tail-1',
        }, onEvent);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(ops.acquireFollowLease).toHaveBeenCalledWith({
            source,
            remoteSessionId: 'remote-1',
            reason: 'attached_view',
        });
        expect(onEvent).toHaveBeenCalledWith({
            items: [{ id: 'msg-live', createdAtMs: 3, raw: {} }],
            nextCursor: 'tail-live',
        });

        subscription.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
    });
});
