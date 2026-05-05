import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import { resolveClaudeRemoteQueuedPromptWithReplaySeed } from '@/backends/claude/remote/resolveClaudeRemoteQueuedPromptWithReplaySeed';

export type ClaudeRemoteQueuedPromptBatch = Readonly<{
    message: string;
    mode: EnhancedMode;
    isolate: boolean;
    hash: string;
}>;

type ClaudeRemoteQueuedPromptSessionClient = Readonly<{
    getMetadataSnapshot: () => unknown;
    updateMetadata: (updater: (metadata: any) => any) => void | Promise<void>;
    refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void | boolean>;
}>;

export function createClaudeRemoteQueuedPromptCoordinator(params: Readonly<{
    sessionClient: ClaudeRemoteQueuedPromptSessionClient;
    waitForNextBatch: () => Promise<ClaudeRemoteQueuedPromptBatch | null>;
    onModeChange: (permissionMode: EnhancedMode['permissionMode']) => void;
    logDebug?: (message: string) => void;
}>): Readonly<{
    getPending: () => ClaudeRemoteQueuedPromptBatch | null;
    getWorkVersion: () => number;
    primePending: (batch: ClaudeRemoteQueuedPromptBatch) => void;
    resetForNewSession: () => void;
    nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>;
}> {
    const logDebug = params.logDebug ?? (() => undefined);

    let pending: ClaudeRemoteQueuedPromptBatch | null = null;
    let modeHash: string | null = null;
    let didReplaySeedBootstrap = false;
    let workVersion = 0;

    const resetForNewSession = (): void => {
        pending = null;
        modeHash = null;
        didReplaySeedBootstrap = false;
    };

    const primePending = (batch: ClaudeRemoteQueuedPromptBatch): void => {
        pending = batch;
    };

    const getPending = (): ClaudeRemoteQueuedPromptBatch | null => pending;
    const getWorkVersion = (): number => workVersion;

    const resolveEffectiveMessage = async (batch: ClaudeRemoteQueuedPromptBatch): Promise<{ message: string; mode: EnhancedMode }> => {
        modeHash = batch.hash;
        params.onModeChange(batch.mode.permissionMode);

        const replaySeedResolution = await resolveClaudeRemoteQueuedPromptWithReplaySeed({
            sessionClient: params.sessionClient,
            batch: { message: batch.message, mode: batch.mode },
            didBootstrap: didReplaySeedBootstrap,
        });
        didReplaySeedBootstrap = replaySeedResolution.didBootstrap;

        workVersion += 1;
        return {
            message: typeof replaySeedResolution.message === 'string' ? replaySeedResolution.message : '',
            mode: batch.mode,
        };
    };

    const nextMessage = async (): Promise<{ message: string; mode: EnhancedMode } | null> => {
        const queued = pending;
        if (queued) {
            pending = null;
            return await resolveEffectiveMessage(queued);
        }

        const batch = await params.waitForNextBatch();
        if (!batch) return null;

        if ((modeHash && batch.hash !== modeHash) || batch.isolate) {
            logDebug('[remote]: mode has changed, pending message');
            pending = batch;
            return null;
        }

        return await resolveEffectiveMessage(batch);
    };

    return Object.freeze({
        getPending,
        getWorkVersion,
        primePending,
        resetForNewSession,
        nextMessage,
    });
}
