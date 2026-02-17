export { parseBooleanEnv, parseOptionalBooleanEnv } from "@happier-dev/protocol";

export function parseIntEnv(raw: string | undefined, fallback: number, opts?: { min?: number; max?: number }): number {
    if (typeof raw !== "string") return fallback;
    const trimmed = raw.trim();
    if (!trimmed) return fallback;

    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return fallback;
    if (typeof opts?.min === "number" && n < opts.min) return fallback;
    if (typeof opts?.max === "number" && n > opts.max) return fallback;
    return n;
}
