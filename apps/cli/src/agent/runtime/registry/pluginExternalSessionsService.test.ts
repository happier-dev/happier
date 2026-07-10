import { describe, expect, it, vi } from 'vitest';

import type {
    ExternalSessionFollowLease,
    ExternalSessionProviderOps,
} from '@/session/external/providerOps';
import type { ExternalSessionRuntimeContextV1 } from '@happier-dev/agents';

import { createPluginExternalSessionsService } from './pluginExternalSessionsService';

const source = Object.freeze({ kind: 'codexHome', home: 'user' } as const);
type TranscriptUpdateListener = Parameters<NonNullable<ExternalSessionFollowLease['subscribeToTranscriptUpdates']>>[0];

function createRuntimeContext(): ExternalSessionRuntimeContextV1 {
    return Object.freeze({
        signal: new AbortController().signal,
        session: Object.freeze({
            sessionId: 'session-1',
            directory: '/repo',
        }),
        directories: Object.freeze({
            activeServerDir: '/repo',
        }),
        diagnostics: Object.freeze({
            issue: vi.fn(),
        }),
    });
}

function createProviderOps(overrides: Partial<ExternalSessionProviderOps> = {}): ExternalSessionProviderOps {
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
        const runtime = createRuntimeContext();
        const service = createPluginExternalSessionsService({
            defaultProviderId: 'codex',
            resolveProviderOps: async () => ops,
            resolveRuntimeContext: async () => runtime,
        });

        await expect(service.listCandidates({ source, searchTerm: 'repo' })).resolves.toEqual({
            candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }],
            nextCursor: 'next',
        });

        expect(ops.validateSource).toHaveBeenCalledWith({ source, runtime });
        expect(Object.prototype.hasOwnProperty.call(vi.mocked(ops.validateSource).mock.calls[0]?.[0] ?? {}, 'env')).toBe(false);
        expect(ops.listCandidates).toHaveBeenCalledWith({
            source,
            limit: 50,
            searchTerm: 'repo',
            runtime,
        });
    });

    it('pages and reads transcript rows through direct-session provider ops', async () => {
        const ops = createProviderOps();
        const service = createPluginExternalSessionsService({
            defaultProviderId: 'codex',
            resolveProviderOps: async () => ops,
        });

        await expect(service.pageTranscript({
            agentId: 'codex',
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
            agentId: 'codex',
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
        const runtime = createRuntimeContext();
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
            resolveRuntimeContext: async () => runtime,
        });

        const subscription = service.followTranscript({
            agentId: 'codex',
            remoteSessionId: 'remote-1',
            source,
            cursor: 'tail-1',
        }, onEvent);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(ops.acquireFollowLease).toHaveBeenCalledWith({
            source,
            remoteSessionId: 'remote-1',
            reason: 'attached_view',
            linkedSessionId: 'session-1',
            runtime,
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
