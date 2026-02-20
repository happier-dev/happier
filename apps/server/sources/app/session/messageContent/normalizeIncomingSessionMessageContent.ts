export function normalizeIncomingSessionMessageContent(raw: unknown): PrismaJson.SessionMessageContent | null {
    if (typeof raw === "string") {
        const ciphertext = raw.trim();
        if (!ciphertext) return null;
        return { t: "encrypted", c: ciphertext };
    }

    if (!raw || typeof raw !== "object") return null;

    const candidate = raw as Record<string, unknown>;
    const t = candidate.t;
    if (t === "encrypted") {
        const c = candidate.c;
        if (typeof c !== "string" || !c.trim()) return null;
        return { t: "encrypted", c };
    }
    if (t === "plain") {
        if (!("v" in candidate)) return null;
        return { t: "plain", v: candidate.v };
    }

    return null;
}

