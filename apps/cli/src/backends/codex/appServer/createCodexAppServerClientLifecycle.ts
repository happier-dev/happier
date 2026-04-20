import type { ApiSessionClient } from '@/api/session/sessionClient';
import { publishCodexSessionIdMetadata } from '@/backends/codex/identity/codexSessionIdMetadata';

import { readCodexEnvironmentAuthState } from '../cli/auth/readCodexEnvironmentAuthState';
import type { CodexAppServerPolicy } from '../utils/permissionModePolicy';

import {
    createCodexAppServerClient,
    type DisposableCodexAppServerClient,
} from './client/createCodexAppServerClient';
import { registerCodexAppServerClientHandlers } from './registerCodexAppServerClientHandlers';
import { startOrLoadCodexAppServerThread, type CodexAppServerStartOrLoadOptions } from './startOrLoadThread';
import { publishCodexAppServerSessionControlsMetadata } from './sessionControlsMetadata';
import type { CodexAppServerPendingTurn, CodexAppServerStreamUpdateContext } from './createCodexAppServerPendingTurnLifecycle';
import type { CodexAppServerStreamUpdate } from './streamEventBridge';

export function createCodexAppServerClientLifecycle(params: Readonly<{
    directory: string;
    processEnv?: NodeJS.ProcessEnv;
    configOverrides?: ReadonlyArray<string>;
    activeServerDir?: string | null;
    session: ApiSessionClient;
    runtimeEnv: NodeJS.ProcessEnv;
    getPendingTurn: () => CodexAppServerPendingTurn | null;
    setPendingTurn: (turn: CodexAppServerPendingTurn | null) => void;
    getLatestPendingTurnId: () => string | null;
    setLatestPendingTurnId: (turnId: string | null) => void;
    getThreadId: () => string | null;
    setThreadId: (threadId: string | null) => void;
    getCurrentModelId: () => string | null;
    setCurrentModelId: (modelId: string | null) => void;
    getCurrentModeId: () => string | null;
    getCurrentReasoningEffort: () => string | null;
    getCurrentServiceTier: () => string | null;
    setCurrentServiceTier: (serviceTier: string | null) => void;
    hasServiceTierOverride: () => boolean;
    setTurnInFlight: (value: boolean) => void;
    setThinking: (value: boolean) => void;
    lastPublishedThreadId: { value: string | null };
    runBridgeWork: <T>(work: () => Promise<T>) => Promise<T>;
    ensureSyntheticSubagentThread: (threadId: string) => Promise<string>;
    finalizeSyntheticSubagentThread: (threadId: string, status: 'completed' | 'interrupted') => Promise<void>;
    streamEventBridge: Readonly<{
        onNotification: (input: Readonly<{
            method: string;
            params: unknown;
        }>) => Iterable<CodexAppServerStreamUpdate>;
    }>;
    applyStreamUpdate: (update: CodexAppServerStreamUpdate, context: CodexAppServerStreamUpdateContext) => Promise<void>;
    handleServerRequest: (method: string, requestParams: unknown) => Promise<unknown>;
    handleMcpElicitationRequest: (
        requestParams: unknown,
        message?: Readonly<{ id?: unknown }> | null,
    ) => Promise<unknown>;
    notificationMatchesPendingTurn: (notificationParams: unknown) => boolean;
    resolveStreamUpdateContext: (notificationParams: unknown) => CodexAppServerStreamUpdateContext | null;
    schedulePendingTurnFinalization: (flushReason: 'turn-end' | 'abort') => void;
    abortPendingTurnWithFailure: (failure: Error) => Promise<void>;
    resolveCurrentPolicy: () => CodexAppServerPolicy | null;
    finishPendingTurn: (options?: Readonly<{
        error?: Error;
        flushReason?: 'turn-end' | 'abort';
        insideBridgeWork?: boolean;
    }>) => Promise<void>;
}>): Readonly<{
    ensureClient: () => Promise<DisposableCodexAppServerClient>;
    disposeClient: () => Promise<void>;
    startOrLoad: (options?: CodexAppServerStartOrLoadOptions) => Promise<void>;
    publishThreadId: () => void;
    publishSessionControls: (client: DisposableCodexAppServerClient) => Promise<void>;
}> {
    let clientPromise: Promise<DisposableCodexAppServerClient> | null = null;

    const publishThreadId = (): void => {
        publishCodexSessionIdMetadata({
            session: params.session,
            getCodexThreadId: params.getThreadId,
            backendMode: 'appServer',
            transcriptStorage: params.runtimeEnv.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
            codexHome: params.runtimeEnv.CODEX_HOME ?? null,
            activeServerDir: params.activeServerDir ?? null,
            lastPublished: params.lastPublishedThreadId,
        });
    };

    const publishSessionControls = async (
        client: DisposableCodexAppServerClient,
    ): Promise<void> => {
        const environmentAuth = readCodexEnvironmentAuthState(params.runtimeEnv);
        await publishCodexAppServerSessionControlsMetadata({
            client,
            session: params.session,
            provider: 'codex',
            authMethod: environmentAuth.method,
            currentModeId: params.getCurrentModeId(),
            currentModelId: params.getCurrentModelId(),
            currentReasoningEffort: params.getCurrentReasoningEffort(),
            currentServiceTier: params.getCurrentServiceTier(),
        }).catch(() => undefined);
    };

    const ensureClient = async (): Promise<DisposableCodexAppServerClient> => {
        if (!clientPromise) {
            clientPromise = createCodexAppServerClient({
                cwd: params.directory,
                ...(params.processEnv ? { processEnv: params.processEnv } : {}),
                ...(params.configOverrides ? { configOverrides: params.configOverrides } : {}),
            })
                .then((client) => {
                    registerCodexAppServerClientHandlers({
                        client,
                        runBridgeWork: params.runBridgeWork,
                        getPendingTurn: params.getPendingTurn,
                        setPendingTurn: params.setPendingTurn,
                        getLatestPendingTurnId: params.getLatestPendingTurnId,
                        setLatestPendingTurnId: params.setLatestPendingTurnId,
                        getThreadId: params.getThreadId,
                        setThreadId: (nextThreadId) => {
                            params.setThreadId(nextThreadId);
                        },
                        publishThreadId,
                        setTurnInFlight: params.setTurnInFlight,
                        setThinking: params.setThinking,
                        notificationMatchesPendingTurn: params.notificationMatchesPendingTurn,
                        resolveStreamUpdateContext: params.resolveStreamUpdateContext,
                        ensureSyntheticSubagentThread: params.ensureSyntheticSubagentThread,
                        finalizeSyntheticSubagentThread: params.finalizeSyntheticSubagentThread,
                        streamEventBridge: params.streamEventBridge,
                        applyStreamUpdate: params.applyStreamUpdate,
                        handleServerRequest: params.handleServerRequest,
                        handleMcpElicitationRequest: params.handleMcpElicitationRequest,
                        schedulePendingTurnFinalization: params.schedulePendingTurnFinalization,
                        abortPendingTurnWithFailure: params.abortPendingTurnWithFailure,
                        sendCodexMessage: (message) => {
                            params.session.sendCodexMessage(message);
                        },
                        getCurrentModelId: params.getCurrentModelId,
                    });
                    return client;
                })
                .catch((error) => {
                    clientPromise = null;
                    throw error;
                });
        }
        return await clientPromise;
    };

    const disposeClient = async (): Promise<void> => {
        const activeClientPromise = clientPromise;
        clientPromise = null;
        if (!activeClientPromise) {
            await params.finishPendingTurn();
            return;
        }
        try {
            const client = await activeClientPromise;
            await client.dispose();
        } finally {
            await params.finishPendingTurn({ flushReason: 'abort' });
        }
    };

    const startOrLoad = async (options: CodexAppServerStartOrLoadOptions = {}): Promise<void> => {
        const client = await ensureClient();
        const nextThread = await startOrLoadCodexAppServerThread({
            client,
            directory: params.directory,
            options,
            currentModelId: params.getCurrentModelId(),
            currentServiceTier: params.getCurrentServiceTier(),
            hasServiceTierOverride: params.hasServiceTierOverride(),
            resolveCurrentPolicy: params.resolveCurrentPolicy,
        });
        params.setThreadId(nextThread.threadId);
        params.setCurrentModelId(nextThread.modelId);
        params.setCurrentServiceTier(nextThread.serviceTier);
        await params.finishPendingTurn({ flushReason: 'abort' });
        publishThreadId();
        await publishSessionControls(client);
    };

    return {
        ensureClient,
        disposeClient,
        startOrLoad,
        publishThreadId,
        publishSessionControls,
    };
}
