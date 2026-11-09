import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { logger } from '@/ui/logger';
import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';
import { createSessionClientTranscriptApi } from './sessionClientTranscriptApi';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { createTurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshotStore';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import type { AgentState } from '@/api/types';
import { captureSemanticSessionFollowRuleSourceEvidence } from '@/agent/runtime/session/follow/sessionFollowRuleSourceEvidence';
import type { FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionFollowRuleSourceEvidenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';

function createTranscriptApi(params?: Readonly<{
    transformSessionInputBeforeCommit?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    admitSessionUserMessage?: Parameters<typeof createSessionClientTranscriptApi>[0]['admitSessionUserMessage'];
    connected?: boolean;
    withVolatileSocket?: boolean;
    getLatestTurnSnapshot?: () => Readonly<{
        status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
        observedAt: number;
    }> | null;
    onPresence?: (presence: Readonly<{ thinking: boolean; mode: 'local' | 'remote' }>) => void;
    findPersistedSessionUserMessageAdmission?: Parameters<typeof createSessionClientTranscriptApi>[0]['findPersistedSessionUserMessageAdmission'];
    enqueueCommittedTranscriptMessage?: Parameters<typeof createSessionClientTranscriptApi>[0]['enqueueCommittedTranscriptMessage'];
    turnAssistantTextSnapshotStore?: Parameters<typeof createSessionClientTranscriptApi>[0]['turnAssistantTextSnapshotStore'];
    updateAgentState?: Parameters<typeof createSessionClientTranscriptApi>[0]['updateAgentState'];
    getAgentStateRequestStore?: () => AgentStateRequestStore | null;
}>) {
    const enqueueCommittedTranscriptMessage = vi.fn(params?.enqueueCommittedTranscriptMessage
        ?? (async () => ({ persisted: true, delivered: false })));
    const admitSessionUserMessage = params?.admitSessionUserMessage ?? vi.fn(async ({ localId }) => ({
        status: 'accepted' as const,
        localId,
    }));
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
        onPresence: params?.onPresence,
        getSessionConnectionSupervisor: () => null,
        getMetadataSnapshot: () => null,
        updateAgentState: params?.updateAgentState ?? vi.fn(async () => undefined),
        getAgentStateRequestStore: params?.getAgentStateRequestStore,
        updateMetadata: vi.fn(async () => undefined),
        enqueueCommittedTranscriptMessage,
        turnAssistantTextSnapshotStore: params?.turnAssistantTextSnapshotStore,
        enqueueCommittedVoiceAgentTranscriptTurn: vi.fn(async () => ({ persisted: true, delivered: true })),
        usageObservationPublisher,
        buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
        toolCallCanonicalNameByProviderAndId: new Map(),
        permissionToolCallRawInputByProviderAndId: new Map(),
        toolCallInputByProviderAndId: new Map(),
        admitSessionUserMessage,
        findPersistedSessionUserMessageAdmission:
            params?.findPersistedSessionUserMessageAdmission ?? vi.fn(async () => null),
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
    it.each(['absent', 'pending', 'completed', 'history', 'sidechain'] as const)('joins the canonical live permission publisher without replacing a %s original', async prior => {
        let state: AgentState = { requests: {}, completedRequests: {} };
        const notifications: Readonly<{ requestId: string; createdAt: number; turnId?: string; evidence: SessionFollowRuleSourceEvidenceV1 }>[] = [];
        const session = {
            sessionId: 'session-1',
            getAgentStateSnapshot: () => state,
            updateAgentState: async (updater: (current: AgentState) => AgentState) => { state = updater(state); },
            updateAgentStateRequestSettlement: async (updater: (current: AgentState) => AgentState) => { state = updater(state); },
            captureSessionFollowRuleEvidence: (event: FollowEventV1) => captureSemanticSessionFollowRuleSourceEvidence({
                serverId: 'home', ownerAccountId: 'owner', origin: { kind: 'none' }, event,
            }),
            // The daemon notification is the transport boundary; publication/state logic stays real.
            notifySessionFollowRuleRequestCommitted: async (original: (typeof notifications)[number]) => { notifications.push(original); },
        };
        const store = new AgentStateRequestStore({ session, logPrefix: '[ACP mirror]' });
        if (prior === 'pending') await store.publishRequestAndWait({ requestId: 'permission', toolName: 'write',
            toolInput: { original: true }, createdAt: 7, turnId: 'owning-turn', source: 'owner' });
        if (prior === 'completed') state = { requests: {}, completedRequests: { permission: {
            tool: 'write', arguments: {}, createdAt: 7, completedAt: 8, status: 'approved', turnId: 'owning-turn',
        } } };
        const before = JSON.parse(JSON.stringify(state)) as AgentState;
        notifications.length = 0;
        const { api } = createTranscriptApi({ updateAgentState: session.updateAgentState, getAgentStateRequestStore: () => store });
        try {
            await api.enqueueAgentMessageCommitted('codex', { type: 'permission-request', permissionId: 'permission',
                toolName: 'write', description: 'Write permission', options: { mirror: true } }, {
                localId: 'permission-frame', createdAt: 11, provenance: { kind: 'non_dependent', source: prior === 'history' || prior === 'sidechain' ? prior : 'external' },
            });
            if (prior === 'absent') {
                await vi.waitFor(() => expect(notifications).toHaveLength(1));
                expect(state.requests?.permission).toMatchObject({ createdAt: 11, tool: 'Write', arguments: { mirror: true },
                    happierFollowRuleEvidenceV1: { event: { kind: 'needs_you', type: 'approval' } } });
                expect(notifications[0]).toMatchObject({ requestId: 'permission', createdAt: 11,
                    evidence: { event: { kind: 'needs_you', type: 'approval' } } });
            } else {
                expect(state).toEqual(before);
                expect(notifications).toEqual([]);
            }
        } finally { store.dispose(); }
    });

    it('retains the acknowledged assistant sequence for turn completion before a socket echo', async () => {
        const store = createTurnAssistantTextSnapshotStore();
        store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 3, startedAtMs: 100 });
        const { api } = createTranscriptApi({
            turnAssistantTextSnapshotStore: store,
            // Transcript storage/transport is the system boundary. No socket
            // echo is supplied: the exact positive commit receipt owns identity.
            enqueueCommittedTranscriptMessage: async ({ localId }) => ({
                persisted: true, delivered: true, localId, committedSequence: 7,
            }),
        });
        await api.enqueueAgentMessageCommitted('claude', { type: 'message', message: 'Committed reply' }, {
            localId: 'reply-1', provenance: { kind: 'non_dependent', source: 'external' },
        });
        expect(store.getCurrentTurnSnapshot()).toMatchObject({
            text: 'Committed reply', seq: 7, localId: 'reply-1', source: 'committed',
        });
    });

    it('keeps verified per-input authorization through pre-persistence admission', async () => {
        const authorization = { v: 1 as const, token: 'verified-home-proof', binding: {
            serverIdentityId: 'home', accountId: 'account', custodianAccountId: 'account', installationId: 'installation', principalId: 'account',
            credentialId: '11111111-1111-4111-8111-111111111111', machineId: 'machine',
            actionId: 'session.message.send', requestId: 'rpc-request', requestEnvelopeDigest: 'A'.repeat(43),
            target: { kind: 'session' as const, sessionId: 'session-1' }, grant: API_TOKEN_FULL_GRANT_V1,
        } };
        // Admission is the external authenticated persistence boundary.
        const { api } = createTranscriptApi({ admitSessionUserMessage: async (request) =>
            request.callerInputAuthorization === authorization
                ? { status: 'accepted', localId: request.localId }
                : { status: 'rejected', code: 'session_input_unauthorized' },
        });
        await expect(api.enqueueSessionUserMessageWithDisposition({
            text: 'bound input', localId: 'bound-input', callerInputAuthorization: authorization,
        })).resolves.toEqual({ status: 'accepted', localId: 'bound-input' });
    });

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

    it.each([undefined, 'child-sidechain'])('admits historical user rows through durable transcript custody (sidechain %s)', async sidechainId => {
        const { api, enqueueCommittedTranscriptMessage } = createTranscriptApi();

        const result = await api.enqueueUserTextMessageCommitted('historical prompt', {
            localId: 'history-user-1',
            ...(sidechainId ? { sidechainId } : {}),
            meta: { importedFrom: 'acp-history' },
            createdAt: 123,
            updatedAt: 123,
            provenance: { kind: 'non_dependent', source: 'history' },
        });

        expect(result).toEqual({ persisted: true, delivered: false });
        expect(enqueueCommittedTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'history-user-1',
            sidechainId: sidechainId ?? null,
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
            enqueueSessionEventCommitted: (event: { type: 'ready'; ownerActivityDelivery: 'home_required' }) => Promise<{ persisted: boolean; delivered: boolean }>;
        }).enqueueSessionEventCommitted({ type: 'ready', ownerActivityDelivery: 'home_required' });

        expect(result).toEqual({ persisted: true, delivered: false });
        expect(enqueueCommittedTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            messageRole: 'event',
            sessionEventType: 'ready',
            localId: expect.stringMatching(/^activity-ready-home_required:/),
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

    it('preserves the user role and history provenance for replayed image input, including unavailable media', async () => {
        const { api, enqueueCommittedTranscriptMessage } = createTranscriptApi();
        await api.sendAgentSessionMediaCommitted('opencode', {
            localId: 'imported-user-image', role: 'input', category: 'attachment', messageText: '',
            provenanceSource: 'history',
            media: [{ source: { kind: 'base64', data: 'aGVsbG8=', mimeType: 'image/png' }, origin: { source: 'acp-content' } }],
        });
        expect(enqueueCommittedTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            messageRole: 'user', localId: 'imported-user-image', provenance: { kind: 'non_dependent', source: 'history' },
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

    it.each(['completed', 'failed', 'cancelled'] as const)('preserves host activity over a stale %s turn snapshot until the host settles it', (status) => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(0);
            const onPresence = vi.fn();
            const { api, socketEmit } = createTranscriptApi({
                connected: true,
                onPresence,
                getLatestTurnSnapshot: () => ({ status, observedAt: 1 }),
            });

            api.keepAlive(true, 'remote');
            vi.setSystemTime(15_001);
            api.keepAlive(true, 'remote');
            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: true }));
            expect(onPresence).toHaveBeenLastCalledWith({ thinking: true, mode: 'remote' });

            api.replayLatestPresence();
            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: true }));
            api.keepAlive(false, 'remote');
            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: false }));
            expect(onPresence).toHaveBeenLastCalledWith({ thinking: false, mode: 'remote' });
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

    it.each([
        { status: 'rejected' as const, code: 'session_input_unauthorized' as const },
        { status: 'outcomeUnknown' as const, localId: 'local-disposition', code: 'admission_ack_lost' },
    ])('exposes the canonical $status admission disposition without parsing error text', async (disposition) => {
        const { api } = createTranscriptApi({
            admitSessionUserMessage: vi.fn(async () => disposition),
        });
        const request = { text: 'initial work', localId: 'local-disposition' };

        await expect(api.enqueueSessionUserMessageWithDisposition(request)).resolves.toEqual(disposition);
        await expect(api.enqueueSessionUserMessage(request)).rejects.toMatchObject({ disposition });
    });

    it('retains abandonment cleanup custody when preparation created no workspace files', async () => {
        const onAccepted = vi.fn();
        const onDefinitiveAdmissionFailure = vi.fn();
        const { api } = createTranscriptApi({
            transformSessionInputBeforeCommit: async (payload) => ({
                transformed: payload,
                settlement: {
                    onAccepted,
                    onDefinitiveAdmissionFailure,
                    stagedMediaHandles: [],
                    workingDirectory: '/workspace',
                    createdWorkspaceRelativePaths: [],
                },
            }),
        });

        await expect(api.preparePendingMessageComposerAdmission({
            localId: 'pending-empty-cleanup',
            text: 'prepared text',
            meta: {},
        })).resolves.toMatchObject({
            text: 'prepared text',
            stagedMediaHandles: [],
            sessionMediaCleanup: {
                workingDirectory: '/workspace',
                createdWorkspaceRelativePaths: [],
            },
        });
        expect(onAccepted).not.toHaveBeenCalled();
        expect(onDefinitiveAdmissionFailure).not.toHaveBeenCalled();
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

    it('rejoins persisted prepared attachments before invoking an unavailable plugin transformer', async () => {
        const transformSessionInputBeforeCommit = vi.fn(async () => {
            throw Object.assign(new Error('plugin unavailable'), {
                code: 'composer_attachment_unavailable',
            });
        });
        const preparedAttachment = {
            v: 1 as const,
            instanceId: 'review-instance-1',
            attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
            key: 'review-42',
            value: { reviewId: '42', prepared: true },
            presentation: { label: 'Review #42', typeLabel: 'Commentaire de revue' },
        };
        const persistedMeta = {
            source: 'ui',
            sentFrom: 'ui',
            happierStructuredInputV1: { v: 1, composerAttachments: [preparedAttachment] },
        };
        const findPersistedSessionUserMessageAdmission = vi.fn(async () => ({
            text: 'inspect this review [prepared]',
            meta: persistedMeta,
            composerAttachments: [preparedAttachment],
        }));
        const { api, admitSessionUserMessage } = createTranscriptApi({
            transformSessionInputBeforeCommit,
            findPersistedSessionUserMessageAdmission,
        });

        await api.enqueueSessionUserMessage({
            text: 'inspect this review',
            localId: 'retry-local-1',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [{
                        ...preparedAttachment,
                        value: { reviewId: '42' },
                    }],
                },
            },
        });

        expect(transformSessionInputBeforeCommit).not.toHaveBeenCalled();
        expect(admitSessionUserMessage).toHaveBeenCalledWith({
            localId: 'retry-local-1',
            text: 'inspect this review [prepared]',
            meta: persistedMeta,
            composerAttachments: [preparedAttachment],
        });
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
