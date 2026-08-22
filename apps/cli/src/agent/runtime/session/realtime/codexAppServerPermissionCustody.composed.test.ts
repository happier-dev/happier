import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

type AppServerRequestHandler = (
    params: unknown,
    message: Readonly<{ id?: unknown }>,
) => unknown | Promise<unknown>;

type AppServerBoundaryClient = Readonly<{
    launchFeatures: Readonly<{
        codexCliVersion: string | null;
        realtimeConversationVersionSupported: boolean;
        realtimeConversationAdvertised: boolean;
    }>;
    request(method: string, params?: unknown): Promise<unknown>;
    notify(method: string, params?: unknown): Promise<void>;
    registerRequestHandler(method: string, handler: AppServerRequestHandler): () => void;
    registerNotificationHandler(
        method: string,
        handler: (params: unknown) => void | Promise<void>,
    ): () => void;
    onExit(listener: (result: Readonly<{
        exitCode: number | null;
        signal: string | null;
    }>) => void): () => void;
    dispose(): Promise<void>;
}>;

type RealtimeStartResult =
    | Readonly<{
        status: 'started';
        transport: Readonly<{
            kind: 'webrtc';
            answerSdp: string;
        }>;
        handle: Readonly<{
            stop(): Promise<unknown>;
            watch(listener: (event: unknown) => void): Readonly<{ dispose(): void }>;
        }>;
    }>
    | Readonly<{ status: 'busy' | 'aborted' | 'unavailable' | 'failed' }>;

type CodexAppServerOwners = Readonly<{
    registerInteractionHandlers(params: Readonly<{
        client: AppServerBoundaryClient;
        ui: ReturnType<typeof createPluginInteractionsService>;
        getThreadId(): string | null;
    }>): void;
    createRealtimeConversation(params: Readonly<{
        getClient(): Promise<AppServerBoundaryClient>;
        getThreadId(): string | null;
        isDisposed(): boolean;
    }>): Readonly<{
        inspect(): Promise<
            | Readonly<{ status: 'available'; transport: 'webrtc' }>
            | Readonly<{ status: 'unavailable'; reason: string; diagnostic: unknown }>
        >;
        start(input: Readonly<{
            transport: Readonly<{ kind: 'webrtc'; offerSdp: string }>;
        }>): Promise<RealtimeStartResult>;
    }>;
}>;

async function loadCodexAppServerOwners(): Promise<CodexAppServerOwners> {
    const interactionsModulePath =
        '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/interactions.js';
    const realtimeModulePath =
        '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/realtime.js';
    const [interactions, realtime] = await Promise.all([
        import(interactionsModulePath),
        import(realtimeModulePath),
    ]);
    return {
        registerInteractionHandlers: interactions.registerCodexAppServerInteractionHandlers,
        createRealtimeConversation: realtime.createCodexAppServerRealtimeConversation,
    } as CodexAppServerOwners;
}

function createAppServerBoundary(options?: Readonly<{
    applyAuthorizedCommandEffect?: (params: Readonly<{
        command: string;
        decision: 'accept' | 'acceptForSession';
    }>) => void | Promise<void>;
}>) {
    const requestHandlers = new Map<string, AppServerRequestHandler>();
    const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
    const request = vi.fn(async (method: string) => {
        if (method === 'experimentalFeature/list') {
            return {
                data: [{ name: 'realtime_conversation', enabled: true }],
                nextCursor: null,
            };
        }
        return {};
    });
    const notify = vi.fn(async () => {});
    const client: AppServerBoundaryClient = {
        launchFeatures: {
            codexCliVersion: '0.145.0',
            realtimeConversationVersionSupported: true,
            realtimeConversationAdvertised: true,
        },
        request,
        notify,
        registerRequestHandler(method, handler) {
            requestHandlers.set(method, handler);
            return () => requestHandlers.delete(method);
        },
        registerNotificationHandler(method, handler) {
            const handlers = notificationHandlers.get(method) ?? new Set();
            handlers.add(handler);
            notificationHandlers.set(method, handlers);
            return () => handlers.delete(handler);
        },
        onExit: () => () => {},
        dispose: vi.fn(async () => {}),
    };

    return {
        client,
        request,
        notify,
        async invoke(method: string, params: unknown, id: string): Promise<unknown> {
            const handler = requestHandlers.get(method);
            if (!handler) throw new Error(`Missing app-server request handler: ${method}`);
            const response = await handler(params, { id });
            const decision = response && typeof response === 'object' && !Array.isArray(response)
                ? (response as Readonly<Record<string, unknown>>).decision
                : null;
            const command = params && typeof params === 'object' && !Array.isArray(params)
                ? (params as Readonly<Record<string, unknown>>).command
                : null;
            if (
                method === 'item/commandExecution/requestApproval'
                && typeof command === 'string'
                && (decision === 'accept' || decision === 'acceptForSession')
            ) {
                await options?.applyAuthorizedCommandEffect?.({ command, decision });
            }
            return response;
        },
        publish(method: string, params: unknown): void {
            for (const handler of notificationHandlers.get(method) ?? []) {
                handler(params);
            }
        },
    };
}

