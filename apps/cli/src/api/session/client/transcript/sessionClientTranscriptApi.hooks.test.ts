import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { logger } from '@/ui/logger';
import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';
import { createSessionClientTranscriptApi } from './sessionClientTranscriptApi';

function createTranscriptApi(params?: Readonly<{
    transformSessionInputBeforeCommit?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    admitSessionUserMessage?: Parameters<typeof createSessionClientTranscriptApi>[0]['admitSessionUserMessage'];
    connected?: boolean;
    withVolatileSocket?: boolean;
    getLatestTurnSnapshot?: () => Readonly<{
        status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
        observedAt: number;
    }> | null;
    getActiveLocalTurnProgressAt?: () => number | null;
}>) {
    const enqueueCommittedTranscriptMessage = vi.fn(async () => ({ persisted: true, delivered: false }));
    const admitSessionUserMessage = params?.admitSessionUserMessage ?? vi.fn(async () => undefined);
    const socketEmit = vi.fn();
    const socketVolatileEmit = vi.fn();
    const usageObservationPublisher = {
        publish: vi.fn(async () => undefined),
    };
    const apiDeps: Parameters<typeof createSessionClientTranscriptApi>[0] = {
        token: 'token',
        sessionId: 'session-1',
        outboundShapeLogger: { log: vi.fn() },
        getSocket: () => ({
            connected: params?.connected ?? false,
            emit: socketEmit,
            ...(params?.withVolatileSocket
                ? { volatile: { emit: socketVolatileEmit } }
                : {}),
        }),
        getLatestTurnSnapshot: params?.getLatestTurnSnapshot ?? (() => null),
        getActiveLocalTurnProgressAt: params?.getActiveLocalTurnProgressAt ?? (() => null),
        getSessionConnectionSupervisor: () => null,
        getMetadataSnapshot: () => null,
        updateAgentState: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
        enqueueCommittedTranscriptMessage,
        enqueueCommittedVoiceAgentTranscriptTurn: vi.fn(async () => ({ persisted: true, delivered: true })),
        usageObservationPublisher,
        buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
        toolCallCanonicalNameByProviderAndId: new Map(),
        permissionToolCallRawInputByProviderAndId: new Map(),
        toolCallInputByProviderAndId: new Map(),
        admitSessionUserMessage,
        getTranscriptQueryContext: () => ({
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            encryptionMode: 'e2ee',
        }),
        transformSessionInputBeforeCommit: params?.transformSessionInputBeforeCommit,
    };
    const api = createSessionClientTranscriptApi(apiDeps);

    return {
        api,
        enqueueCommittedTranscriptMessage,
        admitSessionUserMessage,
        socketEmit,
        socketVolatileEmit,
        usageObservationPublisher,
    };
}

