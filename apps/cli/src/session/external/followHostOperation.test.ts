import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import type { HostExternalTranscriptFollowEvent } from './privateContract';
import type { ExternalSessionTranscriptReadAfter } from './providerOps';
import { createExternalSessionHostOperationOwner } from './hostOperationOwner';

const mocks = vi.hoisted(() => ({
    loadLinkedExternalSession: vi.fn(),
    readCredentials: vi.fn(),
    readStoredCredentials: vi.fn(),
    resolveExternalSessionObservationLinkInput: vi.fn(),
    resolveGenerationBoundExternalSessionFollowSurface: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession: mocks.loadLinkedExternalSession,
}));
vi.mock('@/persistence', () => ({
    readCredentials: mocks.readCredentials,
    readStoredCredentials: mocks.readStoredCredentials,
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
        mocks.readCredentials.mockResolvedValue(null);
        mocks.readStoredCredentials.mockResolvedValue({ token: 'token', encryption: null });
        mocks.loadLinkedExternalSession.mockResolvedValue({
            ok: true,
            session: linkedSession,
        });
        mocks.resolveExternalSessionObservationLinkInput.mockResolvedValue(
            observation,
        );
    });

    it('forwards the canonical disposed acknowledgement through the daemon host-operation owner', async () => {
        const pageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'cursor-1',
            hasMore: false,
            truncated: false,
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
            providerOps: {
                pageTranscript,
                readAfterTranscript: vi.fn(async () => ({
                    outcome: 'already_current' as const,
                })),
            },
            resource,
        });
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager: createExternalSessionFollowLeaseManager(),
            observationProjection: {
                reconcileTranscriptDemand: async (
                    { demanded }: Readonly<{ demanded: boolean }>,
                ) => ({ state: demanded ? 'observing' : 'idle' }),
            } as never,
        });
        const owner = createExternalSessionHostOperationOwner();
        await owner.install({
            followOperation: operation,
        });
        const binding = owner.bind({
            pluginId: 'synthetic.non-bundled',
            agentId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            readAccountRevision: () => 'account-1',
            isGenerationCurrent: () => true,
        });
        const listener = vi.fn(async (_event: HostExternalTranscriptFollowEvent) => undefined);
        const result = await binding.executeFollow({
            ref,
            source,
            options: {},
            listener,
        });
        expect(result.status).toBe('following');
        if (result.status !== 'following') throw new Error('expected follow');

        await result.subscription.dispose();

        expect(listener).toHaveBeenCalledWith({
            kind: 'terminated',
            reason: 'disposed',
            cursor: 'cursor-1',
        });
        await binding.retire();
        await owner.retire();
    });

    it('retains the exact scoped lease when disposal cleanup fails so the caller can retry it', async () => {
        const cleanupFailure = new Error('scoped lease cleanup failed');
        const release = vi.fn()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValueOnce(undefined);
        const pageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'cursor-1',
            hasMore: false,
            truncated: false,
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
            providerOps: {
                pageTranscript,
                readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
            },
            resource,
        });
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager: {
                attachScoped: vi.fn(async () => ({ release })),
            } as never,
            observationProjection: {
                reconcileTranscriptDemand: async () => ({ state: 'observing' }),
            } as never,
        });
        const listener = vi.fn(async (_event: HostExternalTranscriptFollowEvent) => undefined);

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
        expect(result.status).toBe('following');
        if (result.status !== 'following') throw new Error('expected follow');

        await expect(result.subscription.dispose()).rejects.toBe(cleanupFailure);
        await expect(result.subscription.dispose()).resolves.toBeUndefined();

        expect(release).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.filter(([event]) => event.kind === 'terminated')).toHaveLength(1);
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
            immutablePluginGenerationId: resource.pluginGeneration,
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
            credentials: { token: 'token', encryption: null },
            sessionId: 'hosted-session-1',
            machineId: 'machine-1',
            expectedIdentity: {
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

    it('durably replays initial pages in chronological order before following their captured tail', async () => {
        const pageTranscript = vi.fn(async (request: Readonly<{
            direction: 'older' | 'newer';
            cursor?: string;
            deadlineAtMs?: number;
        }>) => {
            if (request.direction === 'older' && request.cursor === undefined) {
                return {
                    items: [{ id: 'newer', localId: 'fact-newer', createdAtMs: 2, raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: 'newer' } } } }],
                    nextCursor: 'backward-1',
                    tailCursor: 'captured-tail',
                    hasMore: true,
                    truncated: false,
                };
            }
            if (request.direction === 'older' && request.cursor === 'backward-1') {
                return {
                    items: [{ id: 'older', localId: 'fact-older', createdAtMs: 1, raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: 'older' } } } }],
                    nextCursor: null,
                    tailCursor: 'captured-tail',
                    hasMore: false,
                    truncated: false,
                };
            }
            throw new Error('unexpected page request');
        });
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
            providerOps: {
                pageTranscript,
                readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
            },
            resource,
        });
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager: createExternalSessionFollowLeaseManager(),
            observationProjection: {
                reconcileTranscriptDemand: async ({ demanded }: Readonly<{ demanded: boolean }>) => ({
                    state: demanded ? 'observing' : 'idle',
                }),
            } as never,
        });
        const listener = vi.fn(async (_event: HostExternalTranscriptFollowEvent) => undefined);
        const admissionDeadlineAtMs = Date.now() + 30_000;

        const result = await operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: { initialReplay: true, admissionDeadlineAtMs },
            listener,
            isCurrent: () => true,
        } as Parameters<typeof operation.execute>[0]);

        expect(result).toMatchObject({
            status: 'following',
            startingCursor: 'captured-tail',
        });
        expect(listener.mock.calls.map((call) => call[0])).toEqual([
            expect.objectContaining({
                kind: 'data',
                phase: 'initial_replay',
                fromCursor: null,
                nextCursor: 'backward-1',
                items: [expect.objectContaining({ id: 'older', localId: 'fact-older' })],
            }),
            expect.objectContaining({
                kind: 'data',
                phase: 'initial_replay',
                fromCursor: 'backward-1',
                nextCursor: 'captured-tail',
                items: [expect.objectContaining({ id: 'newer', localId: 'fact-newer' })],
            }),
        ]);
        expect(pageTranscript.mock.calls.every(([request]) =>
            request.deadlineAtMs === admissionDeadlineAtMs)).toBe(true);
        if (result.status === 'following') await result.subscription.dispose();
    });

    it('fails initial replay before page 101 without admitting a live follow or jumping to a tail', async () => {
        let page = 0;
        const pageTranscript = vi.fn(async () => {
            page += 1;
            return {
                items: [],
                nextCursor: `cursor-${page}`,
                tailCursor: 'unaccounted-tail',
                hasMore: true,
                truncated: false,
            };
        });
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
            providerOps: {
                pageTranscript,
                readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
            },
            resource,
        });
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const attachScoped = vi.spyOn(followLeaseManager, 'attachScoped');
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection: {
                reconcileTranscriptDemand: async () => ({ state: 'idle' }),
            } as never,
        });

        await expect(operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: {
                initialReplay: true,
                admissionDeadlineAtMs: Date.now() + 30_000,
            },
            listener: async () => undefined,
            isCurrent: () => true,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_resync_required',
        });
        expect(pageTranscript).toHaveBeenCalledTimes(100);
        expect(attachScoped).not.toHaveBeenCalled();
    });

    it('fails an expired whole-admission deadline before the first provider page', async () => {
        const pageTranscript = vi.fn();
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
            providerOps: {
                pageTranscript,
                readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
            },
            resource,
        });
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager: createExternalSessionFollowLeaseManager(),
            observationProjection: {
                reconcileTranscriptDemand: async () => ({ state: 'idle' }),
            } as never,
        });

        await expect(operation.execute({
            pluginId: 'synthetic.non-bundled',
            contributionId: 'codex',
            generationId: resource.pluginGeneration,
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            ref,
            source,
            options: { initialReplay: true, admissionDeadlineAtMs: 0 },
            listener: async () => undefined,
            isCurrent: () => true,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_resync_required',
        });
        expect(pageTranscript).not.toHaveBeenCalled();
    });

    it('applies cumulative item and serialized-byte ceilings across replay pages', async () => {
        const cases = [
            {
                makeItems: (page: number) => Array.from({ length: 200 }, (_, index) => ({
                    id: `item-${page}-${index}`,
                    createdAtMs: index,
                    raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: 'x' } } },
                })),
                maximumCalls: 51,
            },
            {
                makeItems: (page: number) => Array.from({ length: 200 }, (_, index) => ({
                    id: `item-${page}-${index}`,
                    createdAtMs: index,
                    raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: 'x'.repeat(2_500) } } },
                })),
                maximumCalls: 8,
            },
        ] as const;

        for (const replayCase of cases) {
            let page = 0;
            const pageTranscript = vi.fn(async () => {
                page += 1;
                return {
                    items: replayCase.makeItems(page),
                    nextCursor: `cursor-${page}`,
                    tailCursor: 'unaccounted-tail',
                    hasMore: true,
                    truncated: false,
                };
            });
            mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
                immutablePluginGenerationId: resource.pluginGeneration,
                providerOps: {
                    pageTranscript,
                    readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
                },
                resource,
            });
            const operation = createExternalSessionFollowHostOperation({
                machineId: 'machine-1',
                followLeaseManager: createExternalSessionFollowLeaseManager(),
                observationProjection: {
                    reconcileTranscriptDemand: async () => ({ state: 'idle' }),
                } as never,
            });

            await expect(operation.execute({
                pluginId: 'synthetic.non-bundled',
                contributionId: 'codex',
                generationId: resource.pluginGeneration,
                sessionId: 'linked-session-1',
                machineId: 'machine-1',
                ref,
                source,
                options: {
                    initialReplay: true,
                    admissionDeadlineAtMs: Date.now() + 30_000,
                },
                listener: async () => undefined,
                isCurrent: () => true,
            })).resolves.toEqual({
                status: 'unavailable',
                code: 'plugin_external_follow_resync_required',
            });
            expect(pageTranscript).toHaveBeenCalledTimes(replayCase.maximumCalls);
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
                raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: 'authoritative' } } },
            }],
            nextCursor: 'cursor-2',
            boundary: 'boundary-2',
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
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
                data: {
                    role: 'agent',
                    content: { type: 'output', data: { type: 'message', message: 'authoritative' } },
                },
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
                raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: cursor } } },
            }],
            nextCursor: 'cursor-2',
            boundary: 'boundary-2',
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
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
        // The second request lands while the first refresh is still in flight,
        // so the manager coalesces it into a follow-up pass. Wait for that pass
        // rather than asserting on the in-flight snapshot.
        await followLeaseManagerWithStatus.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        });
        await vi.waitFor(() => {
            expect(readAfterTranscript).toHaveBeenCalledTimes(2);
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
                immutablePluginGenerationId: resource.pluginGeneration,
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
                expectedLinkGeneration: 'link-generation-1',
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

    it('terminates the terminal binding when its current source is replaced', async () => {
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
        const listener = vi.fn(async (_event: HostExternalTranscriptFollowEvent) => undefined);
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
            providerOps: {
                pageTranscript: async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'cursor-1',
                    hasMore: false,
                    truncated: false,
                }),
                readAfterTranscript: async () => ({ outcome: 'source_replaced' as const }),
            },
            resource,
        });

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
        } as Parameters<typeof operation.execute>[0]);

        await followLeaseManager.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        });

        expect(listener).toHaveBeenCalledWith({
            kind: 'terminated',
            reason: 'providerFailure',
            cursor: 'cursor-1',
            code: 'follow_refresh_source_replaced',
        });
        if (result.status === 'following') {
            await result.subscription.dispose();
            await result.subscription.dispose();
        }
        expect(listener.mock.calls.filter(([event]) => event.kind === 'terminated')).toHaveLength(1);
    });

    it('terminates a cursor gap without reusing an unaccounted provider tail', async () => {
        const readAfterTranscript = vi.fn()
            .mockResolvedValueOnce({ outcome: 'gap_or_cursor_expired' });
        const pageTranscript = vi.fn();
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
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

        await expect(followLeaseManager.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        await expect(followLeaseManager.requestTranscriptRefresh({
            sessionId: 'linked-session-1',
            resource,
        })).resolves.toEqual({ requested: false, reason: 'not-demanded' });

        expect(pageTranscript).not.toHaveBeenCalled();
        expect(readAfterTranscript.mock.calls.map(([input]) => input.cursor)).toEqual([
            'cursor-1',
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
                status: 'paused',
                reason: 'follow_refresh_resync_required',
            },
            {
                status: 'error',
                reason: 'follow_refresh_resync_required',
            },
        ]);
        if (result.status === 'following') {
            await result.subscription.dispose();
        }
    });

    it('fences an in-flight viewer refresh across suspension and resumes from the last accepted cursor', async () => {
        let resolveFirstRead: ((value: Extract<ExternalSessionTranscriptReadAfter, { outcome: 'advanced' }>) => void) | undefined;
        const firstRead = new Promise<Extract<ExternalSessionTranscriptReadAfter, { outcome: 'advanced' }>>((resolve) => {
            resolveFirstRead = resolve;
        });
        const readAfterTranscript = vi.fn()
            .mockImplementationOnce(async () => await firstRead)
            .mockResolvedValueOnce({
                outcome: 'advanced' as const,
                items: [{
                    id: 'item-current',
                    createdAtMs: 30,
                    raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: 'current' } } },
                }],
                nextCursor: 'cursor-current',
                boundary: 'boundary-current',
            });
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
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
                raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: 'stale' } } },
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

    it('never substitutes current H callbacks for an exact retained-G private follow', async () => {
        const hPageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'cursor-h',
            hasMore: false,
            truncated: false,
        }));
        const hReadAfterTranscript = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: 'plugin-generation-h',
            providerOps: {
                pageTranscript: hPageTranscript,
                readAfterTranscript: hReadAfterTranscript,
            },
            resource,
        });
        const attachScoped = vi.fn();
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager: { attachScoped } as never,
            observationProjection: {
                reconcileTranscriptDemand: vi.fn(),
            } as never,
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
            isCurrent: () => true,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });

        expect(hPageTranscript).not.toHaveBeenCalled();
        expect(hReadAfterTranscript).not.toHaveBeenCalled();
        expect(mocks.resolveExternalSessionObservationLinkInput)
            .not.toHaveBeenCalled();
        expect(attachScoped).not.toHaveBeenCalled();
    });

    it('rejects a relinked current identity before resolving or attaching follow work', async () => {
        mocks.loadLinkedExternalSession.mockResolvedValueOnce({
            ok: false,
            errorCode: 'invalid_request',
            error: 'linked_session_identity_mismatch',
        });
        const attachScoped = vi.fn();
        const reconcileTranscriptDemand = vi.fn();
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager: { attachScoped } as never,
            observationProjection: { reconcileTranscriptDemand } as never,
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
            isCurrent: () => true,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_mismatch',
        });

        expect(mocks.loadLinkedExternalSession).toHaveBeenCalledWith({
            credentials: { token: 'token', encryption: null },
            sessionId: 'linked-session-1',
            machineId: 'machine-1',
            expectedIdentity: {
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source,
            },
        });
        expect(mocks.resolveGenerationBoundExternalSessionFollowSurface)
            .not.toHaveBeenCalled();
        expect(mocks.resolveExternalSessionObservationLinkInput)
            .not.toHaveBeenCalled();
        expect(attachScoped).not.toHaveBeenCalled();
        expect(reconcileTranscriptDemand).not.toHaveBeenCalled();
    });

    it('releases D5 demand and emits one terminal event on caller abort or generation retirement', async () => {
        mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
            immutablePluginGenerationId: resource.pluginGeneration,
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

    it.each([
        {
            name: 'caller abort',
            expectedCode: 'plugin_operation_aborted',
            expectedReason: 'aborted',
            abort: (caller: AbortController, _retirement: AbortController) => {
                caller.abort();
            },
        },
        {
            name: 'generation retirement',
            expectedCode: 'plugin_generation_retired',
            expectedReason: 'retired',
            abort: (_caller: AbortController, retirement: AbortController) => {
                retirement.abort();
            },
        },
    ] as const)(
        'releases the late-scoped lease exactly once when %s arrives during follow acquisition',
        async ({ expectedCode, expectedReason, abort }) => {
            mocks.resolveGenerationBoundExternalSessionFollowSurface.mockResolvedValue({
                immutablePluginGenerationId: resource.pluginGeneration,
                providerOps: {
                    pageTranscript: async () => ({
                        items: [],
                        nextCursor: null,
                        tailCursor: 'cursor-1',
                        hasMore: false,
                        truncated: false,
                    }),
                    readAfterTranscript: async () => ({
                        outcome: 'already_current' as const,
                    }),
                },
                resource,
            });
            let beginAdmission!: () => void;
            const admissionBegan = new Promise<void>((resolve) => {
                beginAdmission = resolve;
            });
            let finishAdmission!: () => void;
            const admission = new Promise<void>((resolve) => {
                finishAdmission = resolve;
            });
            const transcriptDemand = vi.fn(async (
                { demanded }: Readonly<{ demanded: boolean }>,
            ) => {
                if (demanded) {
                    beginAdmission();
                    await admission;
                }
                return { state: demanded ? 'observing' : 'idle' };
            });
            const operation = createExternalSessionFollowHostOperation({
                machineId: 'machine-1',
                followLeaseManager: createExternalSessionFollowLeaseManager(),
                observationProjection: {
                    reconcileTranscriptDemand: transcriptDemand,
                } as never,
            });
            const caller = new AbortController();
            const retirement = new AbortController();
            const listener = vi.fn(async () => undefined);
            const pending = operation.execute({
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

            await admissionBegan;
            abort(caller, retirement);
            await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({
                kind: 'terminated',
                reason: expectedReason,
                cursor: 'cursor-1',
                code: expectedCode,
            }));
            finishAdmission();

            await expect(pending).resolves.toEqual({
                status: 'unavailable',
                code: expectedCode,
            });
            await vi.waitFor(() => expect(transcriptDemand).toHaveBeenCalledWith({
                resolved: observation,
                demanded: false,
            }));
            expect(transcriptDemand).toHaveBeenCalledTimes(2);
            expect(listener).toHaveBeenCalledTimes(1);
        },
    );
});
