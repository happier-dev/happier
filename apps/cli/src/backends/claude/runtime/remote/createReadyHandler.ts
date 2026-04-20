import type { AccountSettings } from '@happier-dev/protocol';

import { createIdleReadyNotificationDispatcher } from '@/agent/runtime/notifications/createReadyNotificationDispatcher';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

type ClaudeRemoteReadySession = Readonly<{
    sessionId: string;
    sendSessionEvent: (event: { type: 'ready' }) => void;
    getMetadataSnapshot?: () => unknown;
}>;

type ClaudeRemotePushSender = Readonly<{
    sendToAllDevices: (title: string, body: string, opts: { sessionId: string }) => void;
}>;

export function createClaudeRemoteReadyHandler(params: Readonly<{
    session: ClaudeRemoteReadySession;
    pushSender: ClaudeRemotePushSender | null;
    waitingForCommandLabel: string;
    logPrefix: string;
    messageBuffer?: Pick<MessageBuffer, 'getMessages'>;
    getPending: () => unknown;
    getQueueSize: () => number;
    getWorkVersion?: () => unknown;
    includeAssistantPreviewText?: boolean;
    shouldSendPush?: () => boolean;
    accountSettings?: AccountSettings | null;
    settingsSecretsReadKeys?: readonly Uint8Array[];
}>): () => void {
    return createIdleReadyNotificationDispatcher(params);
}
