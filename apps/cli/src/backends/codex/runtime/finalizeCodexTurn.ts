import type { ApiSessionClient } from '@/api/session/sessionClient';

import { emitReadyIfIdle } from './sessionTurnLifecycle';

type CodexRemoteRuntimeFlush = Readonly<{
    flushTurn: () => Promise<void>;
}> | null;

type CodexRuntimeControlSync = Readonly<{
    syncFromMetadata: () => void;
}> | null;

type CodexTurnDiffProcessor = Readonly<{
    flushTurn: () => void;
    reset: () => void;
}>;

type CodexTurnPermissionHandler = Readonly<{
    reset: () => void;
}>;

type CodexTurnSession = Pick<ApiSessionClient, 'keepAlive' | 'popPendingMessage'>;

export async function finalizeCodexTurn(params: Readonly<{
    runtime: CodexRemoteRuntimeFlush;
    runtimeControlSync: CodexRuntimeControlSync;
    permissionHandler: CodexTurnPermissionHandler;
    diffProcessor: CodexTurnDiffProcessor;
    session: CodexTurnSession;
    pending: unknown;
    shouldExit: boolean;
    queueSize: () => number;
    sendReady: () => void;
    logActiveHandles: (tag: string) => void;
    setThinking: (value: boolean) => void;
    emitReadyIfIdleFn?: typeof emitReadyIfIdle;
}>): Promise<void> {
    const emitReadyIfIdleFn = params.emitReadyIfIdleFn ?? emitReadyIfIdle;

    await params.runtime?.flushTurn();
    params.runtimeControlSync?.syncFromMetadata();

    params.permissionHandler.reset();
    params.diffProcessor.flushTurn();
    params.diffProcessor.reset();
    params.setThinking(false);
    params.session.keepAlive(false, 'remote');

    const popped = !params.shouldExit ? await params.session.popPendingMessage() : false;
    if (!popped) {
        emitReadyIfIdleFn({
            pending: params.pending,
            queueSize: params.queueSize,
            shouldExit: params.shouldExit,
            sendReady: params.sendReady,
        });
    }
    params.logActiveHandles('after-turn');
}
