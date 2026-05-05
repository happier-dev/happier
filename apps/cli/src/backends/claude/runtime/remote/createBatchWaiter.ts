import { waitForQueuedSessionPromptBatch } from '@/agent/runtime/session/loop/waitForQueuedSessionPromptBatch';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import type { PermissionHandler } from '@/backends/claude/utils/permissionHandler';
import { syncClaudePermissionModeFromMetadata } from '@/backends/claude/utils/syncPermissionModeFromMetadata';
import type { Session } from '@/backends/claude/runtime/session/ClaudeSession';

export type ClaudeRemoteQueuedPromptBatch = Readonly<{
    message: string;
    mode: EnhancedMode;
    isolate: boolean;
    hash: string;
}>;

export function createClaudeRemoteBatchWaiter(params: Readonly<{
    session: Session;
    permissionHandler: PermissionHandler;
    abortSignal: AbortSignal;
    onPermissionModeUpdated?: (permissionMode: EnhancedMode['permissionMode']) => void;
}>): () => Promise<ClaudeRemoteQueuedPromptBatch | null> {
    return async () =>
        await waitForQueuedSessionPromptBatch({
            messageQueue: params.session.queue,
            abortSignal: params.abortSignal,
            popPendingMessage: async () => {
                if (params.session.queue.size() > 0) return false;
                return await params.session.client.popPendingMessage();
            },
            waitForMetadataUpdate: (signal) => params.session.client.waitForMetadataUpdate(signal),
            onMetadataUpdate: () => {
                const updated = syncClaudePermissionModeFromMetadata({
                    session: params.session,
                    permissionHandler: params.permissionHandler,
                });
                if (updated) params.onPermissionModeUpdated?.(updated);
            },
        });
}
