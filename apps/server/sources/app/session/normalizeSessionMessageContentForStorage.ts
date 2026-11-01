import { warn } from "@/utils/logging/log";

const INVALID_KEY = Symbol("invalid-json-key");

/** PostgreSQL JSONB cannot represent NUL. Normalize before persistence AND idempotency checks. */
export function normalizeSessionMessageContentForStorage(
    content: PrismaJson.SessionMessageContent,
): PrismaJson.SessionMessageContent | null {
    // Ciphertext is opaque base64. Never repair encrypted data.
    if (content.t === "encrypted") return content.c.includes("\u0000") ? null : content;
    let changed = false;
    function normalize(value: unknown): unknown {
        if (typeof value === "string") {
            const normalized = value.replaceAll("\u0000", "");
            if (normalized !== value) changed = true;
            return normalized;
        }
        if (Array.isArray(value)) {
            const normalized = value.map(normalize);
            return normalized.includes(INVALID_KEY) ? INVALID_KEY : normalized;
        }
        if (value && typeof value === "object") {
            const entries: [string, unknown][] = [];
            for (const [key, child] of Object.entries(value)) {
                // Rewriting keys can collapse distinct fields and silently lose data.
                if (key.includes("\u0000")) return INVALID_KEY;
                const normalized = normalize(child);
                if (normalized === INVALID_KEY) return INVALID_KEY;
                entries.push([key, normalized]);
            }
            return Object.fromEntries(entries);
        }
        return value;
    }
    const value = normalize(content.v);
    if (value === INVALID_KEY) return null;
    if (!changed) return content;
    warn({ module: "session-message-content", event: "nul-removed" }, "Removed NUL characters from plaintext message content");
    return { t: "plain", v: value };
}
