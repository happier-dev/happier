export type SessionTranscriptActionResult<TPayload extends Record<string, unknown>> =
    | Readonly<{ ok: true } & TPayload>
    | Readonly<{ ok: false; errorCode: string; message: string }>;

export type SessionTranscriptActionItem = Readonly<{
    id: string;
    seq?: number;
    createdAt?: number;
    text?: string;
    content?: unknown;
    raw?: unknown;
}>;

export function readRecord(input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

export function readOptionalString(input: Record<string, unknown>, key: string): string | null {
    const value = input[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizeBoundedInt(value: unknown, fallback: number, max: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? Math.min(value, max)
        : fallback;
}
