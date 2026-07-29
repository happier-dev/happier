import type { SecretString } from '@/sync/encryption/secretSettings';

/**
 * Normalize raw prompt text into a sealed {@link SecretString} (or `null`).
 *
 * Trims surrounding whitespace and treats empty/whitespace-only input as
 * "cleared" (`null`). Non-empty input is wrapped in the canonical
 * `{ _isSecretValue: true, value }` envelope so secret settings stay sealed.
 *
 * Single owner for the previously-duplicated per-panel copies of this helper.
 */
export function normalizeSecretStringPromptInput(value: string | null): SecretString | null {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}
