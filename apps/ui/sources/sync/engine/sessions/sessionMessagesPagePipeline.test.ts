import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageActionReferenceV1 } from '@happier-dev/protocol';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { NormalizedMessage } from '@/sync/typesRaw';

import { runSessionMessagesPagePipeline } from './sessionMessagesPagePipeline';
import { handleMessageUpdatedSocketUpdate } from './sessionSocketUpdate';

function buildEncryptedApiMessage(params: {
    id: string;
    seq: number;
    updatedAt?: number;
    sidechainId?: string | null;
    sourceCreatedAt?: number;
    sourceUpdatedAt?: number;
    transcriptObservationProvenance?: {
        kind: 'non_dependent';
        source: 'background' | 'external' | 'sidechain' | 'history';
    };
    messageActionReference?: MessageActionReferenceV1;
}): ApiMessage {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: params.sidechainId ?? null,
        content: {
            t: 'encrypted',
            c: `cipher-${params.id}`,
        },
        createdAt: 1_000 + params.seq,
        updatedAt: params.updatedAt ?? 2_000 + params.seq,
        ...(params.sourceCreatedAt !== undefined ? { sourceCreatedAt: params.sourceCreatedAt } : {}),
        ...(params.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: params.sourceUpdatedAt } : {}),
        ...(params.transcriptObservationProvenance !== undefined
            ? { transcriptObservationProvenance: params.transcriptObservationProvenance }
            : {}),
        ...(params.messageActionReference !== undefined
            ? { messageActionReference: params.messageActionReference }
            : {}),
    } as ApiMessage;
}

function buildTextContent(message: ApiMessage, text = `hello-${message.id}`) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'user',
            content: { type: 'text', text },
        },
    };
}

function buildLifecycleContent(message: ApiMessage) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'kimi',
                data: { type: 'turn_aborted', id: `task-${message.seq}` },
            },
        },
    };
}

