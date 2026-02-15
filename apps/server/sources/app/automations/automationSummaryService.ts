export function sanitizeAutomationErrorMessage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 4_000);
}

export function sanitizeAutomationSummaryCiphertext(value: unknown): string | null {
    const MAX_SUMMARY_CIPHERTEXT_CHARS = 200_000;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, MAX_SUMMARY_CIPHERTEXT_CHARS);
}
