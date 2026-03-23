export type ClaudeHappierEnvelope = Readonly<{
    kind: string;
    payload: unknown;
}>;

export function readClaudeHappierEnvelope(meta: unknown): ClaudeHappierEnvelope | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const record = meta as Record<string, unknown>;
    const happier = record.happier;
    if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return null;
    const env = happier as Record<string, unknown>;
    if (typeof env.kind !== 'string') return null;
    return { kind: env.kind, payload: env.payload };
}
