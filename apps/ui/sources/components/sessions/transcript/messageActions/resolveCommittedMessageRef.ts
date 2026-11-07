import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import { parseSessionMessageRefV1, type SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';

/** The message owner's committed identity, shared by actions on user and assistant prose. */
export function resolveCommittedMessageRef(input: Readonly<{
    message: UserTextMessage | AgentTextMessage;
    sessionId: string;
    serverId?: string | null;
}>): SessionMessageRefV1 | null {
    const source = input.message.messageActionReference;
    return input.serverId && source?.sessionId === input.sessionId
        ? parseSessionMessageRefV1({ kind: 'session', session: { serverId: input.serverId, sessionId: input.sessionId }, messageId: source.messageId })
        : null;
}
