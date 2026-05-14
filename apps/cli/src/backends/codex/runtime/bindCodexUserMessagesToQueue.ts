import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { resolveAppendSystemPromptModeOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permissions/modeMetadata';
import {
    normalizePermissionModeToIntent,
    resolvePermissionModeUpdatedAtFromMessage,
} from '@/agent/runtime/permissions/modeCanonical';
import { pushMessageToQueueWithSpecialCommands } from '@/agent/runtime/queueSpecialCommands';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { resolveCodexMessageModel } from '../utils/resolveCodexMessageModel';

export interface CodexSessionQueuedMode {
    permissionMode: PermissionMode;
    permissionModeUpdatedAt?: number;
    appendSystemPrompt?: string | null;
    localId?: string | null;
    model?: string;
}

export type CodexUserMessageSteeringRuntime = Readonly<{
    supportsInFlightSteer: () => boolean;
    isTurnInFlight: () => boolean;
    canSteerPrompt?: () => boolean;
    steerPrompt: (prompt: string) => Promise<void>;
}>;

export function bindCodexUserMessagesToQueue(params: Readonly<{
    session: ApiSessionClient;
    messageQueue: MessageQueue2<CodexSessionQueuedMode>;
    messageBuffer: MessageBuffer;
    getCurrentPermissionMode: () => PermissionMode | undefined;
    setCurrentPermissionMode: (permissionMode: PermissionMode) => void;
    getCurrentPermissionModeUpdatedAt: () => number;
    setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
    getCurrentModelId: () => string | null;
    getRemoteRuntime: () => CodexUserMessageSteeringRuntime | null;
    updateRuntimePermissionMode: (permissionMode: PermissionMode, updatedAt: number) => void;
    logDebug: (message: string) => void;
}>): void {
    params.session.onUserMessage((message) => {
        let messagePermissionMode = params.getCurrentPermissionMode();
        let didChangePermissionMode = false;
        if (message.meta?.permissionMode) {
            const nextPermissionMode = normalizePermissionModeToIntent(message.meta.permissionMode);
            if (nextPermissionMode) {
                const updatedAt = resolvePermissionModeUpdatedAtFromMessage(message);
                const result = maybeUpdatePermissionModeMetadata({
                    currentPermissionMode: params.getCurrentPermissionMode(),
                    nextPermissionMode,
                    updateMetadata: (updater) =>
                        updateMetadataBestEffort(params.session, updater, '[codex]', 'permission_mode_from_user_message'),
                    nowMs: () => updatedAt,
                });
                params.setCurrentPermissionMode(result.currentPermissionMode);
                messagePermissionMode = result.currentPermissionMode;
                didChangePermissionMode = result.didChange;
                if (result.didChange) {
                    params.setCurrentPermissionModeUpdatedAt(updatedAt);
                    params.updateRuntimePermissionMode(result.currentPermissionMode, updatedAt);
                    params.logDebug(`[Codex] Permission mode updated from user message to: ${result.currentPermissionMode}`);
                }
            }
        } else {
            params.logDebug(
                `[Codex] User message received with no permission mode override, using current: ${
                    params.getCurrentPermissionMode() ?? 'default (effective)'
                }`,
            );
        }

        const messageModel = resolveCodexMessageModel({
            currentModelId: params.getCurrentModelId(),
            messageMetaModel: message.meta?.model,
        });

        const queuedMode: CodexSessionQueuedMode = {
            permissionMode: messagePermissionMode || 'default',
            permissionModeUpdatedAt: params.getCurrentPermissionModeUpdatedAt(),
            ...resolveAppendSystemPromptModeOverride(message.meta),
            localId: message.localId ?? null,
            model: messageModel,
        };

        const text = message.content.text;
        const special = parseSpecialCommand(text);
        const runtime = params.getRemoteRuntime();
        if (
            runtime &&
            runtime.supportsInFlightSteer() &&
            (runtime.canSteerPrompt?.() ?? runtime.isTurnInFlight()) &&
            !didChangePermissionMode &&
            special.type === null
        ) {
            params.messageBuffer.addMessage(text, 'user');
            void runtime.steerPrompt(text).catch(() => {
                pushMessageToQueueWithSpecialCommands({
                    queue: params.messageQueue,
                    message: text,
                    text,
                    mode: queuedMode,
                });
            });
            return;
        }

        pushMessageToQueueWithSpecialCommands({
            queue: params.messageQueue,
            message: text,
            text,
            mode: queuedMode,
        });
    });
}
