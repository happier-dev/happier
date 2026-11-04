import type { SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';

type PendingInputAdmission = Readonly<{
    sessionId: string; accountId: string;
    pending: Readonly<{ messageRole: string | null; authorAccountId: string | null; inputAdmissionReceipt: unknown }>;
}>;

/** Accepted input belongs to the exact Session; its author remains the admitted sender. */
export function readPendingSessionInputAdmission(input: PendingInputAdmission): SessionInputAdmissionReceiptV1 | undefined {
    const receipt = readStoredSessionInputAdmissionReceipt(input.pending.inputAdmissionReceipt);
    if (!receipt || input.pending.messageRole !== 'user'
        || input.pending.authorAccountId !== null && input.pending.authorAccountId !== (receipt.issuer === 'authenticatedAccount'
            ? receipt.actorAccountId : input.accountId)
        || receipt.admittedTarget && (receipt.admittedTarget.accountId !== input.accountId || receipt.admittedTarget.sessionId !== input.sessionId)) return undefined;
    return receipt;
}

/** Reset recovery still requires the owner's own input, independently of managed wake policy. */
export function readPendingOwnerInputAdmission(input: PendingInputAdmission): SessionInputAdmissionReceiptV1 | undefined {
    const receipt = readPendingSessionInputAdmission(input);
    return receipt && (input.pending.authorAccountId === null || input.pending.authorAccountId === input.accountId)
        && (receipt.issuer !== 'authenticatedAccount' || receipt.actorAccountId === input.accountId && receipt.sessionRelationship === 'owner')
        ? receipt : undefined;
}
