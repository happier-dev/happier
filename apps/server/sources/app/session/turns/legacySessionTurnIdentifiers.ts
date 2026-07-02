import { createHash } from "node:crypto";

import {
    SessionIndexedIdentifierMaxLengthV1,
} from "@happier-dev/protocol";

const LEGACY_IDENTIFIER_HASH_LENGTH = 16;

function hashLegacyIdentifier(value: string): string {
    return createHash("sha256")
        .update(value, "utf8")
        .digest("base64url")
        .slice(0, LEGACY_IDENTIFIER_HASH_LENGTH);
}

function buildBoundedLegacySessionTurnIdentifier(params: {
    prefix: string;
    sessionId: string;
    suffixParts: readonly (number | string)[];
}): string {
    const suffix = params.suffixParts.map(String).join(":");
    const raw = [params.prefix, params.sessionId, suffix].filter(Boolean).join(":");
    if (raw.length <= SessionIndexedIdentifierMaxLengthV1) {
        return raw;
    }

    const prefix = `${params.prefix}:`;
    const hash = hashLegacyIdentifier(raw);
    const tail = suffix ? `${hash}:${suffix}` : hash;
    const sessionIdBudget = SessionIndexedIdentifierMaxLengthV1 - prefix.length - tail.length - 1;
    if (sessionIdBudget <= 0) {
        return `${prefix}${tail}`.slice(0, SessionIndexedIdentifierMaxLengthV1);
    }
    return `${prefix}${params.sessionId.slice(0, sessionIdBudget)}:${tail}`;
}

export function buildLegacySessionEndMutationIdentifier(params: {
    sessionId: string;
    time: number;
}): string {
    return buildBoundedLegacySessionTurnIdentifier({
        prefix: "legacy-session-end",
        sessionId: params.sessionId,
        suffixParts: [params.time],
    });
}
