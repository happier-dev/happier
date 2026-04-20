import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import type { Session } from '@/backends/claude/runtime/session/ClaudeSession';
import type { OutgoingMessageQueue } from '@/backends/claude/utils/OutgoingMessageQueue';
import type { SDKToLogConverter } from '@/backends/claude/utils/sdkToLogConverter';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

import { createClaudeRemoteReadyHandler } from './createReadyHandler';
import { seedClaudeRemoteTeamInboxFromTranscriptPath } from './seedTeamInboxFromTranscriptPath';
import { createClaudeRemoteTeamInboxBridge } from '@/backends/claude/remote/teamInbox/claudeRemoteTeamInboxBridge';

type ClaudeRemoteTeamInboxBridge = ReturnType<typeof createClaudeRemoteTeamInboxBridge>;

export type ClaudeRemoteDispatchCallbacks = Readonly<{
    onSessionFound: (sessionId: string, data: unknown) => void;
    onCheckpointCaptured: (checkpointId: string) => void;
    onCapabilities: (caps: unknown) => void;
    onCompletionEvent: (message: string) => void;
    onSessionReset: () => void;
    onReady: () => Promise<void>;
}>;

export function createClaudeRemoteDispatchCallbacks(params: Readonly<{
    session: Session;
    messageBuffer: MessageBuffer;
    messageQueue: OutgoingMessageQueue;
    getPending: () => unknown;
    getQueueSize: () => number;
    getWorkVersion?: () => unknown;
    teamInboxBridge: ClaudeRemoteTeamInboxBridge;
    seededTeamInboxSessionIds: Set<string>;
    sdkToLogConverter: SDKToLogConverter;
}>): ClaudeRemoteDispatchCallbacks {
    const readyHandler = createClaudeRemoteReadyHandler({
        session: params.session.client,
        pushSender: params.session.pushSender,
        waitingForCommandLabel: 'Claude',
        logPrefix: '[remote]',
        messageBuffer: params.messageBuffer,
        getPending: params.getPending,
        getQueueSize: params.getQueueSize,
        getWorkVersion: params.getWorkVersion,
        accountSettings: params.session.accountSettings ?? null,
        settingsSecretsReadKeys: params.session.accountSettingsSecretsReadKeys,
        includeAssistantPreviewText:
            params.session.accountSettings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
    });

    return {
        onSessionFound: (sessionId, data) => {
            params.sdkToLogConverter.updateSessionId(sessionId);
            params.session.onSessionFound(sessionId, data as any);
            const transcriptPath = typeof (data as any)?.transcript_path === 'string' ? String((data as any).transcript_path) : null;
            void seedClaudeRemoteTeamInboxFromTranscriptPath({
                sessionId,
                transcriptPath,
                sessionPath: params.session.path,
                claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
                teamInboxBridge: params.teamInboxBridge,
                seededSessionIds: params.seededTeamInboxSessionIds,
            });
        },
        onCheckpointCaptured: (checkpointId) => {
            updateMetadataBestEffort(
                params.session.client,
                (metadata) => ({
                    ...metadata,
                    claudeLastCheckpointId: checkpointId,
                }),
                '[remote]',
                'checkpoint_captured',
            );
        },
        onCapabilities: (caps) => {
            if (!caps || typeof caps !== 'object') return;
            const capabilities = caps as Record<string, unknown>;
            updateMetadataBestEffort(
                params.session.client,
                (metadata) => ({
                    ...metadata,
                    ...(Array.isArray(capabilities.slashCommands) ? { slashCommands: capabilities.slashCommands } : {}),
                    ...(Array.isArray(capabilities.slashCommandDetails) ? { slashCommandDetails: capabilities.slashCommandDetails } : {}),
                }),
                '[remote]',
                'capabilities_update',
            );
        },
        onCompletionEvent: (message) => {
            logger.debug(`[remote]: Completion event: ${message}`);
            params.session.client.sendSessionEvent({ type: 'message', message });
        },
        onSessionReset: () => {
            logger.debug('[remote]: Session reset');
            params.session.clearSessionId();
        },
        onReady: async () => {
            await params.messageQueue.flush();
            readyHandler();
        },
    };
}
