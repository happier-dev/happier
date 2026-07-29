import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';

const mocks = vi.hoisted(() => ({
    loadLinkedExternalSession: vi.fn(),
    readCredentials: vi.fn(),
    resolveExternalSessionObservationLinkInput: vi.fn(),
    resolveGenerationBoundExternalSessionFollowSurface: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession: mocks.loadLinkedExternalSession,
}));
vi.mock('@/persistence', () => ({
    readCredentials: mocks.readCredentials,
}));
vi.mock('@/api/session/external/leases/resolveExternalSessionObservationLinkInput', () => ({
    resolveExternalSessionObservationLinkInput:
        mocks.resolveExternalSessionObservationLinkInput,
}));
vi.mock('@/session/actions/externalSessions/providerOpsResolution', () => ({
    resolveGenerationBoundExternalSessionFollowSurface:
        mocks.resolveGenerationBoundExternalSessionFollowSurface,
}));

import { createExternalSessionFollowHostOperation } from './followHostOperation';

function readPublishedFollowStatus(call: readonly unknown[]): Readonly<{
    status: string;
    reason: string;
}> {
    const input = call[0] as Readonly<{
        followStatusV1: Readonly<{ status: string; reason: string }>;
    }>;
    return {
        status: input.followStatusV1.status,
        reason: input.followStatusV1.reason,
    };
}

const source = { kind: 'codexHome', home: 'user' } as const;
const ref = Object.freeze({
    agentId: 'codex',
    remoteSessionId: 'remote-1',
    sourceId: 'source-1',
});
const resource = Object.freeze({
    linkGeneration: 'link-generation-1',
    pluginGeneration: 'plugin-generation-1',
});
const linkedSession = Object.freeze({
    agentId: 'codex',
    linkGeneration: resource.linkGeneration,
    metadata: Object.freeze({}),
    remoteSessionId: ref.remoteSessionId,
    source,
    rawSession: null,
});
const observation = Object.freeze({
    resource: Object.freeze({
        agentId: 'codex',
        resourceKey: 'codex-home:user',
        pluginGeneration: resource.pluginGeneration,
    }),
    link: Object.freeze({
        sessionId: 'linked-session-1',
        linkKey: 'link-1',
        linkGeneration: resource.linkGeneration,
        remoteSessionId: ref.remoteSessionId,
        changeObservation: 'watch_file_changes' as const,
    }),
    target: Object.freeze({
        remoteSessionId: ref.remoteSessionId,
        source,
    }),
});

