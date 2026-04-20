import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';
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
    let didSendChangeTitleInstructionForSession = false;
    let workVersion = 0;

    const resetForNewSession = (): void => {
        pending = null;
        modeHash = null;
        didReplaySeedBootstrap = false;
        didSendChangeTitleInstructionForSession = false;
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

        const effectiveMessage = (() => {
            const raw = typeof replaySeedResolution.message === 'string' ? replaySeedResolution.message : '';
            if (!raw.trim()) return raw;
            if (didSendChangeTitleInstructionForSession) return raw;

            const lower = raw.toLowerCase();
            const appendLower = typeof batch.mode.appendSystemPrompt === 'string' ? batch.mode.appendSystemPrompt.toLowerCase() : '';
            const customLower = typeof batch.mode.customSystemPrompt === 'string' ? batch.mode.customSystemPrompt.toLowerCase() : '';

            const alreadyMentionsChangeTitle =
                CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => lower.includes(alias)) ||
                CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => appendLower.includes(alias)) ||
                CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => customLower.includes(alias));

            didSendChangeTitleInstructionForSession = true;
            if (alreadyMentionsChangeTitle) return raw;
            return `${raw}\n\n${CHANGE_TITLE_INSTRUCTION}`;
        })();

        workVersion += 1;
        return {
            message: effectiveMessage,
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