describe('runSessionMessagesPagePipeline', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('replays an exact stale row once when equal updatedAt dedupe previously hid its correction', async () => {
        const message = buildEncryptedApiMessage({ id: 'stale-row', seq: 10, updatedAt: 2_010 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [message], hasMore: false, nextAfterSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) => messages.map((candidate) =>
            buildTextContent(candidate, 'server-corrected text'),
        ));
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const sessionReceivedMessages = new Map<string, Map<string, number>>([
            ['s1', new Map([['stale-row', 2_010]])],
        ]);
        const runPage = (authoritativeUpdateMessageIds?: ReadonlySet<string>) => runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=9&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 9,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            authoritativeUpdateMessageIds,
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        // Ordinary equal-timestamp deliveries stay deduped.
        await expect(runPage()).resolves.toMatchObject({ applied: 0, normalizedMessages: [] });
        expect(decryptMessages).not.toHaveBeenCalled();

        const result = await runPage(new Set(['stale-row']));
        expect(decryptMessages).toHaveBeenCalledTimes(1);
        expect(result.normalizedMessages).toEqual([
            expect.objectContaining({
                id: 'stale-row',
                isAuthoritativeUpdate: true,
                content: { type: 'text', text: 'server-corrected text' },
            }),
        ]);
        expect(applyMessages).toHaveBeenLastCalledWith('s1', [
            expect.objectContaining({ id: 'stale-row', isAuthoritativeUpdate: true }),
        ]);
    });

    it('keeps a newer socket correction when a marked stale page finishes decrypting later', async () => {
        const stalePageMessage = buildEncryptedApiMessage({ id: 'stale-row', seq: 10, updatedAt: 2_010 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [stalePageMessage], hasMore: false, nextAfterSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        type DecryptedPageMessage = {
            id: string;
            seq: number;
            localId: string | null;
            createdAt: number;
            content: unknown;
        };
        let releaseDecryption!: (messages: DecryptedPageMessage[]) => void;
        const pendingDecryption = new Promise<DecryptedPageMessage[]>((resolve) => {
            releaseDecryption = resolve;
        });
        const decryptMessages = vi.fn((_messages: ApiMessage[]) => pendingDecryption);
        const sessionReceivedMessages = new Map<string, Map<string, number>>([
            ['s1', new Map([['stale-row', 2_010]])],
        ]);
        const socketSession = {
            id: 's1',
            seq: 10,
            createdAt: 1_000,
            updatedAt: 2_011,
            active: true,
            activeAt: 1_000,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            encryptionMode: 'plain',
        } satisfies Session;
        let renderedRow = { text: 'socket-newer text', updatedAt: 2_011 };
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>((_sessionId, messages) => {
            const message = messages.find((candidate) => candidate.id === 'stale-row');
            if (message?.role === 'user') {
                renderedRow = {
                    text: message.content.text,
                    updatedAt: message.content.text === 'socket-newer text'
                        ? 2_011
                        : (stalePageMessage.updatedAt ?? stalePageMessage.createdAt),
                };
            }
        });
        const resolvedStaleIds = new Set<string>();

        const pendingResult = runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=9&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 9,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            authoritativeUpdateMessageIds: new Set(['stale-row']),
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages,
            onNormalizedMessages: (messages) => {
                for (const message of messages) {
                    if (message.id === 'stale-row') resolvedStaleIds.add(message.id);
                }
            },
            log: { log: () => {} },
        });

        await vi.waitFor(() => expect(decryptMessages).toHaveBeenCalledWith([stalePageMessage]));

        // A newer same-row socket correction lands while the marked HTTP page
        // is still decrypting. The targeted refetch must not regress either
        // the live row or the page pipeline's currentness watermark.
        const socketUpdate = {
            updateData: {
                id: 'socket-update',
                seq: 10,
                createdAt: 2_011,
                body: {
                    t: 'message-updated' as const,
                    sid: 's1',
                    message: {
                        id: 'stale-row',
                        seq: 10,
                        localId: null,
                        sidechainId: null,
                        content: {
                            t: 'plain' as const,
                            v: { role: 'user', content: { type: 'text', text: 'socket-newer text' } },
                        },
                        createdAt: 1_010,
                        updatedAt: 2_011,
                    },
                },
            },
            getSessionEncryption: () => null,
            getSession: () => socketSession,
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages,
            isMutableToolCall: () => false,
            invalidateScmStatus: () => {},
            isSessionMessagesLoaded: () => true,
            getSessionMaterializedMaxSeq: () => 10,
            markSessionMaterializedMaxSeq: vi.fn(),
            onMessageGapDetected: vi.fn(),
            sessionReceivedMessages,
        };
        await handleMessageUpdatedSocketUpdate(socketUpdate);
        releaseDecryption([buildTextContent(stalePageMessage, 'older page text')]);

        await expect(pendingResult).resolves.toMatchObject({ applied: 0, normalizedMessages: [] });
        expect(applyMessages).toHaveBeenLastCalledWith('s1', []);
        expect(renderedRow).toEqual({ text: 'socket-newer text', updatedAt: 2_011 });
        expect(sessionReceivedMessages.get('s1')?.get('stale-row')).toBe(2_011);
        expect(resolvedStaleIds).toEqual(new Set());
    });

    it('does not advance row currentness when applying a normalized page row is rejected', async () => {
        const message = buildEncryptedApiMessage({ id: 'apply-rejected', seq: 11, updatedAt: 2_012 });
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        await expect(runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=10&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 10,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: () => ({
                decryptMessages: async () => [buildTextContent(message)],
            }),
            request: async () => new Response(
                JSON.stringify({ messages: [message], hasMore: false, nextAfterSeq: null }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages,
            applyMessages: () => {
                throw new Error('reducer rejected page row');
            },
            log: { log: () => {} },
        })).rejects.toThrow('reducer rejected page row');

        expect(sessionReceivedMessages.get('s1')?.get('apply-rejected')).toBeUndefined();
    });

    it('abandons a response after session retirement before allocating page currentness or decrypting', async () => {
        const message = buildEncryptedApiMessage({ id: 'late-deleted-row', seq: 12, updatedAt: 2_013 });
        let sessionKnown = true;
        let releaseResponse!: (response: Response) => void;
        const heldResponse = new Promise<Response>((resolve) => {
            releaseResponse = resolve;
        });
        let markRequestStarted!: () => void;
        const requestStarted = new Promise<void>((resolve) => {
            markRequestStarted = resolve;
        });
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) => messages.map((candidate) => buildTextContent(candidate)));
        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();

        const pendingResult = runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            isSessionKnown: () => sessionKnown,
            getSessionEncryption: () => ({ decryptMessages }),
            request: async () => {
                markRequestStarted();
                return await heldResponse;
            },
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        await requestStarted;
        sessionKnown = false;
        releaseResponse(new Response(
            JSON.stringify({ messages: [message], hasMore: false, nextAfterSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        await expect(pendingResult).resolves.toMatchObject({
            applied: 0,
            normalizedMessages: [],
            skippedMissingSession: true,
        });
        expect(decryptMessages).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('drops a plugin transcript V1 after E2EE decryption without applying or advancing currentness', async () => {
        const message = {
            ...buildEncryptedApiMessage({ id: 'plugin-transcript', seq: 42 }),
            messageRole: 'agent' as const,
        };
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [message], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: () => ({
                decryptMessages: async () => [{
                    id: message.id,
                    seq: message.seq,
                    localId: null,
                    messageRole: 'agent',
                    createdAt: message.createdAt,
                    content: {
                        v: 1,
                        profile: 'pluginTranscriptV1',
                        owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                        snapshot: {
                            kind: 'status',
                            label: 'Report',
                            value: 'Ready',
                        },
                    },
                }],
            }),
            request,
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        expect(result.applied).toBe(0);
        expect(result.normalizedMessages).toEqual([]);
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('drops current and future plugin transcript profiles from plain replay without applying or advancing currentness', async () => {
        const structuredPresentation = {
            v: 1,
            profile: 'pluginTranscriptV1',
            owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
            snapshot: {
                kind: 'status',
                label: 'Report',
                value: 'Ready',
            },
        } as const;
        const currentMessage = {
            ...buildEncryptedApiMessage({ id: 'plugin-transcript-plain', seq: 43 }),
            messageRole: 'agent' as const,
            content: { t: 'plain' as const, v: structuredPresentation },
        } as ApiMessage;
        const futureMessage = {
            ...buildEncryptedApiMessage({ id: 'plugin-transcript-future-plain', seq: 44 }),
            messageRole: 'agent' as const,
            content: {
                t: 'plain' as const,
                v: { ...structuredPresentation, profile: 'pluginTranscriptV2' },
            },
        } as ApiMessage;
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [currentMessage, futureMessage], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const getSessionEncryption = vi.fn(() => null);
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            sessionEncryptionMode: 'plain',
            getSessionEncryption,
            request,
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect(result.applied).toBe(0);
        expect(result.normalizedMessages).toEqual([]);
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('does not turn a future structured-presentation candidate into an unavailable UI fallback row', async () => {
        const message = {
            ...buildEncryptedApiMessage({ id: 'future-plugin-transcript', seq: 43 }),
            messageRole: 'agent' as const,
        };
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [message], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: () => ({
                decryptMessages: async () => [{
                    id: message.id,
                    seq: message.seq,
                    localId: null,
                    messageRole: 'agent',
                    createdAt: message.createdAt,
                    content: {
                        v: 1,
                        profile: 'pluginTranscriptV2',
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'assistant',
                                message: { role: 'assistant', content: 'legacy plugin payload' },
                            },
                        },
                        meta: {
                            happier: {
                                kind: 'acme.preview/preview-card.v1',
                                payload: { previewId: 'should-not-resolve' },
                            },
                        },
                    },
                }],
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            log: { log: () => {} },
        });

        expect(result.applied).toBe(0);
        expect(result.normalizedMessages).toEqual([]);
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
    });

    it('drops invalid and oversized structured presentations instead of creating unavailable transcript rows', async () => {
        const invalidRecords: readonly Readonly<{ id: string; content: unknown }>[] = [
            {
                id: 'field-plugin-transcript',
                content: {
                    v: 1,
                    profile: 'pluginTranscriptV1',
                    owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                    snapshot: {
                        kind: 'field',
                        label: 'Live setting',
                        control: { kind: 'text', settingId: 'report-setting' },
                    },
                },
            },
            {
                id: 'oversized-plugin-transcript',
                content: {
                    v: 1,
                    profile: 'pluginTranscriptV1',
                    owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                    snapshot: { kind: 'text', text: 'x'.repeat(256 * 1024) },
                },
            },
        ];

        for (const record of invalidRecords) {
            const message = {
                ...buildEncryptedApiMessage({ id: record.id, seq: 44 }),
                messageRole: 'agent' as const,
            };
            const request = vi.fn(async () => new Response(
                JSON.stringify({ messages: [message], hasMore: false }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
            const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();

            const result = await runSessionMessagesPagePipeline({
                sessionId: 's1',
                purpose: 'initial',
                page: {
                    direction: 'initial',
                    requestPath: '/v1/sessions/s1/messages?limit=1',
                    scope: 'main',
                    limit: 1,
                },
                lifecyclePolicy: 'emit',
                getSessionEncryption: () => ({
                    decryptMessages: async () => [{
                        id: message.id,
                        seq: message.seq,
                        localId: null,
                        messageRole: 'agent',
                        createdAt: message.createdAt,
                        content: record.content,
                    }],
                }),
                request,
                sessionReceivedMessages: new Map<string, Map<string, number>>(),
                applyMessages,
                log: { log: () => {} },
            });

            expect(result.applied).toBe(0);
            expect(result.normalizedMessages).toEqual([]);
            expect(applyMessages).toHaveBeenCalledWith('s1', []);
        }
    });

    it('preserves older-page decrypt order, sidechain metadata, and pre-apply normalized callback semantics', async () => {
        const newest = buildEncryptedApiMessage({ id: 'm100', seq: 100 });
        const oldest = buildEncryptedApiMessage({ id: 'm99', seq: 99 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [newest, oldest],
                hasMore: true,
                nextBeforeSeq: 98,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildTextContent(message)),
        );
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const callOrder: string[] = [];
        const onNormalizedMessages = vi.fn((messages: NormalizedMessage[]) => {
            callOrder.push(`normalized:${messages.map((message) => message.id).join(',')}`);
        });
        applyMessages.mockImplementation((_sessionId, messages) => {
            callOrder.push(`apply:${messages.map((message) => message.id).join(',')}`);
        });

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'older',
            page: {
                direction: 'older',
                requestPath: '/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1',
                scope: 'sidechain',
                sidechainId: 'tool_task_1',
                beforeSeq: 101,
                limit: 2,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onNormalizedMessages,
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledWith('/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1');
        expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['m99', 'm100']);
        expect(callOrder).toEqual(['normalized:m99,m100', 'apply:m99,m100']);
        expect(applyMessages.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ id: 'm99', seq: 99, isSidechain: true, sidechainId: 'tool_task_1' }),
            expect.objectContaining({ id: 'm100', seq: 100, isSidechain: true, sidechainId: 'tool_task_1' }),
        ]);
        expect(result).toMatchObject({
            applied: 2,
            appliedMessageIds: ['m99', 'm100'],
            appliedSeqs: [99, 100],
            rawSeqs: [100, 99],
            page: {
                hasMore: true,
                nextBeforeSeq: 98,
            },
        });
    });

    it('uses an explicit target-window purpose and lifecycle policy instead of treating newer-side target pages as live-tail newer pages', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const lifecycle = buildEncryptedApiMessage({ id: 'm101', seq: 101 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [lifecycle],
                nextAfterSeq: 101,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildLifecycleContent(message)),
        );
        const onTaskLifecycleEvent = vi.fn();
        const applyMessages = vi.fn();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'target-window',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=100&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 100,
                limit: 1,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(result).toMatchObject({
            applied: 0,
            appliedMessageIds: [],
            rawSeqs: [101],
        });

        const events = syncPerformanceTelemetry.snapshot().events;
        const requestEvent = events.find((event) => event.name === 'sync.sessions.messages.request');
        expect(requestEvent?.fields.targetWindow).toBe(1);
        expect(requestEvent?.fields.newer ?? 0).toBe(0);
    });

    it('preserves authenticated recovered-history chronology without emitting live lifecycle effects', async () => {
        const recoveredLifecycle = buildEncryptedApiMessage({
            id: 'history-lifecycle',
            seq: 101,
            sourceCreatedAt: 100,
            sourceUpdatedAt: 200,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        const recoveredText = buildEncryptedApiMessage({
            id: 'history-text',
            seq: 102,
            sourceCreatedAt: 300,
            sourceUpdatedAt: 400,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [recoveredLifecycle, recoveredText], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn();
        const onTaskLifecycleEvent = vi.fn();

        await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=100&limit=1',
                scope: 'main',
                sidechainId: null,
                afterSeq: 100,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: () => ({
                decryptMessages: async (messages: ApiMessage[]) => messages.map((message) => (
                    message.id === recoveredLifecycle.id
                        ? buildLifecycleContent(message)
                        : buildTextContent(message)
                )),
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            id: 'history-text',
            seq: 102,
            createdAt: 1_102,
            sourceCreatedAt: 300,
            sourceUpdatedAt: 400,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
    });

    it('preserves a server-issued message action reference on the normalized transcript message', async () => {
        const messageActionReference = {
            v: 1,
            sessionId: 's1',
            messageId: 'actionable-message',
            observedRevision: 'revision-7',
        } as const;
        const actionable = buildEncryptedApiMessage({
            id: 'actionable-message',
            seq: 103,
            messageActionReference,
        });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [actionable], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn();

        await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=102&limit=1',
                scope: 'main',
                sidechainId: null,
                afterSeq: 102,
                limit: 1,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({
                decryptMessages: async (messages: ApiMessage[]) => messages.map((message) => buildTextContent(message)),
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            log: { log: () => {} },
        });

        expect(applyMessages).toHaveBeenCalledWith('s1', [expect.objectContaining({
            id: 'actionable-message',
            messageActionReference,
        })]);
    });
});
