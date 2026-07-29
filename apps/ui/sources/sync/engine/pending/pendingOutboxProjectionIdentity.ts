import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    areServerAccountScopesEqual,
    serverAccountScopeKeySuffix,
} from '@/sync/domains/scope/serverAccountScope';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

export type PendingOutboxProjectionIdentity = Readonly<{
    sessionId: string;
    localId: string;
    outboxScope: ServerAccountScope;
}>;

function encodeIdentityPart(value: string): string {
    return `${value.length}:${value}`;
}

export function pendingOutboxProjectionIdentityKey(identity: PendingOutboxProjectionIdentity): string {
    const sessionId = identity.sessionId.trim();
    const localId = identity.localId;
    return `${serverAccountScopeKeySuffix(identity.outboxScope)}${encodeIdentityPart(sessionId)}${encodeIdentityPart(localId)}`;
}

export function isPendingOutboxProjectionInScope(
    message: Pick<PendingMessage, 'pendingOutboxScope'>,
    outboxScope: ServerAccountScope,
): boolean {
    return areServerAccountScopesEqual(message.pendingOutboxScope, outboxScope);
}

export function isPendingOutboxProjectionForIdentity(
    message: Pick<PendingMessage, 'id' | 'localId' | 'pendingOutboxScope'>,
    identity: PendingOutboxProjectionIdentity,
): boolean {
    const messageLocalId = message.localId ?? message.id;
    return messageLocalId === identity.localId
        && isPendingOutboxProjectionInScope(message, identity.outboxScope);
}
