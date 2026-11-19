import { SessionMessageSendResultV1Schema, type SessionMessageSendResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

export type AdmittedSessionComposerMessageResult = Exclude<SessionMessageSendResultV1, { status: 'rejected' | 'outcomeUnknown' }>;

/** Interpret the Session input owner's receipt before relinquishing a draft. */
export function readSessionComposerMessageAdmission(value: unknown):
    | Readonly<{ kind: 'accepted'; receipt: AdmittedSessionComposerMessageResult }>
    | Readonly<{ kind: 'unaccepted'; code: string }> {
    const parsed = SessionMessageSendResultV1Schema.safeParse(value);
    if (!parsed.success) return { kind: 'unaccepted', code: 'session_input_target_unavailable' };
    return parsed.data.status === 'rejected' || parsed.data.status === 'outcomeUnknown'
        ? { kind: 'unaccepted', code: parsed.data.code }
        : { kind: 'accepted', receipt: parsed.data };
}
