import { parseStableSessionMessageRouteId } from '../messageRouteIds';

export type SessionMessagePinRole = 'user' | 'assistant' | 'tool' | 'system' | 'unknown';

export type SessionMessagePinIdentity = Readonly<
    | {
        kind: 'route-message-id';
        sessionId: string;
        seq: number;
        transcriptBlockIndex: number | null;
        routeMessageId: string;
        role: SessionMessagePinRole;
    }
    | {
        kind: 'fallback';
        sessionId: string;
        seq: number;
        transcriptBlockIndex: number | null;
        role: SessionMessagePinRole;
    }
>;

export type SessionMessagePinIdentityInput = Readonly<{
    sessionId: string | null | undefined;
    seq: number | null | undefined;
    transcriptBlockIndex: number | null | undefined;
    routeMessageId: string | null | undefined;
    role: SessionMessagePinRole | string | null | undefined;
}>;

export function normalizeSessionMessagePinSessionId(sessionId: string | null | undefined): string | null {
    if (typeof sessionId !== 'string') return null;
    const trimmed = sessionId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSessionMessagePinSeq(seq: number | null | undefined): number | null {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
    const normalized = Math.trunc(seq);
    return normalized >= 0 ? normalized : null;
}

export function normalizeSessionMessagePinTranscriptBlockIndex(
    transcriptBlockIndex: number | null | undefined,
): number | null {
    if (transcriptBlockIndex === null || transcriptBlockIndex === undefined) return null;
    if (typeof transcriptBlockIndex !== 'number' || !Number.isFinite(transcriptBlockIndex)) return null;
    const normalized = Math.trunc(transcriptBlockIndex);
    return normalized >= 0 ? normalized : null;
}

export function isSessionMessagePinRole(role: unknown): role is SessionMessagePinRole {
    return role === 'user'
        || role === 'assistant'
        || role === 'tool'
        || role === 'system'
        || role === 'unknown';
}

export function normalizeSessionMessagePinRole(role: SessionMessagePinRole | string | null | undefined): SessionMessagePinRole {
    return isSessionMessagePinRole(role) ? role : 'unknown';
}

export function normalizeSessionMessagePinRouteMessageId(routeMessageId: string | null | undefined): string | null {
    if (typeof routeMessageId !== 'string') return null;
    const parsed = parseStableSessionMessageRouteId(routeMessageId);
    if (parsed?.kind === 'local') return `local:${parsed.value}`;
    const trimmed = routeMessageId.trim();
    return parseStableSessionMessageRouteId(trimmed) ? trimmed : null;
}

export function buildSessionMessagePinIdentity(
    input: SessionMessagePinIdentityInput,
): SessionMessagePinIdentity | null {
    const sessionId = normalizeSessionMessagePinSessionId(input.sessionId);
    const seq = normalizeSessionMessagePinSeq(input.seq);
    if (!sessionId || seq === null) return null;

    const routeMessageId = normalizeSessionMessagePinRouteMessageId(input.routeMessageId);
    if (routeMessageId) {
        return {
            kind: 'route-message-id',
            sessionId,
            seq,
            transcriptBlockIndex: normalizeSessionMessagePinTranscriptBlockIndex(input.transcriptBlockIndex),
            routeMessageId,
            role: normalizeSessionMessagePinRole(input.role),
        };
    }

    return {
        kind: 'fallback',
        sessionId,
        seq,
        transcriptBlockIndex: normalizeSessionMessagePinTranscriptBlockIndex(input.transcriptBlockIndex),
        role: normalizeSessionMessagePinRole(input.role),
    };
}

export function buildSessionMessagePinFallbackIdentity(
    input: SessionMessagePinIdentityInput,
): Extract<SessionMessagePinIdentity, { kind: 'fallback' }> | null {
    const sessionId = normalizeSessionMessagePinSessionId(input.sessionId);
    const seq = normalizeSessionMessagePinSeq(input.seq);
    if (!sessionId || seq === null) return null;
    return {
        kind: 'fallback',
        sessionId,
        seq,
        transcriptBlockIndex: normalizeSessionMessagePinTranscriptBlockIndex(input.transcriptBlockIndex),
        role: normalizeSessionMessagePinRole(input.role),
    };
}

export function sessionMessagePinFallbackIdentityKey(
    identity: Extract<SessionMessagePinIdentity, { kind: 'fallback' }>,
): string {
    return [
        'fallback',
        identity.sessionId,
        String(identity.seq),
        identity.transcriptBlockIndex === null ? 'block:null' : `block:${identity.transcriptBlockIndex}`,
        identity.role,
    ].join('|');
}

export function sessionMessagePinIdentityKey(identity: SessionMessagePinIdentity): string {
    if (identity.kind === 'route-message-id') {
        return [
            'route-message-id',
            identity.sessionId,
            identity.routeMessageId,
            identity.transcriptBlockIndex === null ? 'block:null' : `block:${identity.transcriptBlockIndex}`,
            identity.role,
        ].join('|');
    }
    return sessionMessagePinFallbackIdentityKey(identity);
}

export function resolveSessionMessagePinRowIdentityKey(input: SessionMessagePinIdentityInput): string | null {
    const identity = buildSessionMessagePinIdentity(input);
    return identity ? sessionMessagePinIdentityKey(identity) : null;
}

function sessionMessagePinFallbackInputsMatch(
    a: SessionMessagePinIdentityInput,
    b: SessionMessagePinIdentityInput,
): boolean {
    const aFallback = buildSessionMessagePinFallbackIdentity(a);
    const bFallback = buildSessionMessagePinFallbackIdentity(b);
    return Boolean(
        aFallback
        && bFallback
        && sessionMessagePinFallbackIdentityKey(aFallback) === sessionMessagePinFallbackIdentityKey(bFallback),
    );
}

export function sessionMessagePinRowsMatch(
    a: SessionMessagePinIdentityInput,
    b: SessionMessagePinIdentityInput,
): boolean {
    const aIdentity = buildSessionMessagePinIdentity(a);
    const bIdentity = buildSessionMessagePinIdentity(b);
    if (!aIdentity || !bIdentity) return false;
    if (sessionMessagePinIdentityKey(aIdentity) === sessionMessagePinIdentityKey(bIdentity)) {
        return true;
    }
    return sessionMessagePinFallbackInputsMatch(a, b);
}

export function areSessionMessagePinIdentitiesEqual(
    a: SessionMessagePinIdentity,
    b: SessionMessagePinIdentity,
): boolean {
    return sessionMessagePinIdentityKey(a) === sessionMessagePinIdentityKey(b);
}
