import {
    SessionDraftAddressV1Schema,
    canonicalSessionDraftAddressV1,
    type SessionDraftAddressV1,
} from "@happier-dev/protocol";

import { ACCOUNT_SESSION_DRAFT_KV_PREFIX } from "@/app/kv/accountScopedKv";

export { ACCOUNT_SESSION_DRAFT_KV_PREFIX } from "@/app/kv/accountScopedKv";

export const ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES = 191;

export function sessionDraftPhysicalKey(address: SessionDraftAddressV1): string | null {
    const key = `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}${canonicalSessionDraftAddressV1(address)}`;
    return new TextEncoder().encode(key).byteLength <= ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES
        ? key
        : null;
}

export function parseSessionDraftPhysicalKey(key: string): SessionDraftAddressV1 | null {
    if (!key.startsWith(ACCOUNT_SESSION_DRAFT_KV_PREFIX)) return null;
    const logical = key.slice(ACCOUNT_SESSION_DRAFT_KV_PREFIX.length);
    if (logical.startsWith("new-session/")) {
        const parsed = SessionDraftAddressV1Schema.safeParse({
            kind: "newSession",
            draftId: logical.slice("new-session/".length),
        });
        return parsed.success ? parsed.data : null;
    }
    if (!logical.startsWith("session/")) return null;
    try {
        const parsed = SessionDraftAddressV1Schema.safeParse({
            kind: "session",
            sessionId: decodeURIComponent(logical.slice("session/".length)),
        });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
