export type ParseSessionMessageSidechainIdResult =
    | Readonly<{ ok: true; sidechainId: string | null }>
    | Readonly<{ ok: false }>;

// Keep IDs short and cross-database compatible.
// MySQL migrations store this as VARCHAR(191).
const SESSION_MESSAGE_SIDECHAIN_ID_MAX_LENGTH = 191;

export function parseSessionMessageSidechainId(
    raw: unknown,
    opts?: Readonly<{
        emptyString: "null" | "invalid";
    }>,
): ParseSessionMessageSidechainIdResult {
    if (raw === null || raw === undefined) {
        return { ok: true, sidechainId: null };
    }
    if (typeof raw !== "string") {
        return { ok: false };
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return opts?.emptyString === "null" ? { ok: true, sidechainId: null } : { ok: false };
    }
    if (trimmed.length > SESSION_MESSAGE_SIDECHAIN_ID_MAX_LENGTH) {
        return { ok: false };
    }
    return { ok: true, sidechainId: trimmed };
}
