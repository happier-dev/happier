function parseOptionalPositiveInt(value: unknown): number | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.floor(parsed);
    return normalized > 0 ? normalized : undefined;
}

// Keep parity with the existing UI-side file preview ceiling until the app-level
// config promotes a dedicated bulk JSON budget.
const DEFAULT_BULK_TRANSFER_JSON_MAX_BYTES = 2_500_000;
const BULK_TRANSFER_JSON_HARD_MAX_BYTES = 10_000_000;

export function resolveBulkTransferJsonMaxBytes(maxBytes?: number | null): number {
    const resolved = (
        parseOptionalPositiveInt(maxBytes)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_BULK_TRANSFER_JSON_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_BULK_TRANSFER_JSON_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES)
        ?? DEFAULT_BULK_TRANSFER_JSON_MAX_BYTES
    );
    return Math.min(resolved, BULK_TRANSFER_JSON_HARD_MAX_BYTES);
}
