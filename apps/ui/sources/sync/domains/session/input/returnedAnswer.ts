import type { Message } from '@happier-dev/session-core/messages';
import { readSessionInputAuthority, type SessionInputReturnedAnswerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

/** Protected return facts, shared by the transcript quote and its derived request index. */
export function readReturnedAnswer(message: Message): SessionInputReturnedAnswerV1 | null {
    if (message.kind !== 'user-text') return null;
    const authority = readSessionInputAuthority(message.meta, 'stored');
    return authority?.v === 1 ? (authority.returnedAnswer ?? null) : null;
}
