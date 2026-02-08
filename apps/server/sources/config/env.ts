export function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
    if (typeof raw !== "string") return fallback;
    const v = raw.trim().toLowerCase();
    if (!v) return fallback;
    if (v === "1" || v === "true" || v === "yes" || v === "y" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "n" || v === "off") return false;
    return fallback;
}

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

