import {
    normalizeSessionMessagePinRouteMessageId,
    resolveSessionMessagePinRowIdentityKey,
    sessionMessagePinRowsMatch,
    type SessionMessagePinRole,
} from '@/sync/domains/messages/pins/sessionMessagePinIdentity';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

export type MessagePinUnavailableReason =
    | 'missing-session'
    | 'missing-seq'
    | 'unsupported-role'
    | 'invalid-identity'
    | 'read-only-context';

export type MessagePinAvailability = Readonly<
    | {
        status: 'available';
        identityKey: string;
        pin: PersistedSessionMessagePinV1;
        pinned: boolean;
    }
    | {
        status: 'unavailable';
        reason: MessagePinUnavailableReason;
    }
>;

export type MessagePinAvailabilityInput = Readonly<{
    sessionId: string | null | undefined;
    displaySessionId?: string | null | undefined;
    readOnlyContext?: boolean | null | undefined;
    seq: number | null | undefined;
    transcriptBlockIndex: number | null | undefined;
    routeMessageId: string | null | undefined;
    role: SessionMessagePinRole | string | null | undefined;
    pins?: readonly PersistedSessionMessagePinV1[];
    nowMs?: number;
}>;

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    if (typeof sessionId !== 'string') return null;
    const trimmed = sessionId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeSeq(seq: number | null | undefined): number | null {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
    const normalized = Math.trunc(seq);
    return normalized >= 0 ? normalized : null;
}

function normalizeTranscriptBlockIndex(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : null;
}

function normalizePinnableRole(role: SessionMessagePinRole | string | null | undefined): SessionMessagePinRole | null {
    if (role === 'user' || role === 'assistant' || role === 'tool') return role;
    return null;
}

function normalizePinnedAtMs(nowMs: number | null | undefined): number {
    if (typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs >= 0) {
        return Math.trunc(nowMs);
    }
    return Date.now();
}

export function resolveMessagePinAvailability(input: MessagePinAvailabilityInput): MessagePinAvailability {
    const sessionId = normalizeSessionId(input.sessionId);
    if (!sessionId) return { status: 'unavailable', reason: 'missing-session' };
    const displaySessionId = normalizeSessionId(input.displaySessionId);
    if (input.readOnlyContext === true || (displaySessionId !== null && displaySessionId !== sessionId)) {
        return { status: 'unavailable', reason: 'read-only-context' };
    }

    const seq = normalizeSeq(input.seq);
    if (seq === null) return { status: 'unavailable', reason: 'missing-seq' };

    const role = normalizePinnableRole(input.role);
    if (!role) return { status: 'unavailable', reason: 'unsupported-role' };

    const transcriptBlockIndex = normalizeTranscriptBlockIndex(input.transcriptBlockIndex);
    const routeMessageId = normalizeSessionMessagePinRouteMessageId(input.routeMessageId);
    const identityInput = {
        sessionId,
        seq,
        transcriptBlockIndex,
        routeMessageId,
        role,
    } as const;
    const identityKey = resolveSessionMessagePinRowIdentityKey(identityInput);
    if (!identityKey) return { status: 'unavailable', reason: 'invalid-identity' };

    const pin: PersistedSessionMessagePinV1 = {
        version: 1,
        sessionId,
        seq,
        transcriptBlockIndex,
        routeMessageId,
        role,
        pinnedAtMs: normalizePinnedAtMs(input.nowMs),
        label: null,
    };

    return {
        status: 'available',
        identityKey,
        pin,
        pinned: (input.pins ?? []).some((existingPin) => sessionMessagePinRowsMatch(existingPin, pin)),
    };
}
