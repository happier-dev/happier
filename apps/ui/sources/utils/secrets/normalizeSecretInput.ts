export function normalizeSecretPromptInput(value: string | null): string | null {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

