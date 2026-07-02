import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionsProviderId, ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { ExternalSessionExecutionSurface, ExternalSessionProviderOps } from '@/session/external/providerOps';
import { createLocalHostedDirectTranscriptMirror } from '../createLocalHostedDirectTranscriptMirror';

const { resolveBackendExecutionSurfaces } = vi.hoisted(() => ({
    resolveBackendExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendExecutionSurfaces,
}));

afterEach(() => {
    resolveBackendExecutionSurfaces.mockReset();
});

describe('createLocalHostedDirectTranscriptMirror', () => {
    it('resolves provider ops through backend execution surfaces when no explicit ops are provided', async () => {
        const replaySources: Array<Record<string, unknown>> = [];
        const providerId = 'bridge-provider' as ExternalSessionsProviderId;
        const providerOps: ExternalSessionProviderOps = {
            validateSource: ({ source }) => ({ ok: true, source }),
            listCandidates: async () => ({ candidates: [], nextCursor: null }),
            getActivity: async () => ({ lastActivityAtMs: null, isRunning: false }),
            pageTranscript: async ({ source }) => {
                replaySources.push(source as Record<string, unknown>);
                return { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false };
            },
            readAfterTranscript: async () => ({ items: [], nextCursor: null, truncated: false }),
            resolveTakeoverSpawnOptions: async () => null,
        };
        resolveBackendExecutionSurfaces.mockResolvedValue({
            terminalRuntime: null,
            externalSession: providerOps,
            attach: null,
            handoff: null,
            fork: null,
            checkpoint: null,
        });

        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId,
                source: { kind: 'opencodeServer', directory: '/repo/requested' },
                remoteSessionId: 'session-1',
            },
            onItems: async () => {},
        });

        await mirror.start();
        await mirror.stop();

        expect(resolveBackendExecutionSurfaces).toHaveBeenCalledWith(providerId);
        expect(replaySources).toEqual([{ kind: 'opencodeServer', directory: '/repo/requested' }]);
    });

    it('fails closed when the bridge-resolved external session surface is missing', async () => {
        const providerId = 'bridge-provider' as ExternalSessionsProviderId;
        resolveBackendExecutionSurfaces.mockResolvedValue({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: null,
            fork: null,
            checkpoint: null,
        });

        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId,
                source: { kind: 'opencodeServer', directory: '/repo/requested' },
                remoteSessionId: 'session-1',
            },
            onItems: async () => {},
        });

        await expect(mirror.start()).rejects.toThrow(`Unsupported external-session provider: ${providerId}`);
        await mirror.stop();
    });

    it('fails closed when the bridge-resolved external session surface lacks required transcript operations', async () => {
        const providerOps: ExternalSessionExecutionSurface = {
            validateSource: ({ source }) => ({ ok: true, source }),
            pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
        };

        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId: 'bridge-provider' as ExternalSessionsProviderId,
                source: { kind: 'opencodeServer', directory: '/repo/requested' },
                remoteSessionId: 'session-1',
            },
            getProviderOps: async () => providerOps,
            onItems: async () => {},
        });

        await expect(mirror.start()).rejects.toThrow('missing readAfterTranscript');
        await mirror.stop();
    });

    it('uses the canonicalized validation source for replay and follow operations', async () => {
        const replaySources: Array<Record<string, unknown>> = [];
        const followSources: Array<Record<string, unknown>> = [];
        const canonicalSource = {
            kind: 'opencodeServer',
            baseUrl: 'http://127.0.0.1:4096/',
            directory: '/repo/canonical',
        } as const;

        const providerOps: ExternalSessionProviderOps = {
            validateSource: () => ({ ok: true, source: canonicalSource }),
            listCandidates: async () => ({ candidates: [], nextCursor: null }),
            getActivity: async () => ({ lastActivityAtMs: null, isRunning: false }),
            pageTranscript: async ({ source }) => {
                replaySources.push(source as Record<string, unknown>);
                return { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false };
            },
            readAfterTranscript: async () => ({ items: [], nextCursor: null, truncated: false }),
            acquireFollowLease: async ({ source }) => {
                followSources.push(source as Record<string, unknown>);
                return {
                    release: async () => {},
                    subscribeToTranscriptUpdates: () => () => {},
                };
            },
            resolveTakeoverSpawnOptions: async () => null,
        };

        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId: 'opencode',
                source: { kind: 'opencodeServer', directory: '/repo/requested' },
                remoteSessionId: 'session-1',
            },
            getProviderOps: async () => providerOps,
            onItems: async () => {},
        });

        await mirror.start();
        await mirror.stop();

        expect(replaySources).toEqual([canonicalSource]);
        expect(followSources).toEqual([canonicalSource]);
    });

    it('replays transcript history oldest-first and subscribes to follow updates', async () => {
        const observedIds: string[] = [];
        let followListener:
            | ((update: Readonly<{
                items: ExternalSessionTranscriptRawMessageV1[];
                nextCursor: string | null;
                truncated: boolean;
            }>) => void | Promise<void>)
            | null = null;
        const release = vi.fn(async () => {});
        const olderItem: ExternalSessionTranscriptRawMessageV1 = { id: 'older', createdAtMs: 1, raw: { id: 'older' } };
        const newerItem: ExternalSessionTranscriptRawMessageV1 = { id: 'newer', createdAtMs: 2, raw: { id: 'newer' } };
        const tailItem: ExternalSessionTranscriptRawMessageV1 = { id: 'tail', createdAtMs: 3, raw: { id: 'tail' } };

        const providerOps: ExternalSessionProviderOps = {
            validateSource: () => ({ ok: true, source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' } }),
            listCandidates: async () => ({ candidates: [], nextCursor: null }),
            getActivity: async () => ({ lastActivityAtMs: null, isRunning: false }),
            pageTranscript: async ({ cursor }) => {
                if (!cursor) {
                    return {
                        items: [newerItem],
                        nextCursor: 'cursor-1',
                        tailCursor: 'tail',
                        hasMore: true,
                        truncated: false,
                    };
                }
                return {
                    items: [olderItem],
                    nextCursor: null,
                    tailCursor: 'tail',
                    hasMore: false,
                    truncated: false,
                };
            },
            readAfterTranscript: async () => ({ items: [], nextCursor: null, truncated: false }),
            acquireFollowLease: async () => ({
                release,
                subscribeToTranscriptUpdates: (listener) => {
                    followListener = listener;
                    return () => {
                        followListener = null;
                    };
                },
            }),
            resolveTakeoverSpawnOptions: async () => null,
        };

        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId: 'ohMyPi',
                source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' },
                remoteSessionId: 'session-1',
            },
            getProviderOps: async () => providerOps,
            onItems: async (items) => {
                observedIds.push(...items.map((item) => item.id));
            },
        });

        await mirror.start();
        expect(followListener).toBeTypeOf('function');
        await followListener!({
            items: [tailItem],
            nextCursor: 'tail',
            truncated: false,
        });
        await mirror.stop();

        expect(observedIds).toEqual(['older', 'newer', 'tail']);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('bridges startup updates captured by the follow lease before subscription attaches', async () => {
        const observedIds: string[] = [];
        const olderItem: ExternalSessionTranscriptRawMessageV1 = { id: 'older', createdAtMs: 1, raw: { id: 'older' } };
        const liveItem: ExternalSessionTranscriptRawMessageV1 = { id: 'live', createdAtMs: 2, raw: { id: 'live' } };
        let followTailCursor: string | null = 'tail-before-live';
        const readAfterCalls: string[] = [];

        const providerOps: ExternalSessionProviderOps = {
            validateSource: () => ({ ok: true, source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' } }),
            listCandidates: async () => ({ candidates: [], nextCursor: null }),
            getActivity: async () => ({ lastActivityAtMs: null, isRunning: false }),
            pageTranscript: async () => {
                followTailCursor = 'tail-after-live';
                return {
                    items: [olderItem],
                    nextCursor: null,
                    tailCursor: 'tail-before-live',
                    hasMore: false,
                    truncated: false,
                };
            },
            readAfterTranscript: async ({ cursor }) => {
                readAfterCalls.push(cursor);
                return { items: [liveItem], nextCursor: 'tail-after-live', truncated: false };
            },
            acquireFollowLease: async () => ({
                release: async () => {},
                getTailCursor: () => followTailCursor,
                subscribeToTranscriptUpdates: (listener) => {
                    void listener({
                        items: [],
                        nextCursor: followTailCursor,
                        truncated: false,
                    });
                    return () => {
                        // Detached by the mirror on stop.
                    };
                },
            }),
            resolveTakeoverSpawnOptions: async () => null,
        };

        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId: 'ohMyPi',
                source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' },
                remoteSessionId: 'session-1',
            },
            getProviderOps: async () => providerOps,
            onItems: async (items) => {
                observedIds.push(...items.map((item) => item.id));
            },
        });

        await mirror.start();
        await mirror.stop();

        expect(readAfterCalls).toEqual(['tail-before-live']);
        expect(observedIds).toEqual(['older', 'live']);
    });

    it('bridges replay-to-follow handoff gaps with a read-after catch-up pass', async () => {
        const observedIds: string[] = [];
        const replayItem: ExternalSessionTranscriptRawMessageV1 = { id: 'replay', createdAtMs: 1, raw: { id: 'replay' } };
        const handoffItem: ExternalSessionTranscriptRawMessageV1 = { id: 'handoff', createdAtMs: 2, raw: { id: 'handoff' } };
        const readAfterCalls: string[] = [];

        const providerOps: ExternalSessionProviderOps = {
            validateSource: () => ({ ok: true, source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' } }),
            listCandidates: async () => ({ candidates: [], nextCursor: null }),
            getActivity: async () => ({ lastActivityAtMs: null, isRunning: false }),
            pageTranscript: async () => ({
                items: [replayItem],
                nextCursor: null,
                tailCursor: 'tail-before-handoff',
                hasMore: false,
                truncated: false,
            }),
            readAfterTranscript: async ({ cursor }) => {
                readAfterCalls.push(cursor);
                if (cursor === 'tail-before-handoff') {
                    return {
                        items: [handoffItem],
                        nextCursor: 'tail-with-handoff',
                        truncated: false,
                    };
                }
                return { items: [], nextCursor: 'tail-with-handoff', truncated: false };
            },
            acquireFollowLease: async () => ({
                release: async () => {},
                getTailCursor: () => 'tail-with-handoff',
                subscribeToTranscriptUpdates: () => () => {},
            }),
            resolveTakeoverSpawnOptions: async () => null,
        };

        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId: 'ohMyPi',
                source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' },
                remoteSessionId: 'session-1',
            },
            getProviderOps: async () => providerOps,
            onItems: async (items) => {
                observedIds.push(...items.map((item) => item.id));
            },
        });

        await mirror.start();
        await mirror.stop();

        expect(readAfterCalls).toEqual(['tail-before-handoff']);
        expect(observedIds).toEqual(['replay', 'handoff']);
    });

    it('fails when the binding source is invalid for the provider ops', async () => {
        const mirror = createLocalHostedDirectTranscriptMirror({
            binding: {
                providerId: 'ohMyPi',
                source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp' },
                remoteSessionId: 'session-1',
            },
            getProviderOps: async (): Promise<ExternalSessionProviderOps> => ({
                validateSource: () => ({ ok: false, error: 'invalid_source' }),
                listCandidates: async () => ({ candidates: [], nextCursor: null }),
                getActivity: async () => ({ lastActivityAtMs: null, isRunning: false }),
                pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
                readAfterTranscript: async () => ({ items: [], nextCursor: null, truncated: false }),
                resolveTakeoverSpawnOptions: async () => null,
            }),
            onItems: async () => {},
        });

        await expect(mirror.start()).rejects.toThrow('invalid_source');
    });
});
