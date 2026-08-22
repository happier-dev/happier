import { describe, expect, it, vi } from 'vitest';

import type { ExternalSessionsSource, PluginAgentContributionV2 } from '@happier-dev/protocol';

import { createPluginExternalSessionsAdapter } from '@/session/external/pluginExternalSessionsAdapter';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import { createConfiguredPluginExternalSessionsAdapter } from '@/session/external/configuredSourceMaterializer';
import type { HostExternalTranscriptFollowEvent } from '@/session/external/privateContract';

import { createHostTerminalTranscriptFollowService } from './transcriptFollow';

const loadCompleteBaseline = async () => ({
    localIds: new Set<string>(),
    complete: true,
});

describe('createHostTerminalTranscriptFollowService', () => {
    it('binds the exact canonical External Session coordinate and releases once', async () => {
        const publish = vi.fn(async () => undefined);
        const dispose = vi.fn(async () => undefined);
        const followSignal: { current: AbortSignal | null } = { current: null };
        const executeFollow = vi.fn(async (request: Readonly<{
            ref: unknown;
            source: unknown;
            options: Readonly<{ signal: AbortSignal }>;
            listener(event: unknown): void | Promise<void>;
        }>) => {
            followSignal.current = request.options.signal;
            await request.listener({
                kind: 'data',
                phase: 'initial_replay',
                items: [{
                    id: 'item-1',
                    kind: 'agent',
                    data: { role: 'agent', text: 'hello' },
                }],
                fromCursor: 'cursor-0',
                nextCursor: 'cursor-1',
            });
            return {
                status: 'following' as const,
                startingCursor: 'cursor-0',
                subscription: { dispose },
            };
        });
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: async (request, listener) => await executeFollow({
                ref: {
                    agentId: request.agentId,
                    sourceId: 'terminal',
                    remoteSessionId: request.providerSessionId,
                },
                source: { kind: 'terminal', projectId: 'project-1' },
                options: {
                    ...(request.admissionDeadlineAtMs === undefined
                        ? {}
                        : { admissionDeadlineAtMs: request.admissionDeadlineAtMs }),
                    signal: request.signal,
                },
                listener,
            }),
            signal: new AbortController().signal,
            publish,
        });

        await expect(service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
        })).resolves.toMatchObject({
            status: 'following',
            startingCursor: 'cursor-0',
            binding: { dispose: expect.any(Function) },
        });
        expect(executeFollow).toHaveBeenCalledWith({
            ref: {
                agentId: 'antigravity',
                sourceId: 'terminal',
                remoteSessionId: 'provider-session-1',
            },
            source: { kind: 'terminal', projectId: 'project-1' },
            options: {
                admissionDeadlineAtMs: expect.any(Number),
                signal: expect.any(AbortSignal),
            },
            listener: expect.any(Function),
        });
        expect(publish).toHaveBeenCalledWith(
            {
                kind: 'data',
                phase: 'initial_replay',
                items: [{
                    id: 'item-1',
                    kind: 'agent',
                    data: { role: 'agent', text: 'hello' },
                }],
                fromCursor: 'cursor-0',
                nextCursor: 'cursor-1',
            },
            expect.objectContaining({
                deadlineAtMs: expect.any(Number),
                signal: expect.any(AbortSignal),
            }),
        );
        expect(followSignal.current?.aborted).toBe(false);

        await service.releaseActiveBindings();
        await service.releaseActiveBindings();
        expect(dispose).toHaveBeenCalledOnce();
        expect(followSignal.current?.aborted).toBe(true);
    });

    it('restarts from committed local IDs instead of retaining an unscoped provider cursor', async () => {
        const requests: Array<Readonly<{ cursor?: string; initialReplay?: boolean }>> = [];
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: vi.fn(async () => ({
                localIds: new Set<string>(),
                complete: true,
            })),
            followProviderSession: vi.fn(async (request, listener) => {
                requests.push(request);
                await listener({
                    kind: 'data',
                    items: [],
                    fromCursor: null,
                    nextCursor: 'cursor-acknowledged',
                });
                return {
                    status: 'following' as const,
                    startingCursor: null,
                    subscription: { dispose: vi.fn(async () => undefined) },
                };
            }),
            signal: new AbortController().signal,
            publish: vi.fn(async () => undefined),
        });

        const first = await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
        });
        expect(first.status).toBe('following');
        if (first.status === 'following') await first.binding.dispose();
        const second = await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
        });

        expect(requests).toEqual([
            expect.objectContaining({ initialReplay: true }),
            expect.objectContaining({ initialReplay: true }),
        ]);
        expect(requests.every((request) => request.cursor === undefined)).toBe(true);
        if (second.status === 'following') await second.binding.dispose();
    });

    it('fails closed before provider follow when the stable-id baseline exceeds the bounded read', async () => {
        const publish = vi.fn(async () => undefined);
        const followProviderSession = vi.fn(async () => ({
            status: 'following' as const,
            startingCursor: 'cursor-1',
            subscription: { dispose: vi.fn(async () => undefined) },
        }));
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: vi.fn(async () => ({
                localIds: new Set(
                    Array.from({ length: 5_000 }, (_, index) => `fact-${index}`),
                ),
                complete: false,
            })),
            followProviderSession,
            signal: new AbortController().signal,
            publish,
        });

        const result = await service.bindProviderSession({
            agentId: 'claude',
            providerSessionId: 'provider-session-1',
        });

        expect(result).toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_unavailable',
        });
        expect(followProviderSession).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it('fails closed before provider follow when the committed baseline is unavailable', async () => {
        const requests: Array<Readonly<{ cursor?: string; initialReplay?: boolean }>> = [];
        const publish = vi.fn(async () => undefined);
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: vi.fn(async () => {
                throw new Error('baseline transport unavailable');
            }),
            followProviderSession: vi.fn(async (request) => {
                requests.push(request);
                return {
                    status: 'following' as const,
                    startingCursor: 'current-tail',
                    subscription: { dispose: vi.fn(async () => undefined) },
                };
            }),
            signal: new AbortController().signal,
            publish,
        });

        const result = await service.bindProviderSession({
            agentId: 'claude',
            providerSessionId: 'provider-session-1',
        });

        expect(result).toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_unavailable',
        });
        expect(requests).toEqual([]);
        expect(publish).not.toHaveBeenCalled();
    });

    it('mints the whole admission deadline before loading the committed baseline', async () => {
        let nowMs = 10_000;
        const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const followProviderSession = vi.fn(async () => ({
            status: 'following' as const,
            startingCursor: 'current-tail',
            subscription: { dispose: vi.fn(async () => undefined) },
        }));
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: async () => {
                nowMs = 10_001;
                return {
                    localIds: new Set<string>(),
                    complete: true,
                };
            },
            followProviderSession,
            signal: new AbortController().signal,
            publish: vi.fn(async () => undefined),
        });

        try {
            await expect(service.bindProviderSession({
                agentId: 'claude',
                providerSessionId: 'provider-session-1',
            })).resolves.toMatchObject({ status: 'following' });

            expect(followProviderSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    admissionDeadlineAtMs: 25_000,
                }),
                expect.any(Function),
            );
        } finally {
            now.mockRestore();
        }
    });

    it('does not begin provider follow when baseline loading consumes the whole admission deadline', async () => {
        let nowMs = 10_000;
        const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const followProviderSession = vi.fn(async () => ({
            status: 'following' as const,
            startingCursor: 'current-tail',
            subscription: { dispose: vi.fn(async () => undefined) },
        }));
        const publish = vi.fn(async () => undefined);
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: async () => {
                nowMs = 25_000;
                return {
                    localIds: new Set<string>(),
                    complete: true,
                };
            },
            followProviderSession,
            signal: new AbortController().signal,
            publish,
        });

        try {
            await expect(service.bindProviderSession({
                agentId: 'claude',
                providerSessionId: 'provider-session-1',
            })).resolves.toEqual({
                status: 'unavailable',
                code: 'plugin_external_follow_resync_required',
            });

            expect(followProviderSession).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
        } finally {
            now.mockRestore();
        }
    });

    it('bounds a held committed baseline at the whole follow admission deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        let releaseBaseline!: () => void;
        const baseline = new Promise<{
            localIds: ReadonlySet<string>;
            complete: boolean;
        }>((resolve) => {
            releaseBaseline = () => resolve({
                localIds: new Set<string>(),
                complete: true,
            });
        });
        const baselineInputs: Array<Readonly<{
            signal: AbortSignal;
            deadlineAtMs: number;
        }>> = [];
        const followProviderSession = vi.fn(async () => ({
            status: 'following' as const,
            startingCursor: 'current-tail',
            subscription: { dispose: vi.fn(async () => undefined) },
        }));
        const publish = vi.fn(async () => undefined);
        const lifecycle = new AbortController();
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: async (input) => {
                baselineInputs.push(input);
                return await baseline;
            },
            followProviderSession,
            signal: lifecycle.signal,
            publish,
        });

        let binding: Promise<unknown> | null = null;
        try {
            binding = service.bindProviderSession({
                agentId: 'claude',
                providerSessionId: 'provider-session-1',
            });
            void binding.catch(() => undefined);
            await vi.advanceTimersByTimeAsync(
                EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
            );

            await expect(binding).resolves.toEqual({
                status: 'unavailable',
                code: 'plugin_external_follow_resync_required',
            });
            const baselineInput = baselineInputs.at(0);
            if (!baselineInput) {
                throw new Error('committed baseline read was not admitted');
            }
            expect(baselineInput).toEqual(expect.objectContaining({
                deadlineAtMs: 25_000,
                signal: expect.any(AbortSignal),
            }));
            expect(baselineInput.signal.aborted).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            expect(followProviderSession).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();

        } finally {
            lifecycle.abort();
            releaseBaseline();
            await vi.advanceTimersByTimeAsync(0);
            vi.useRealTimers();
        }
    });

    it('uses the same admission signal to stop a held initial durable publication at the deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const durableWrites = vi.fn();
        const publish = vi.fn(async (
            _event: HostExternalTranscriptFollowEvent,
            admission?: Readonly<{ signal: AbortSignal; deadlineAtMs?: number }>,
        ) => {
            if (!admission) {
                throw new Error('terminal publication admission was not supplied');
            }
            await new Promise<void>((resolve) => {
                admission.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            if (!admission.signal.aborted) durableWrites();
        });
        const followSignal: { current: AbortSignal | null } = { current: null };
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: async (request, listener) => {
                followSignal.current = request.signal;
                await listener({
                    kind: 'data',
                    phase: 'initial_replay',
                    items: [],
                    fromCursor: null,
                    nextCursor: 'cursor-1',
                });
                return request.signal.aborted
                    ? { status: 'unavailable' as const, code: 'plugin_external_follow_resync_required' }
                    : {
                        status: 'following' as const,
                        startingCursor: 'cursor-1',
                        subscription: { dispose: vi.fn(async () => undefined) },
                    };
            },
            signal: new AbortController().signal,
            publish,
        });

        try {
            const binding = service.bindProviderSession({
                agentId: 'claude',
                providerSessionId: 'provider-session-held-projection',
            });
            void binding.catch(() => undefined);
            await vi.advanceTimersByTimeAsync(
                EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
            );

            await expect(binding).resolves.toEqual({
                status: 'unavailable',
                code: 'plugin_external_follow_resync_required',
            });
            expect(publish).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'data', phase: 'initial_replay' }),
                expect.objectContaining({
                    deadlineAtMs: 25_000,
                    signal: expect.any(AbortSignal),
                }),
            );
            expect(followSignal.current?.aborted).toBe(true);
            expect(durableWrites).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('maps canonical durable admission expiry to resync instead of a generic follow failure', async () => {
        const followSignal: { current: AbortSignal | null } = { current: null };
        const admissionExpiry = Object.assign(
            new Error('Committed transcript admission expired'),
            {
                code: 'runtime_transcript_required_admission_failed',
                reason: 'admission_expired',
            },
        );
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: async (request, listener) => {
                followSignal.current = request.signal;
                await listener({
                    kind: 'data',
                    phase: 'initial_replay',
                    items: [],
                    fromCursor: null,
                    nextCursor: 'cursor-1',
                });
                return {
                    status: 'following' as const,
                    startingCursor: 'cursor-1',
                    subscription: { dispose: vi.fn(async () => undefined) },
                };
            },
            signal: new AbortController().signal,
            publish: async () => {
                throw admissionExpiry;
            },
        });

        await expect(service.bindProviderSession({
            agentId: 'claude',
            providerSessionId: 'provider-session-admission-expired',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_resync_required',
        });
        expect(followSignal.current?.aborted).toBe(true);
    });

    it('keeps configured private target resolution inside the whole admission deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        let releaseBaseline!: () => void;
        const baseline = new Promise<{
            localIds: ReadonlySet<string>;
            complete: boolean;
        }>((resolve) => {
            releaseBaseline = () => resolve({
                localIds: new Set<string>(),
                complete: true,
            });
        });
        let releaseIdentity!: () => void;
        const identity = new Promise<{
            source: ExternalSessionsSource;
            remoteSessionId: string;
        }>((resolve) => {
            releaseIdentity = () => resolve({
                source: {
                    kind: 'antigravityCliPrint',
                    brainDir: '/home/user/.gemini/antigravity-cli/brain',
                    conversationId: 'provider-session-1',
                    sourceRevision: 'revision-1',
                },
                remoteSessionId: 'provider-session-1',
            });
        });
        let resolveStarted!: () => void;
        const resolverStarted = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        const resolverSignal: { current: AbortSignal | null } = { current: null };
        const listCandidates = vi.fn(async () => {
            throw new Error('private terminal follow must not list candidates');
        });
        const resolveLinkIdentity = vi.fn(async ({ signal }: Readonly<{
            signal?: AbortSignal;
        }>) => {
            resolverSignal.current = signal ?? null;
            resolveStarted();
            return await identity;
        });
        const configuredFollow = vi.fn(async () => {
            throw new Error('terminal launch must not begin after admission expiry');
        });
        const contribution = {
            id: 'antigravity',
            title: 'Antigravity',
            runtime: { kind: 'custom' },
            primary: 'sessions',
            capabilities: {
                sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
            },
            surfaces: {
                externalSession: {
                    sources: [{
                        sourceKind: 'antigravityCliPrint',
                        terminalFollow: { userRowClassification: 'explicitV1' },
                        schema: {
                            fields: [{
                                name: 'kind',
                                kind: 'literal',
                                value: 'antigravityCliPrint',
                            }],
                        },
                        key: {
                            segments: [{
                                kind: 'literal',
                                value: 'antigravityCliPrint',
                            }],
                        },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        } satisfies PluginAgentContributionV2;
        const configured = await createConfiguredPluginExternalSessionsAdapter({
            agents: [{
                id: 'antigravity',
                identity: {
                    pluginId: 'happier.antigravity',
                    localId: 'antigravity',
                },
                richDefinition: {
                    provenance: 'first_party',
                    definition: contribution,
                },
            }],
            account: { connectedServicesV2: [] },
            basis: {
                contributionGenerationId: 'registry:g1',
                accountSettingsRevision: 'account:1',
            },
            readCurrentBasis: () => ({
                contributionGenerationId: 'registry:g1',
                accountSettingsRevision: 'account:1',
            }),
            isCurrent: () => true,
            resolveProviderOps: async () => ({
                validateSource: async ({ source }) => ({ ok: true as const, source }),
                listCandidates,
                resolveLinkIdentity,
                pageTranscript: async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: null,
                    hasMore: false,
                    truncated: false,
                }),
                readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
            }),
            followTranscript: configuredFollow,
        });
        const lifecycle = new AbortController();
        const publish = vi.fn(async () => undefined);
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: async () => await baseline,
            followProviderSession: async (request, listener) => {
                const target = await configured.compositionPort.resolveFollowTarget({
                    agentId: request.agentId,
                    remoteSessionId: request.providerSessionId,
                    ...(request.admissionDeadlineAtMs === undefined
                        ? {}
                        : { admissionDeadlineAtMs: request.admissionDeadlineAtMs }),
                    signal: request.signal,
                });
                if (target.status === 'unavailable') return target;
                return await configured.compositionPort.followTranscript(
                    target,
                    {
                        ...(request.initialReplay ? { initialReplay: true } : {}),
                        ...(request.admissionDeadlineAtMs === undefined
                            ? {}
                            : { admissionDeadlineAtMs: request.admissionDeadlineAtMs }),
                        signal: request.signal,
                    },
                    listener,
                );
            },
            signal: lifecycle.signal,
            publish,
        });
        const binding = service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
        });
        let outcome: unknown = null;
        void binding.then((value) => {
            outcome = value;
        });

        try {
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(
                EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs - 1,
            );
            releaseBaseline();
            await resolverStarted;
            expect(Date.now()).toBe(24_999);

            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();

            expect(outcome).toEqual({
                status: 'unavailable',
                code: 'plugin_external_follow_resync_required',
            });
            expect(resolverSignal.current?.aborted).toBe(true);
            expect(resolveLinkIdentity).toHaveBeenCalledOnce();
            expect(listCandidates).not.toHaveBeenCalled();
            expect(configuredFollow).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
        } finally {
            lifecycle.abort();
            releaseIdentity();
            await vi.advanceTimersByTimeAsync(0);
            await binding;
            configured.dispose();
            vi.useRealTimers();
        }
    });

    it.each([
        [
            'caller cancellation',
            (_lifecycle: AbortController, caller: AbortController) => caller.abort(),
        ],
        [
            'terminal lifecycle retirement',
            (lifecycle: AbortController, _caller: AbortController) => lifecycle.abort(),
        ],
    ] as const)(
        'settles a held committed baseline on %s without provider follow',
        async (_reason, abort) => {
            const lifecycle = new AbortController();
            const caller = new AbortController();
            const baselineSignals: AbortSignal[] = [];
            const followProviderSession = vi.fn(async () => ({
                status: 'following' as const,
                startingCursor: 'current-tail',
                subscription: { dispose: vi.fn(async () => undefined) },
            }));
            const publish = vi.fn(async () => undefined);
            const service = createHostTerminalTranscriptFollowService({
                loadCommittedLocalIdBaseline: async ({ signal }) => {
                    baselineSignals.push(signal);
                    await new Promise<never>((_resolve, reject) => {
                        signal.addEventListener(
                            'abort',
                            () => reject(signal.reason),
                            { once: true },
                        );
                    });
                    throw new Error('held baseline unexpectedly settled');
                },
                followProviderSession,
                signal: lifecycle.signal,
                publish,
            });

            const binding = service.bindProviderSession({
                agentId: 'claude',
                providerSessionId: 'provider-session-1',
                signal: caller.signal,
            });
            await Promise.resolve();
            abort(lifecycle, caller);

            await expect(binding).resolves.toEqual({
                status: 'unavailable',
                code: 'plugin_operation_aborted',
            });
            const baselineSignal = baselineSignals.at(0);
            if (!baselineSignal) {
                throw new Error('committed baseline read was not admitted');
            }
            expect(baselineSignal.aborted).toBe(true);
            expect(followProviderSession).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
        },
    );

    it('fails closed when no committed-baseline reader was installed', async () => {
        const followProviderSession = vi.fn(async () => ({
            status: 'following' as const,
            startingCursor: 'current-tail',
            subscription: { dispose: vi.fn(async () => undefined) },
        }));
        const service = createHostTerminalTranscriptFollowService({
            followProviderSession,
            signal: new AbortController().signal,
            publish: vi.fn(async () => undefined),
        });

        await expect(service.bindProviderSession({
            agentId: 'claude',
            providerSessionId: 'provider-session-1',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_unavailable',
        });
        expect(followProviderSession).not.toHaveBeenCalled();
    });

    it('releases a live binding once when the native session generation aborts', async () => {
        const lifecycle = new AbortController();
        const dispose = vi.fn(async () => undefined);
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: vi.fn(async () => ({
                status: 'following' as const,
                startingCursor: null,
                subscription: { dispose },
            })),
            signal: lifecycle.signal,
            publish: vi.fn(),
        });

        await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
        });
        lifecycle.abort();

        await vi.waitFor(() => {
            expect(dispose).toHaveBeenCalledOnce();
        });
        await service.releaseActiveBindings();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('projects the runner follow failure signal onto the terminal binding', async () => {
        const followFailure = Object.assign(
            new Error('daemon follow failed'),
            { code: 'plugin_external_follow_provider_failed' },
        );
        let reportFailure!: (error: Error) => void;
        const failure = new Promise<Error>((resolve) => {
            reportFailure = resolve;
        });
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: vi.fn(async () => ({
                status: 'following' as const,
                startingCursor: null,
                failure,
                subscription: { dispose: vi.fn(async () => undefined) },
            })),
            signal: new AbortController().signal,
            publish: vi.fn(),
        });
        const result = await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-failure',
        });
        expect(result.status).toBe('following');
        if (result.status !== 'following') {
            throw new Error('expected active terminal follow binding');
        }

        reportFailure(followFailure);

        await expect(result.binding.failure).resolves.toBe(followFailure);
        await result.binding.dispose();
    });

    it('settles the terminal binding failure when transcript projection rejects', async () => {
        const projectorFailure = new Error('transcript projection failed');
        let deliver!: (
            event: HostExternalTranscriptFollowEvent,
        ) => void | Promise<void>;
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: vi.fn(async (_request, listener) => {
                deliver = listener;
                return {
                    status: 'following' as const,
                    startingCursor: null,
                    subscription: { dispose: vi.fn(async () => undefined) },
                };
            }),
            signal: new AbortController().signal,
            publish: vi.fn(async () => {
                throw projectorFailure;
            }),
        });
        const result = await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-projector-failure',
        });
        expect(result.status).toBe('following');
        if (result.status !== 'following') {
            throw new Error('expected active terminal follow binding');
        }

        await expect(deliver({
            kind: 'data',
            items: [],
            fromCursor: null,
            nextCursor: 'cursor-1',
        })).rejects.toBe(projectorFailure);
        await expect(result.binding.failure).resolves.toBe(projectorFailure);
        await result.binding.dispose();
    });

    it.each(['disposed', 'aborted', 'retired'] as const)(
        'does not fail the terminal binding for ordinary %s termination',
        async (reason) => {
            let deliver!: (
                event: HostExternalTranscriptFollowEvent,
            ) => void | Promise<void>;
            const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
                followProviderSession: vi.fn(async (_request, listener) => {
                    deliver = listener;
                    return {
                        status: 'following' as const,
                        startingCursor: null,
                        subscription: {
                            dispose: vi.fn(async () => undefined),
                        },
                    };
                }),
                signal: new AbortController().signal,
                publish: vi.fn(),
            });
            const result = await service.bindProviderSession({
                agentId: 'antigravity',
                providerSessionId: `provider-session-${reason}`,
            });
            expect(result.status).toBe('following');
            if (result.status !== 'following') {
                throw new Error('expected active terminal follow binding');
            }
            let failureReported = false;
            void result.binding.failure.then(() => {
                failureReported = true;
            });

            await deliver({
                kind: 'terminated',
                reason,
                cursor: null,
            });
            await Promise.resolve();

            expect(failureReported).toBe(false);
            await result.binding.dispose();
        },
    );

    it.each(['providerFailure', 'resyncRequired'] as const)(
        'fails the terminal binding for non-recoverable %s termination',
        async (reason) => {
            let deliver!: (
                event: HostExternalTranscriptFollowEvent,
            ) => void | Promise<void>;
            const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
                followProviderSession: vi.fn(async (_request, listener) => {
                    deliver = listener;
                    return {
                        status: 'following' as const,
                        startingCursor: null,
                        subscription: {
                            dispose: vi.fn(async () => undefined),
                        },
                    };
                }),
                signal: new AbortController().signal,
                publish: vi.fn(),
            });
            const result = await service.bindProviderSession({
                agentId: 'antigravity',
                providerSessionId: `provider-session-${reason}`,
            });
            expect(result.status).toBe('following');
            if (result.status !== 'following') {
                throw new Error('expected active terminal follow binding');
            }

            await deliver({
                kind: 'terminated',
                reason,
                cursor: null,
                code: `plugin_external_follow_${reason}`,
            });

            await expect(result.binding.failure).resolves.toMatchObject({
                code: `plugin_external_follow_${reason}`,
            });
            await result.binding.dispose();
        },
    );

    it('retains the exact terminal binding when close rejects and retries it on release', async () => {
        const dispose = vi.fn()
            .mockRejectedValueOnce(new Error('daemon close rejected'))
            .mockResolvedValueOnce(undefined);
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: vi.fn(async () => ({
                status: 'following' as const,
                startingCursor: null,
                subscription: { dispose },
            })),
            signal: new AbortController().signal,
            publish: vi.fn(),
        });
        const result = await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-retry',
        });
        expect(result.status).toBe('following');
        if (result.status !== 'following') {
            throw new Error('expected active terminal follow binding');
        }

        await expect(result.binding.dispose()).rejects.toThrow(
            'daemon close rejected',
        );
        await expect(service.releaseActiveBindings()).resolves.toBeUndefined();
        await expect(service.releaseActiveBindings()).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('follows with the exact Antigravity identity source instead of re-resolving the configured source', async () => {
        const dispose = vi.fn(async () => undefined);
        const listCandidates = vi.fn(async () => {
            throw new Error('private terminal follow must not list candidates');
        });
        const followTranscript = vi.fn(async (input: Readonly<{
            source: Readonly<Record<string, unknown>>;
        }>) => {
            if (
                input.source.brainDir !== '/home/user/.gemini/antigravity-cli/brain'
                || input.source.conversationId !== 'provider-session-1'
                || input.source.sourceRevision !== 'revision-1'
            ) {
                return {
                    status: 'unavailable' as const,
                    code: 'plugin_external_follow_identity_mismatch',
                };
            }
            return {
                status: 'following' as const,
                startingCursor: 'cursor-0',
                subscription: { dispose },
            };
        });
        const externalSessions = createPluginExternalSessionsAdapter({
            isCurrent: () => true,
            sources: [{
                agentId: 'antigravity',
                sourceId: 'terminal',
                source: { kind: 'antigravityCliPrint' },
                supportsFollow: true,
            }],
            resolveProviderOps: async () => ({
                validateSource: async () => ({
                    ok: true as const,
                    // Antigravity source validation admits the exact identity but
                    // deliberately returns the broader configured discovery source.
                    source: { kind: 'antigravityCliPrint' as const },
                }),
                listCandidates,
                resolveLinkIdentity: async ({ remoteSessionId }) => ({
                    source: {
                        kind: 'antigravityCliPrint' as const,
                        brainDir:
                            '/home/user/.gemini/antigravity-cli/brain',
                        conversationId: remoteSessionId,
                        sourceRevision: 'revision-1',
                    },
                    remoteSessionId,
                }),
                pageTranscript: async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'cursor-0',
                    hasMore: false,
                    truncated: false,
                }),
                readAfterTranscript: async () => ({
                    outcome: 'already_current' as const,
                }),
            }),
            followTranscript,
        }).compositionPort;
        const service = createHostTerminalTranscriptFollowService({
            loadCommittedLocalIdBaseline: loadCompleteBaseline,
            followProviderSession: async (request, listener) => {
                const target = await externalSessions.resolveFollowTarget({
                    agentId: request.agentId,
                    remoteSessionId: request.providerSessionId,
                    ...(request.admissionDeadlineAtMs === undefined
                        ? {}
                        : { admissionDeadlineAtMs: request.admissionDeadlineAtMs }),
                    signal: request.signal,
                });
                if (target.status === 'unavailable') return target;
                return await externalSessions.followTranscript(
                    target,
                    {
                        ...(request.initialReplay ? { initialReplay: true } : {}),
                        ...(request.admissionDeadlineAtMs === undefined
                            ? {}
                            : { admissionDeadlineAtMs: request.admissionDeadlineAtMs }),
                        signal: request.signal,
                    },
                    listener,
                );
            },
            signal: new AbortController().signal,
            publish: vi.fn(),
        });

        const result = await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
        });

        expect(result).toMatchObject({
            status: 'following',
            startingCursor: 'cursor-0',
        });
        expect(listCandidates).not.toHaveBeenCalled();
        expect(followTranscript).toHaveBeenCalledWith(expect.objectContaining({
            source: {
                kind: 'antigravityCliPrint',
                brainDir: '/home/user/.gemini/antigravity-cli/brain',
                conversationId: 'provider-session-1',
                sourceRevision: 'revision-1',
            },
        }));
        if (result.status === 'following') {
            await result.binding.dispose();
        }
        expect(dispose).toHaveBeenCalledOnce();
    });
});
