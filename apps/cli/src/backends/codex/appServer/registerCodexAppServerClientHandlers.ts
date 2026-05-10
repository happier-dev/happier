import { randomUUID } from 'node:crypto';

import { buildCodexAppServerTokenCountSessionMessage } from '../usage/buildCodexAppServerTokenCountSessionMessage';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';

import type { DisposableCodexAppServerClient } from './client/createCodexAppServerClient';
import {
    createCodexAppServerTurnFailure,
    isCodexAppServerAuthAccountChangedError,
    readCodexTurnStatus,
    readRecord,
    readThreadId,
    readTurnId,
} from './readCodexAppServerRpcFields';
import type { CodexAppServerStreamUpdate } from './streamEventBridge';

type PendingTurn = Readonly<{
    threadId: string;
    turnId: string | null;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}>;

type StreamUpdateContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

export function registerCodexAppServerClientHandlers(params: Readonly<{
    client: DisposableCodexAppServerClient;
    runBridgeWork: <T>(work: () => Promise<T>) => Promise<T>;
    getPendingTurn: () => PendingTurn | null;
    setPendingTurn: (turn: PendingTurn | null) => void;
    getLatestPendingTurnId: () => string | null;
    setLatestPendingTurnId: (turnId: string | null) => void;
    getThreadId: () => string | null;
    setThreadId: (threadId: string) => void;
    publishThreadId: () => void;
    setTurnInFlight: (value: boolean) => void;
    setThinking: (value: boolean) => void;
    notificationMatchesPendingTurn: (notificationParams: unknown) => boolean;
    resolveStreamUpdateContext: (notificationParams: unknown) => StreamUpdateContext | null;
    ensureSyntheticSubagentThread: (sidechainId: string) => Promise<unknown>;
    finalizeSyntheticSubagentThread: (sidechainId: string, outcome: 'completed' | 'interrupted') => Promise<void>;
    streamEventBridge: Readonly<{
        onNotification: (input: Readonly<{
            method: string;
            params: unknown;
        }>) => Iterable<CodexAppServerStreamUpdate>;
    }>;
    applyStreamUpdate: (update: CodexAppServerStreamUpdate, context: StreamUpdateContext) => Promise<void>;
    handleServerRequest: (method: string, requestParams: unknown) => Promise<unknown>;
    handleMcpElicitationRequest: (
        requestParams: unknown,
        message?: Readonly<{ id?: unknown }> | null,
    ) => Promise<unknown>;
    schedulePendingTurnFinalization: (flushReason: 'turn-end' | 'abort') => void;
    abortPendingTurnWithFailure: (failure: Error) => Promise<void>;
    finishPendingTurn: (options?: Readonly<{
        error?: Error;
        flushReason?: 'turn-end' | 'abort';
        insideBridgeWork?: boolean;
    }>) => Promise<void>;
    sendCodexMessage: (message: Record<string, unknown>) => void;
    getCurrentModelId: () => string | null;
}>): void {
    const registerActiveTurnStreamNotificationHandler = (method: string): void => {
        params.client.registerNotificationHandler(method, (notificationParams) => {
            return params.runBridgeWork(async () => {
                const context = params.resolveStreamUpdateContext(notificationParams);
                if (!context) return;
                if (context.sidechainId) {
                    await params.ensureSyntheticSubagentThread(context.sidechainId);
                } else if (!params.notificationMatchesPendingTurn(notificationParams)) {
                    return;
                }
                for (const update of params.streamEventBridge.onNotification({ method, params: notificationParams })) {
                    await params.applyStreamUpdate(update, context);
                }
            });
        });
    };

    params.client.registerNotificationHandler('turn/started', (notificationParams) => {
        void params.runBridgeWork(async () => {
            const activeTurn = params.getPendingTurn();
            if (!activeTurn || !params.notificationMatchesPendingTurn(notificationParams)) {
                return;
            }
            const startedTurnId = readTurnId(notificationParams);
            if (startedTurnId && activeTurn.turnId !== startedTurnId) {
                params.setPendingTurn({ ...activeTurn, turnId: startedTurnId });
                params.setLatestPendingTurnId(startedTurnId);
            }
            const nextThreadId = readThreadId(notificationParams);
            if (nextThreadId && nextThreadId !== params.getThreadId()) {
                params.setThreadId(nextThreadId);
                params.publishThreadId();
            }
            params.setTurnInFlight(true);
            params.setThinking(true);
        });
    });

    params.client.registerNotificationHandler('error', (notificationParams) => {
        void params.runBridgeWork(async () => {
            if (!params.notificationMatchesPendingTurn(notificationParams)) return;
            const notificationRecord = readRecord(notificationParams);
            if (notificationRecord?.willRetry === true) return;
            const failure = createCodexAppServerTurnFailure(notificationParams);
            if (isCodexAppServerAuthAccountChangedError(failure)) {
                await params.finishPendingTurn({
                    error: failure,
                    flushReason: 'abort',
                    insideBridgeWork: true,
                });
                return;
            }
            await params.abortPendingTurnWithFailure(failure);
        });
    });

    registerActiveTurnStreamNotificationHandler('item/agentMessage/delta');
    registerActiveTurnStreamNotificationHandler('turn/diff/updated');
    registerActiveTurnStreamNotificationHandler('item/reasoning/summaryTextDelta');
    registerActiveTurnStreamNotificationHandler('item/reasoning/textDelta');
    registerActiveTurnStreamNotificationHandler('item/started');
    registerActiveTurnStreamNotificationHandler('item/completed');
    registerActiveTurnStreamNotificationHandler('rawResponseItem/completed');

    params.client.registerRequestHandler('item/commandExecution/requestApproval', (requestParams) => {
        return params.runBridgeWork(() => params.handleServerRequest('item/commandExecution/requestApproval', requestParams));
    });
    params.client.registerRequestHandler('item/fileChange/requestApproval', (requestParams) => {
        return params.runBridgeWork(() => params.handleServerRequest('item/fileChange/requestApproval', requestParams));
    });
    params.client.registerRequestHandler('item/tool/requestUserInput', (requestParams) => {
        return params.runBridgeWork(() => params.handleServerRequest('item/tool/requestUserInput', requestParams));
    });
    params.client.registerRequestHandler('item/permissions/requestApproval', (requestParams) => {
        return params.runBridgeWork(() => params.handleServerRequest('item/permissions/requestApproval', requestParams));
    });
    params.client.registerRequestHandler('mcpServer/elicitation/request', (requestParams, message) => {
        return params.runBridgeWork(() => params.handleMcpElicitationRequest(requestParams, message));
    });

    const registerTerminalHandler = (method: string): void => {
        params.client.registerNotificationHandler(method, async (notificationParams) => {
            await params.runBridgeWork(async () => {
                if (params.notificationMatchesPendingTurn(notificationParams)) {
                    if (method === 'turn/completed' && readCodexTurnStatus(notificationParams) === 'failed') {
                        const failure = createCodexAppServerTurnFailure(notificationParams);
                        if (isCodexAppServerAuthAccountChangedError(failure)) {
                            await params.finishPendingTurn({
                                error: failure,
                                flushReason: 'abort',
                                insideBridgeWork: true,
                            });
                            return;
                        }
                        await params.abortPendingTurnWithFailure(failure);
                        return;
                    }
                    if (method !== 'turn/completed') {
                        await surfacePrimarySessionRuntimeIssue({
                            provider: 'codex',
                            cause: 'cancelled',
                            providerTurnId: readTurnId(notificationParams),
                            session: {
                                sendAgentMessage: (_provider, body) => params.sendCodexMessage(body),
                            },
                        });
                    }
                    params.schedulePendingTurnFinalization(
                        method === 'turn/completed' ? 'turn-end' : 'abort',
                    );
                    return;
                }
                const activeTurn = params.getPendingTurn();
                const childThreadId = readThreadId(notificationParams);
                if (!activeTurn || !childThreadId || childThreadId === activeTurn.threadId) {
                    return;
                }
                await params.finalizeSyntheticSubagentThread(
                    childThreadId,
                    method === 'turn/completed' ? 'completed' : 'interrupted',
                );
            });
        });
    };

    registerTerminalHandler('turn/completed');
    registerTerminalHandler('turn/interrupted');
    registerTerminalHandler('turn/interrupt');

    params.client.registerNotificationHandler('thread/tokenUsage/updated', (notificationParams) => {
        void params.runBridgeWork(async () => {
            const tokenCountMessage = buildCodexAppServerTokenCountSessionMessage({
                notificationParams,
                modelId: params.getCurrentModelId(),
            });
            if (!tokenCountMessage) return;
            params.sendCodexMessage({
                ...tokenCountMessage,
                id: randomUUID(),
            });
        });
    });
}
