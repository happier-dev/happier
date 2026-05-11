import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';

import {
    createCodexAppServerAssistantReasoningProjector,
} from './projection/assistantReasoningProjector';
import {
    createCodexAppServerTurnDiffProjector,
} from './projection/turnDiffProjector';
import {
    createCodexAppServerToolProjector,
} from './projection/toolProjector';
import { finalizeCodexSyntheticSubagent, startCodexSyntheticSubagent } from '../runtime/emitCodexSyntheticSubagentLifecycle';
import { createCodexSyntheticSubagentTracker } from '../collaboration/createCodexSyntheticSubagentTracker';

import type { CodexAppServerPendingTurn, CodexAppServerStreamUpdateContext } from './createCodexAppServerPendingTurnLifecycle';
import type { CodexAppServerStreamUpdate } from './streamEventBridge';

export function createCodexAppServerStreamLifecycle(params: Readonly<{
    session: ApiSessionClient;
    transcriptSession?: StreamedTranscriptWriterSession;
    readLastObservedMessageSeq: () => number;
    getPendingTurn: () => CodexAppServerPendingTurn | null;
}>): Readonly<{
    assistantReasoningProjector: Readonly<{
        observeStreamUpdate: (update: CodexAppServerStreamUpdate, context: CodexAppServerStreamUpdateContext) => boolean;
        flush: (reason: 'turn-end' | 'abort') => Promise<void>;
    }>;
    turnDiffProjector: Readonly<{
        observeStreamUpdate: (
            update: CodexAppServerStreamUpdate,
            params: Readonly<{ sidechainId: string | null; activeTurnId: string | null }>,
        ) => boolean;
        observeFileChangeToolCall: (input: unknown) => void;
        emitCompletedTurn: (params: Readonly<{
            threadId: string;
            turnId: string;
            completedTurnStartSeqInclusive: number;
        }>) => void;
        beginTurn: () => void;
    }>;
    runBridgeWork: <T>(work: () => Promise<T>) => Promise<T>;
    ensureSyntheticSubagentThread: (threadId: string) => Promise<string>;
    finalizeSyntheticSubagentThread: (threadId: string, status: 'completed' | 'interrupted') => Promise<void>;
    applyStreamUpdate: (update: CodexAppServerStreamUpdate, context: CodexAppServerStreamUpdateContext) => Promise<void>;
}> {
    const itemTranscriptBridge = createKeyedStreamedTranscriptBridge<{
        streamKey: string;
        sidechainId: string | null;
    }>({
        provider: 'codex',
        createSessionForStream: () => params.transcriptSession ?? params.session,
    });
    const assistantReasoningProjector = createCodexAppServerAssistantReasoningProjector({
        bridge: itemTranscriptBridge,
    });
    const turnDiffProjector = createCodexAppServerTurnDiffProjector({
        session: params.session,
        readLastObservedMessageSeq: params.readLastObservedMessageSeq,
    });
    const toolProjector = createCodexAppServerToolProjector({
        session: params.session,
        flushBeforeToolCall: async () => {
            await itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
        },
        observeFileChangeToolCall: (input) => {
            turnDiffProjector.observeFileChangeToolCall(input);
        },
    });
    const syntheticSubagentThreadIds = new Set<string>();
    const syntheticSubagentTracker = createCodexSyntheticSubagentTracker({
        session: params.session,
    });
    let bridgeWork = Promise.resolve();

    const runBridgeWork = async <T>(work: () => Promise<T>): Promise<T> => {
        const next = bridgeWork.then(work);
        bridgeWork = next.then(() => undefined, () => undefined);
        return await next;
    };

    const ensureSyntheticSubagentThread = async (threadId: string): Promise<string> => {
        if (syntheticSubagentThreadIds.has(threadId)) return threadId;
        await startCodexSyntheticSubagent({
            tracker: syntheticSubagentTracker,
            flushBoundary: async () => {
                await itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
            },
            threadId,
        });
        syntheticSubagentThreadIds.add(threadId);
        return threadId;
    };

    const finalizeSyntheticSubagentThread = async (
        threadId: string,
        status: 'completed' | 'interrupted',
    ): Promise<void> => {
        await ensureSyntheticSubagentThread(threadId);
        await finalizeCodexSyntheticSubagent({
            tracker: syntheticSubagentTracker,
            flushBoundary: async () => {
                await itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
            },
            threadId,
            status,
        });
    };

    const applyStreamUpdate = async (
        update: CodexAppServerStreamUpdate,
        context: CodexAppServerStreamUpdateContext,
    ): Promise<void> => {
        if (update.type === 'session-media') {
            await params.session.sendAgentSessionMediaCommitted?.('codex', {
                localId: `codex-media-${update.itemId}`,
                role: 'output',
                category: 'generated',
                media: update.media,
                ...(update.meta ? { meta: update.meta } : {}),
            });
            return;
        }

        if (assistantReasoningProjector.observeStreamUpdate(update, context)) {
            return;
        }

        if (turnDiffProjector.observeStreamUpdate(update, {
            sidechainId: context.sidechainId,
            activeTurnId: params.getPendingTurn()?.turnId ?? null,
        })) {
            return;
        }

        if (await toolProjector.observeStreamUpdate(update, context)) {
            return;
        }
    };

    return {
        assistantReasoningProjector,
        turnDiffProjector,
        runBridgeWork,
        ensureSyntheticSubagentThread,
        finalizeSyntheticSubagentThread,
        applyStreamUpdate,
    };
}