describe('createSessionClientTranscriptApi hook dispatch', () => {
    it.each([
        {
            label: 'task completion',
            provider: 'opencode' as const,
            body: { type: 'task_complete' as const, id: 'task-1' },
            expectedKind: 'task_complete',
        },
        {
            label: 'tool call',
            provider: 'codex' as const,
            body: {
                type: 'tool-call' as const,
                callId: 'call-1',
                name: 'read',
                input: { filePath: '/etc/hosts' },
                id: 'message-1',
            },
            expectedKind: 'tool-call',
        },
        {
            label: 'failed tool result',
            provider: 'gemini' as const,
            body: {
                type: 'tool-result' as const,
                callId: 'call-1',
                output: { error: 'Tool call failed', status: 'failed' },
                id: 'message-1',
            },
            expectedKind: 'tool-result',
        },
    ])('records $label from the durable ACP enqueue path', async ({ provider, body, expectedKind }) => {
        await withToolTraceFile('session-transcript-api-tool-trace-', async (filePath) => {
            const { api } = createTranscriptApi();

            await api.enqueueAgentMessageCommitted(provider, body, {
                localId: `trace-${expectedKind}`,
                provenance: { kind: 'non_dependent', source: 'background' },
            });

            const event = JSON.parse(readFileSync(filePath, 'utf8').trim());
            expect(event).toMatchObject({
                v: 1,
                direction: 'outbound',
                sessionId: 'session-1',
                protocol: 'acp',
                provider,
                kind: expectedKind,
                localId: `trace-${expectedKind}`,
            });
            if (expectedKind === 'tool-result') {
                expect(event.payload).toMatchObject({ isError: true });
            }
        });
    });

    it('does not record non-tool ACP transcript rows', async () => {
        await withToolTraceFile('session-transcript-api-non-tool-trace-', async (filePath) => {
            const { api } = createTranscriptApi();

            await api.enqueueAgentMessageCommitted('codex', {
                type: 'message',
                message: 'hello',
            }, {
                localId: 'trace-message',
                provenance: { kind: 'non_dependent', source: 'background' },
            });

            expect(existsSync(filePath)).toBe(false);
        });
    });

    it('admits historical user rows through durable transcript custody with explicit provenance', async () => {
        const { api, enqueueCommittedTranscriptMessage } = createTranscriptApi();

        const result = await (api as unknown as {
            enqueueUserTextMessageCommitted: (
                text: string,
                opts: {
                    localId: string;
                    meta?: Record<string, unknown>;
                    createdAt?: number;
                    updatedAt?: number;
                    provenance: { kind: 'non_dependent'; source: 'history' };
                },
            ) => Promise<{ persisted: boolean; delivered: boolean }>;
        }).enqueueUserTextMessageCommitted('historical prompt', {
            localId: 'history-user-1',
            meta: { importedFrom: 'acp-history' },
            createdAt: 123,
            updatedAt: 123,
            provenance: { kind: 'non_dependent', source: 'history' },
        });

        expect(result).toEqual({ persisted: true, delivered: false });
        expect(enqueueCommittedTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'history-user-1',
            sidechainId: null,
            messageRole: 'user',
            createdAt: 123,
            updatedAt: 123,
            provenance: { kind: 'non_dependent', source: 'history' },
            message: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({ role: 'user' }),
            }),
        }));
    });

    it('fences durable agent enqueue before an expired terminal admission can mutate custody', async () => {
        const { api, enqueueCommittedTranscriptMessage } = createTranscriptApi();
        const controller = new AbortController();
        controller.abort();

        await expect(api.enqueueAgentMessageCommitted('claude', {
            type: 'message',
            message: 'late terminal output',
        }, {
            localId: 'terminal-admission-expired',
            provenance: { kind: 'non_dependent', source: 'external' },
            admission: {
                signal: controller.signal,
                deadlineAtMs: 2,
            },
        })).rejects.toThrow('Committed transcript admission expired');

        expect(enqueueCommittedTranscriptMessage).not.toHaveBeenCalled();
    });

    it('admits ready session events with server materialization metadata through durable custody', async () => {
        const { api, enqueueCommittedTranscriptMessage } = createTranscriptApi();

        const result = await (api as unknown as {
            enqueueSessionEventCommitted: (event: { type: 'ready' }) => Promise<{ persisted: boolean; delivered: boolean }>;
        }).enqueueSessionEventCommitted({ type: 'ready' });

        expect(result).toEqual({ persisted: true, delivered: false });
        expect(enqueueCommittedTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            messageRole: 'event',
            sessionEventType: 'ready',
            provenance: { kind: 'non_dependent', source: 'background' },
        }));
    });

    it('admits stable session-media transcript descriptors through durable enqueue custody', async () => {
        const { api, enqueueCommittedTranscriptMessage } = createTranscriptApi();

        await api.sendAgentSessionMediaCommitted('codex', {
            localId: 'media-row-1',
            role: 'output',
            category: 'generated',
            media: [{
                source: {
                    kind: 'base64',
                    data: 'aGVsbG8=',
                    mimeType: 'image/png',
                    fileNameHint: 'generated.png',
                },
                origin: { source: 'provider-generated' },
            }],
        });

        expect(enqueueCommittedTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'media-row-1',
            provenance: { kind: 'non_dependent', source: 'external' },
        }));
    });

    it('replays the latest turn status and observation time on session presence', () => {
        const { api, socketEmit } = createTranscriptApi({
            connected: true,
            getLatestTurnSnapshot: () => ({ status: 'completed', observedAt: 1234 }),
        });

        api.keepAlive(false, 'remote');

        expect(socketEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1234,
        }));
    });

    it('publishes the first idle presence durably, uses volatile heartbeats afterward, and durably replays on reconnect', () => {
        const { api, socketEmit, socketVolatileEmit } = createTranscriptApi({
            connected: true,
            withVolatileSocket: true,
        });

        api.keepAlive(false, 'remote');

        expect(socketEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'session-1',
            thinking: false,
            mode: 'remote',
        }));
        expect(socketVolatileEmit).not.toHaveBeenCalled();

        socketEmit.mockClear();
        api.keepAlive(false, 'remote');

        expect(socketEmit).not.toHaveBeenCalled();
        expect(socketVolatileEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'session-1',
            thinking: false,
            mode: 'remote',
        }));

        socketVolatileEmit.mockClear();
        api.replayLatestPresence();

        expect(socketEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'session-1',
            thinking: false,
            mode: 'remote',
        }));
        expect(socketVolatileEmit).not.toHaveBeenCalled();
    });

    it('reliably publishes an active turn without rewriting an idle foreground thinking state', () => {
        const { api, socketEmit, socketVolatileEmit } = createTranscriptApi({
            connected: true,
            withVolatileSocket: true,
            getLatestTurnSnapshot: () => ({ status: 'in_progress', observedAt: 1_234 }),
        });

        api.keepAlive(false, 'remote');
        socketEmit.mockClear();
        socketVolatileEmit.mockClear();
        api.keepAlive(false, 'remote');

        expect(socketEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'session-1',
            thinking: false,
            mode: 'remote',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_234,
        }));
        expect(socketVolatileEmit).not.toHaveBeenCalled();
    });

    it('self-heals terminal thinking after 15 seconds when the active local turn has no recent progress', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(0);
            const { api, socketEmit } = createTranscriptApi({
                connected: true,
                getLatestTurnSnapshot: () => ({ status: 'completed', observedAt: 1 }),
                getActiveLocalTurnProgressAt: () => 0,
            });

            api.keepAlive(true, 'remote');
            vi.setSystemTime(15_001);
            api.keepAlive(true, 'remote');

            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: false }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('extends the terminal thinking guard from the latest local turn progress', () => {
        vi.useFakeTimers();
        try {
            let progressAt = 0;
            vi.setSystemTime(0);
            const { api, socketEmit } = createTranscriptApi({
                connected: true,
                getLatestTurnSnapshot: () => ({ status: 'completed', observedAt: 1 }),
                getActiveLocalTurnProgressAt: () => progressAt,
            });

            api.keepAlive(true, 'remote');
            progressAt = 10_000;
            vi.setSystemTime(10_000);
            api.keepAlive(true, 'remote');
            vi.setSystemTime(24_999);
            api.keepAlive(true, 'remote');
            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: true }));

            vi.setSystemTime(25_000);
            api.keepAlive(true, 'remote');
            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: false }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('applies session.input.transform before passing the canonical user-input builder only the semantic request', async () => {
        const transformSessionInputBeforeCommit = vi.fn(async (payload: Record<string, unknown>) => ({
            ...payload,
            text: `${payload.text} [transformed]`,
            meta: {
                ...(payload.meta as Record<string, unknown>),
                transformedBy: 'fixture.plugin',
            },
        }));
        const {
            api,
            enqueueCommittedTranscriptMessage,
            admitSessionUserMessage,
        } = createTranscriptApi({ transformSessionInputBeforeCommit });

        await api.enqueueSessionUserMessage({
            text: 'original',
            localId: 'local-1',
            meta: { source: 'ui', sentFrom: 'ui' },
        });

        expect(transformSessionInputBeforeCommit).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            localId: 'local-1',
            text: 'original',
            meta: { source: 'ui', sentFrom: 'ui' },
        }));
        expect(enqueueCommittedTranscriptMessage).not.toHaveBeenCalled();
        expect(admitSessionUserMessage).toHaveBeenCalledWith({
            localId: 'local-1',
            text: 'original [transformed]',
            meta: expect.objectContaining({
                source: 'ui',
                sentFrom: 'ui',
                transformedBy: 'fixture.plugin',
            }),
            composerAttachments: [],
        });
    });

    it('admits an attachment-only message through the pre-persistence transform with its stable local identity', async () => {
        const transformSessionInputBeforeCommit = vi.fn(async (payload: Record<string, unknown>) => ({
            ...payload,
            preparedComposerAttachments: (payload.meta as {
                happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
        }));
        const { api, admitSessionUserMessage } = createTranscriptApi({ transformSessionInputBeforeCommit });
        const attachment = {
            v: 1,
            instanceId: 'review-instance-1',
            attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
            key: 'review-42',
            value: { reviewId: '42' },
            presentation: { label: 'Review #42', typeLabel: 'Review comment' },
        };

        await api.enqueueSessionUserMessage({
            text: '',
            localId: 'attachment-only-local-1',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [attachment],
                },
            },
        });

        expect(transformSessionInputBeforeCommit).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            localId: 'attachment-only-local-1',
            text: '',
        }));
        expect(admitSessionUserMessage).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'attachment-only-local-1',
            text: '',
            composerAttachments: [expect.objectContaining({
                instanceId: 'review-instance-1',
                attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
                key: 'review-42',
                value: { reviewId: '42' },
            })],
            meta: expect.objectContaining({
                happierStructuredInputV1: expect.objectContaining({
                    composerAttachments: [attachment],
                }),
            }),
        }));
    });

    it('does not let a successful session-input transform erase a selected composer attachment', async () => {
        const { api, admitSessionUserMessage } = createTranscriptApi({
            transformSessionInputBeforeCommit: async (payload) => ({
                ...payload,
                text: `${payload.text} [transformed]`,
                meta: { transformedBy: 'fixture.plugin' },
            }),
        });

        await expect(api.enqueueSessionUserMessage({
            text: 'inspect this review',
            localId: 'attachment-transform-erased-1',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [{
                        v: 1,
                        instanceId: 'review-instance-1',
                        attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
                        key: 'review-42',
                        value: { reviewId: '42' },
                        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
                    }],
                },
            },
        })).rejects.toMatchObject({
            code: 'session_structured_input_attachment_preparation_required',
        });

        expect(admitSessionUserMessage).not.toHaveBeenCalled();
    });

    it('does not let a successful session-input transform substitute a selected composer attachment', async () => {
        const replacement = {
            v: 1,
            instanceId: 'replacement-instance-1',
            attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
            key: 'review-99',
            value: { reviewId: '99' },
            presentation: { label: 'Review #99', typeLabel: 'Review comment' },
        };
        const { api, admitSessionUserMessage } = createTranscriptApi({
            transformSessionInputBeforeCommit: async (payload) => ({
                ...payload,
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        composerAttachments: [replacement],
                    },
                },
                preparedComposerAttachments: [replacement],
            }),
        });

        await expect(api.enqueueSessionUserMessage({
            text: 'inspect this review',
            localId: 'attachment-transform-replaced-1',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [{
                        v: 1,
                        instanceId: 'review-instance-1',
                        attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
                        key: 'review-42',
                        value: { reviewId: '42' },
                        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
                    }],
                },
            },
        })).rejects.toMatchObject({
            code: 'session_structured_input_attachment_preparation_incomplete',
        });

        expect(admitSessionUserMessage).not.toHaveBeenCalled();
    });

    it('rejects an attachment-bearing message before persistence when canonical admission is unavailable', async () => {
        const { api, admitSessionUserMessage } = createTranscriptApi();

        await expect(api.enqueueSessionUserMessage({
            text: '',
            localId: 'attachment-no-admission-1',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [{
                        v: 1,
                        instanceId: 'review-instance-1',
                        attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
                        key: 'review-42',
                        value: { reviewId: '42' },
                        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
                    }],
                },
            },
        })).rejects.toMatchObject({
            code: 'session_structured_input_attachment_preparation_required',
        });

        expect(admitSessionUserMessage).not.toHaveBeenCalled();
    });

    it('does not fall back to raw attachment input when canonical admission rejects preparation', async () => {
        const { api, admitSessionUserMessage } = createTranscriptApi({
            transformSessionInputBeforeCommit: async () => {
                throw Object.assign(new Error('prepare failed'), {
                    code: 'composer_attachment_prepare_failed',
                });
            },
        });

        await expect(api.enqueueSessionUserMessage({
            text: 'inspect this review',
            localId: 'attachment-prepare-failed-1',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [{
                        v: 1,
                        instanceId: 'review-instance-1',
                        attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
                        key: 'review-42',
                        value: { reviewId: '42' },
                        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
                    }],
                },
            },
        })).rejects.toMatchObject({
            code: 'composer_attachment_prepare_failed',
        });

        expect(admitSessionUserMessage).not.toHaveBeenCalled();
    });

    it('preserves a host-built first-input admission through transforms without deriving it from metadata', async () => {
        const { api, admitSessionUserMessage } = createTranscriptApi({
            transformSessionInputBeforeCommit: async (payload) => ({
                ...payload,
                text: `${payload.text} [transformed]`,
            }),
        });
        const inputAdmission = {
            provenance: { v: 1 as const, kind: 'host' as const, producer: 'agentRuntimeFirstInput' as const },
            request: {
                v: 1 as const,
                producer: 'agentRuntimeFirstInput' as const,
                caller: { kind: 'host' as const },
                permission: {},
            },
        };

        await api.enqueueSessionUserMessage({
            text: 'first input',
            localId: 'first-input-1',
            inputAdmission,
        });

        expect(admitSessionUserMessage).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'first-input-1',
            text: 'first input [transformed]',
            inputAdmission,
        }));
    });

    it('does not pass hostile session input transform failures to retained logging', async () => {
        const privateTranscript = 'private voice transcript that must not enter logs';
        const hostileFailure = new Proxy(
            {
                toJSON: () => ({ privateTranscript }),
                toString: () => privateTranscript,
            },
            {
                get(target, property, receiver) {
                    if (property === Symbol.toPrimitive) return () => privateTranscript;
                    return Reflect.get(target, property, receiver);
                },
            },
        );
        const logDebug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const { api, admitSessionUserMessage } = createTranscriptApi({
            transformSessionInputBeforeCommit: async () => {
                throw hostileFailure;
            },
        });

        try {
            await api.enqueueSessionUserMessage({
                text: privateTranscript,
                localId: 'local-private-transform-failure',
                meta: { source: 'voice', sentFrom: 'voice' },
            });

            expect(admitSessionUserMessage).toHaveBeenCalled();
            expect(logDebug).toHaveBeenCalledWith(
                '[plugins] session.input.transform failed; using original input',
            );
        } finally {
            logDebug.mockRestore();
        }
    });

    it('publishes token_count usage after committing a runtime-projected agent message', async () => {
        const { api, usageObservationPublisher } = createTranscriptApi();

        await api.enqueueAgentMessageCommitted('codex', {
            type: 'token_count',
            id: 'codex:thread-1:turn-1',
            source: 'codex-app-server-token-usage',
            scope: 'session_cumulative',
            modelId: 'gpt-5.6-sol',
            tokens: { input: 8, output: 2, total: 10 },
            context_used_tokens: 6,
            context_window_tokens: 100,
        } as never, {
            localId: 'codex:thread-1:turn-1',
            provenance: { kind: 'non_dependent', source: 'external' },
        });

        expect(usageObservationPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            observation: expect.objectContaining({
                provider: 'codex',
                source: 'codex-app-server-token-usage',
                scope: 'session_cumulative',
                modelId: 'gpt-5.6-sol',
                contextUsedTokens: 6,
                contextWindowTokens: 100,
            }),
            externalKey: 'codex:thread-1:turn-1',
        }));
    });

    it('preserves ordinary ACP meta.happier content through committed custody', async () => {
        const { api, enqueueCommittedTranscriptMessage } = createTranscriptApi();
        const happier = {
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
        };

        await api.enqueueAgentMessageCommitted('codex', {
            type: 'message',
            message: 'preview ready',
        }, {
            localId: 'generic-preview-1',
            meta: { happier },
            provenance: { kind: 'non_dependent', source: 'background' },
        });

        expect(enqueueCommittedTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            message: {
                t: 'plain',
                v: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'codex',
                        data: { type: 'message', message: 'preview ready' },
                    },
                    meta: { sentFrom: 'cli', source: 'cli', happier },
                },
            },
        }));
    });

});