describe('createExternalSessionFollowHostOperation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readCredentials.mockResolvedValue({ token: 'token' });
        mocks.loadLinkedExternalSession.mockResolvedValue({
            ok: true,
            session: linkedSession,
        });
        mocks.resolveExternalSessionObservationLinkInput.mockResolvedValue(
            observation,
        );
    });

    it('follows the exact hosted transcript owner without creating or loading a sibling link', async () => {
        const pageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'cursor-hosted',
            hasMore: false,
            truncated: false,
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            providerOps: {
                pageTranscript,
                readAfterTranscript: vi.fn(async () => ({
                    outcome: 'already_current' as const,
                })),
            },
            resource: {
                ...resource,
                linkGeneration: 'hosted-session-1',
            },
        });
        mocks.loadLinkedExternalSession.mockImplementation(
            async ({ sessionId }: Readonly<{ sessionId: string }>) => {
                if (sessionId !== 'hosted-session-1') {
                    throw new Error(`unexpected sibling transcript owner: ${sessionId}`);
                }
                return {
                    ok: true,
                    session: {
                        ...linkedSession,
                        linkGeneration: 'hosted-session-1',
                    },
                };
            },
        );
        mocks.resolveExternalSessionObservationLinkInput.mockResolvedValue({
            ...observation,
            resource: {
                ...observation.resource,
                pluginGeneration: resource.pluginGeneration,
            },
            link: {
                ...observation.link,
                sessionId: 'hosted-session-1',
                linkGeneration: 'hosted-session-1',
                changeObservation: undefined,
            },
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: async (
                    { demanded }: Readonly<{ demanded: boolean }>,
                ) => ({
                    state: demanded ? 'observing' : 'idle',
                }),
            } as never,
        });

        const result = await operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'hosted-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: {},
            listener: async () => undefined,
            isCurrent: () => true,
        } as Parameters<typeof operation.execute>[0] & { sessionId: string });

        expect(result).toMatchObject({
            status: 'following',
            startingCursor: 'cursor-hosted',
        });
        expect(mocks.loadLinkedExternalSession).toHaveBeenCalledWith({
            credentials: { token: 'token' },
            sessionId: 'hosted-session-1',
            machineId: 'machine-1',
            expectedHostedIdentity: {
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source,
            },
        });
        if (result.status === 'following') {
            await result.subscription.dispose();
        }
    });

    it('turns one scoped D5 demand into content-free refresh and authoritative exact-six read-after data', async () => {
        const providerAcquireFollowLease = vi.fn();
        const pageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'cursor-1',
            hasMore: false,
            truncated: false,
        }));
        const readAfterTranscript = vi.fn(async () => ({
            outcome: 'advanced' as const,
            items: [{
                id: 'item-1',
                createdAtMs: 10,
                raw: { role: 'agent', text: 'authoritative' },
            }],
            nextCursor: 'cursor-2',
            boundary: 'boundary-2',
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            providerOps: {
                pageTranscript,
                readAfterTranscript,
                acquireFollowLease: providerAcquireFollowLease,
            },
            resource,
        });
        const transcriptDemand = vi.fn(async (
            { demanded }: Readonly<{ demanded: boolean }>,
        ) => ({
            state: demanded ? 'observing' : 'idle',
        }));
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: transcriptDemand,
            } as never,
        });
        const listener = vi.fn(async () => undefined);

        const result = await operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: {},
            listener,
            isCurrent: () => true,
        });

        expect(result).toMatchObject({
            status: 'following',
            startingCursor: 'cursor-1',
        });
        expect(transcriptDemand).toHaveBeenCalledTimes(1);
        expect(transcriptDemand).toHaveBeenLastCalledWith({
            resolved: observation,
            demanded: true,
        });
        await expect(followLeaseManager.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(readAfterTranscript).toHaveBeenCalledWith({
            source,
            remoteSessionId: ref.remoteSessionId,
            cursor: 'cursor-1',
            maxBytes: expect.any(Number),
            maxItems: expect.any(Number),
            signal: expect.any(AbortSignal),
        });
        expect(listener).toHaveBeenCalledWith({
            kind: 'data',
            items: [{
                id: 'item-1',
                timestampMs: 10,
                kind: 'agent',
                data: { role: 'agent', text: 'authoritative' },
            }],
            fromCursor: 'cursor-1',
            nextCursor: 'cursor-2',
        });
        expect(providerAcquireFollowLease).not.toHaveBeenCalled();
        if (result.status === 'following') {
            await result.subscription.dispose();
        }
        expect(transcriptDemand).toHaveBeenLastCalledWith({
            resolved: observation,
            demanded: false,
        });
    });

    it('does not advance the cursor until the listener acknowledges authoritative data', async () => {
        const readAfterTranscript = vi.fn(async (
            { cursor }: Readonly<{ cursor: string }>,
        ) => ({
            outcome: 'advanced' as const,
            items: [{
                id: `item-${cursor}`,
                raw: { role: 'agent', text: cursor },
            }],
            nextCursor: 'cursor-2',
            boundary: 'boundary-2',
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            providerOps: {
                pageTranscript: async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'cursor-1',
                    hasMore: false,
                    truncated: false,
                }),
                readAfterTranscript,
            },
            resource,
        });
        const writeFollowStatus = vi.fn(async () => {});
        const followLeaseManagerWithStatus = createExternalSessionFollowLeaseManager({
            now: () => 25_000,
            writeFollowStatus,
        });
        const operationWithStatus = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager: followLeaseManagerWithStatus,
            observationProjection: {
                reconcileTranscriptDemand: async (
                    { demanded }: Readonly<{ demanded: boolean }>,
                ) => ({
                    state: demanded ? 'observing' : 'idle',
                }),
            } as never,
        });
        const listener = vi.fn()
            .mockRejectedValueOnce(new Error('listener did not acknowledge'))
            .mockResolvedValue(undefined);
        const result = await operationWithStatus.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: { cursor: 'cursor-1' },
            listener,
            isCurrent: () => true,
        });
        expect(result.status).toBe('following');
        writeFollowStatus.mockClear();

        await followLeaseManagerWithStatus.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        });
        await followLeaseManagerWithStatus.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        });

        expect(readAfterTranscript).toHaveBeenCalledTimes(2);
        expect(readAfterTranscript.mock.calls.map(([input]) => input.cursor)).toEqual([
            'cursor-1',
            'cursor-1',
        ]);
        expect(writeFollowStatus.mock.calls.map(readPublishedFollowStatus)).toEqual([
            {
                status: 'error',
                reason: 'follow_refresh_failed',
            },
            {
                status: 'active',
                reason: 'follow_refresh_recovered',
            },
        ]);
        if (result.status === 'following') {
            await result.subscription.dispose();
        }
    });

    it.each([
        'source_replaced',
        'source_unavailable',
        'read_failed',
    ] as const)(
        'applies zero scoped items and publishes the typed %s follow outcome',
        async (outcome) => {
            const readAfterTranscript = vi.fn(async () => ({ outcome }));
            mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
                providerOps: {
                    pageTranscript: async () => ({
                        items: [],
                        nextCursor: null,
                        tailCursor: 'cursor-1',
                        hasMore: false,
                        truncated: false,
                    }),
                    readAfterTranscript,
                },
                resource,
            });
            const writeFollowStatus = vi.fn(async () => {});
            const followLeaseManager = createExternalSessionFollowLeaseManager({
                now: () => 30_000,
                writeFollowStatus,
            });
            const operation = createExternalSessionFollowHostOperation({
                machineId: 'machine-1',
                followLeaseManager,
                observationProjection: {
                    reconcileTranscriptDemand: async (
                        { demanded }: Readonly<{ demanded: boolean }>,
                    ) => ({
                        state: demanded ? 'observing' : 'idle',
                    }),
                } as never,
            });
            const listener = vi.fn(async () => undefined);
            const result = await operation.execute({
                pluginId: 'synthetic.non-bundled',
                contributionId: 'codex',
                generationId: resource.pluginGeneration,
                sessionId: 'linked-session-1',
                machineId: 'machine-1',
                ref,
                source,
                options: { cursor: 'cursor-1' },
                listener,
                isCurrent: () => true,
            });
            writeFollowStatus.mockClear();

            await followLeaseManager.requestTranscriptRefresh({
                sessionId: 'linked-session-1',
                resource,
            });

            expect(listener).not.toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'data' }),
            );
            expect(writeFollowStatus).toHaveBeenLastCalledWith({
                sessionId: 'linked-session-1',
                followStatusV1: {
                    v: 1,
                    status: 'error',
                    reason: `follow_refresh_${outcome}`,
                    updatedAtMs: 30_000,
                },
                lastFollowIssueV1: {
                    v: 1,
                    code: `follow_refresh_${outcome}`,
                    retryable: true,
                    observedAtMs: 30_000,
                },
            });
            if (result.status === 'following') {
                await result.subscription.dispose();
            }
        },
    );

    it('performs one bounded authoritative scoped resync for a gap before advancing its cursor', async () => {
        const readAfterTranscript = vi.fn()
            .mockResolvedValueOnce({ outcome: 'gap_or_cursor_expired' })
            .mockResolvedValueOnce({ outcome: 'already_current' });
        const pageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'cursor-resynced',
            hasMore: false,
            truncated: false,
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            providerOps: {
                pageTranscript,
                readAfterTranscript,
            },
            resource,
        });
        const writeFollowStatus = vi.fn(async () => {});
        const followLeaseManager = createExternalSessionFollowLeaseManager({
            now: () => 35_000,
            writeFollowStatus,
        });
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: async (
                    { demanded }: Readonly<{ demanded: boolean }>,
                ) => ({
                    state: demanded ? 'observing' : 'idle',
                }),
            } as never,
        });
        const listener = vi.fn(async () => undefined);
        const result = await operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: { cursor: 'cursor-1' },
            listener,
            isCurrent: () => true,
        });
        writeFollowStatus.mockClear();

        await followLeaseManager.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        });
        await followLeaseManager.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        });

        expect(pageTranscript).toHaveBeenCalledOnce();
        expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
            direction: 'older',
            maxItems: 200,
        }));
        expect(readAfterTranscript.mock.calls.map(([input]) => input.cursor)).toEqual([
            'cursor-1',
            'cursor-resynced',
        ]);
        expect(listener.mock.calls).toEqual([[
            {
                kind: 'resyncRequired',
                reason: 'cursorDiscontinuity',
                cursor: 'cursor-1',
            },
        ]]);
        expect(writeFollowStatus.mock.calls.map(readPublishedFollowStatus)).toEqual([
            {
                status: 'reacquiring',
                reason: 'follow_refresh_gap_or_cursor_expired',
            },
            {
                status: 'active',
                reason: 'follow_refresh_resynced',
            },
        ]);
        if (result.status === 'following') {
            await result.subscription.dispose();
        }
    });

    it('fences an in-flight viewer refresh across suspension and resumes from the last accepted cursor', async () => {
        let resolveFirstRead: ((value: Readonly<{
            outcome: 'advanced';
            items: readonly Readonly<{
                id: string;
                createdAtMs: number;
                raw: Readonly<{ role: string; text: string }>;
            }>[];
            nextCursor: string;
            boundary: string;
        }>) => void) | undefined;
        const firstRead = new Promise<Readonly<{
            outcome: 'advanced';
            items: readonly Readonly<{
                id: string;
                createdAtMs: number;
                raw: Readonly<{ role: string; text: string }>;
            }>[];
            nextCursor: string;
            boundary: string;
        }>>((resolve) => {
            resolveFirstRead = resolve;
        });
        const readAfterTranscript = vi.fn()
            .mockImplementationOnce(async () => await firstRead)
            .mockResolvedValueOnce({
                outcome: 'advanced' as const,
                items: [{
                    id: 'item-current',
                    createdAtMs: 30,
                    raw: { role: 'agent', text: 'current' },
                }],
                nextCursor: 'cursor-current',
                boundary: 'boundary-current',
            });
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            providerOps: {
                pageTranscript: async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'cursor-accepted',
                    hasMore: false,
                    truncated: false,
                }),
                readAfterTranscript,
            },
            resource,
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: async (
                    { demanded }: Readonly<{ demanded: boolean }>,
                ) => ({
                    state: demanded ? 'observing' : 'idle',
                }),
            } as never,
        });
        const listener = vi.fn(async () => undefined);
        const result = await operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: { cursor: 'cursor-accepted' },
            listener,
            isCurrent: () => true,
        });

        const refresh = followLeaseManager.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        });
        await vi.waitFor(() => expect(readAfterTranscript).toHaveBeenCalledOnce());
        await followLeaseManager.suspendSession({
            sessionId: 'linked-session-1',
            reason: 'takeover',
        });
        resolveFirstRead?.({
            outcome: 'advanced',
            items: [{
                id: 'item-stale',
                createdAtMs: 20,
                raw: { role: 'agent', text: 'stale' },
            }],
            nextCursor: 'cursor-stale',
            boundary: 'boundary-stale',
        });
        await refresh;

        expect(listener).not.toHaveBeenCalled();

        await followLeaseManager.resumeSession({
            sessionId: 'linked-session-1',
            reason: 'takeover',
        });

        expect(readAfterTranscript.mock.calls.map(([input]) => input.cursor)).toEqual([
            'cursor-accepted',
            'cursor-accepted',
        ]);
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'data',
            nextCursor: 'cursor-current',
        }));
        if (result.status === 'following') {
            await result.subscription.dispose();
        }
    });

    it('fails closed for stale identity and current-generation retirement before acquisition', async () => {
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(),
            } as never,
        });

        await expect(operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'other-machine',
            ref,
            source,
            options: {},
            listener: vi.fn(),
            isCurrent: () => true,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_mismatch',
        });
        await expect(operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: {},
            listener: vi.fn(),
            isCurrent: () => false,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
    });

    it('releases D5 demand and emits one terminal event on caller abort or generation retirement', async () => {
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            providerOps: {
                pageTranscript: async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'cursor-1',
                    hasMore: false,
                    truncated: false,
                }),
                readAfterTranscript: async () => ({
                    outcome: 'already_current',
                }),
            },
            resource,
        });
        const transcriptDemand = vi.fn(async (
            { demanded }: Readonly<{ demanded: boolean }>,
        ) => ({
            state: demanded ? 'observing' : 'idle',
        }));
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: transcriptDemand,
            } as never,
        });
        const caller = new AbortController();
        const retirement = new AbortController();
        const listener = vi.fn(async () => undefined);
        const result = await operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: { signal: caller.signal },
            listener,
            retirementSignal: retirement.signal,
            isCurrent: () => !retirement.signal.aborted,
        });
        expect(result.status).toBe('following');

        caller.abort();
        retirement.abort();
        await vi.waitFor(() => expect(transcriptDemand).toHaveBeenLastCalledWith({
            resolved: observation,
            demanded: false,
        }));
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith({
            kind: 'terminated',
            reason: 'aborted',
            cursor: 'cursor-1',
            code: 'plugin_operation_aborted',
        });
    });
});