const permissionCases = [
    {
        label: 'approve once',
        response: { approved: true, decision: 'approved' as const },
        appServerDecision: 'accept',
        completedDecision: 'approved',
    },
    {
        label: 'approve for session',
        response: { approved: true, decision: 'approved_for_session' as const },
        appServerDecision: 'acceptForSession',
        completedDecision: 'approved_for_session',
    },
    {
        label: 'deny',
        response: { approved: false, decision: 'denied' as const },
        appServerDecision: 'decline',
        completedDecision: 'denied',
    },
    {
        label: 'cancel',
        response: { approved: false, decision: 'abort' as const },
        appServerDecision: 'cancel',
        completedDecision: 'abort',
    },
] as const;

describe('Codex global Voice permission custody composition', () => {
    it.each(permissionCases)(
        'settles the hidden-session command effect one-or-zero times after End Voice: $label',
        async ({ response, appServerDecision, completedDecision }) => {
            const codex = await loadCodexAppServerOwners();
            const session = createMutableApiSessionClientFixture<Record<string, unknown>>({
                sessionId: 'global-voice-session',
                metadata: {
                    systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                    voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
                },
                agentState: { requests: {}, completedRequests: {} },
            });
            let abortCodingTurnCalls = 0;
            const permissionHandler = createProviderEnforcedPermissionHandler({
                session,
                logPrefix: '[Codex global Voice custody test]',
                onAbortRequested: async () => {
                    abortCodingTurnCalls += 1;
                },
            });
            const sessionLifetime = new AbortController();
            const currentSessionUi = createNativeAgentCurrentSessionUiServices({
                permissionHandler,
                pluginId: 'happier.agent.codex',
                contributionId: 'codex',
                runtimeId: 'codex',
                sessionId: session.sessionId,
                generationId: 'codex-generation-1',
                interactionDeadlineMs: 1_000,
                isCurrent: () => true,
                signal: sessionLifetime.signal,
            });
            const permissionRequestId = `post-end-${response.decision}`;
            const ui = createPluginInteractionsService({
                currentSession: currentSessionUi,
                signal: sessionLifetime.signal,
                isGenerationCurrent: () => true,
                createOperationId: () => permissionRequestId,
            });
            const authorizedCommandEffects: Array<{
                command: string;
                decision: 'accept' | 'acceptForSession';
            }> = [];
            const appServer = createAppServerBoundary({
                applyAuthorizedCommandEffect: (effect) => {
                    authorizedCommandEffects.push(effect);
                },
            });
            codex.registerInteractionHandlers({
                client: appServer.client,
                ui,
                getThreadId: () => 'thread-1',
            });
            const conversation = codex.createRealtimeConversation({
                getClient: async () => appServer.client,
                getThreadId: () => 'thread-1',
                isDisposed: () => false,
            });
            await expect(conversation.inspect()).resolves.toEqual({
                status: 'available',
                transport: 'webrtc',
            });

            const starting = conversation.start({
                transport: { kind: 'webrtc', offerSdp: 'offer' },
            });
            await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith(
                'thread/realtime/start',
                expect.objectContaining({
                    threadId: 'thread-1',
                    flushTranscriptTailOnSessionEnd: false,
                }),
            ));
            appServer.publish('thread/realtime/started', {
                threadId: 'thread-1',
                realtimeSessionId: null,
                version: 'v3',
            });
            appServer.publish('thread/realtime/sdp', {
                threadId: 'thread-1',
                sdp: 'answer',
            });
            const started = await starting;
            expect(started).toMatchObject({
                status: 'started',
                transport: {
                    kind: 'webrtc',
                    answerSdp: 'answer',
                },
            });
            if (started.status !== 'started') throw new Error('Expected Codex realtime to start');
            const realtimeTerminalEvents: unknown[] = [];
            const terminalWatch = started.handle.watch((event) => {
                realtimeTerminalEvents.push(event);
            });

            let vendorResponseSettlements = 0;
            const vendorResponse = appServer.invoke(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    itemId: 'command-1',
                    startedAtMs: 1,
                    environmentId: null,
                    reason: 'The delegated turn needs permission.',
                    command: 'git fetch origin',
                    cwd: '/workspace',
                    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
                },
                'vendor-permission-1',
            );
            void vendorResponse.then(
                () => {
                    vendorResponseSettlements += 1;
                },
                () => {
                    vendorResponseSettlements += 1;
                },
            );

            await vi.waitFor(() => expect(
                session.__getAgentState().requests?.[permissionRequestId],
            ).toMatchObject({
                tool: 'codex_command_execution',
                kind: 'permission',
                owner: {
                    kind: 'plugin',
                    pluginId: 'happier.agent.codex',
                    runtimeId: 'codex',
                },
            }));
            expect(vendorResponseSettlements).toBe(0);

            await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });
            await Promise.resolve();
            expect(realtimeTerminalEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
            expect(sessionLifetime.signal.aborted).toBe(false);
            expect(vendorResponseSettlements).toBe(0);
            expect(session.__getAgentState().requests?.[permissionRequestId]).toBeDefined();
            expect(abortCodingTurnCalls).toBe(0);

            const wirePermissionResponse = JSON.parse(JSON.stringify({
                id: permissionRequestId,
                ...response,
            })) as {
                id: string;
                approved: boolean;
                decision: typeof response.decision;
            };
            expect(wirePermissionResponse).toEqual({
                id: permissionRequestId,
                ...response,
            });
            const staleApproval = JSON.parse(JSON.stringify({
                id: permissionRequestId,
                approved: true,
                decision: 'approved',
            })) as {
                id: string;
                approved: boolean;
                decision: 'approved';
            };
            const [firstResponse, repeatedOrStaleResponse] = await Promise.all([
                session.rpcHandlerManager.invokeLocal(
                    RPC_METHODS.SESSION_PERMISSION_RESPOND,
                    wirePermissionResponse,
                ),
                session.rpcHandlerManager.invokeLocal(
                    RPC_METHODS.SESSION_PERMISSION_RESPOND,
                    staleApproval,
                ),
            ]);
            expect(firstResponse).toBeUndefined();
            expect(repeatedOrStaleResponse).toEqual({
                ok: false,
                errorCode: 'permission_request_not_found',
                requestId: permissionRequestId,
            });
            await expect(vendorResponse).resolves.toEqual({ decision: appServerDecision });
            expect(vendorResponseSettlements).toBe(1);
            expect(authorizedCommandEffects).toEqual(
                response.approved
                    ? [{ command: 'git fetch origin', decision: appServerDecision }]
                    : [],
            );
            expect(session.__getAgentState().requests?.[permissionRequestId]).toBeUndefined();
            expect(session.__getAgentState().completedRequests?.[permissionRequestId]).toMatchObject({
                decision: completedDecision,
            });
            expect(abortCodingTurnCalls).toBe(
                response.decision === 'abort' ? 1 : 0,
            );

            await expect(session.rpcHandlerManager.invokeLocal(
                RPC_METHODS.SESSION_PERMISSION_RESPOND,
                JSON.parse(JSON.stringify(staleApproval)),
            )).resolves.toEqual({
                ok: false,
                errorCode: 'permission_request_not_found',
                requestId: permissionRequestId,
            });
            expect(vendorResponseSettlements).toBe(1);
            expect(authorizedCommandEffects).toEqual(
                response.approved
                    ? [{ command: 'git fetch origin', decision: appServerDecision }]
                    : [],
            );
            expect(appServer.request.mock.calls.filter(
                ([method]) => method === 'thread/realtime/start',
            )).toHaveLength(1);
            expect(appServer.request.mock.calls.filter(
                ([method]) => method === 'thread/realtime/stop',
            )).toHaveLength(1);
            expect(appServer.notify).not.toHaveBeenCalled();
            expect(realtimeTerminalEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
            expect(session.__getMetadata()).toEqual({
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
            });
            terminalWatch.dispose();
        },
    );
});
