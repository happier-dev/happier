import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';

/**
 * Read a declared manifest title, accepting both the plain-string and the
 * localized `{ key, fallback }` authoring shapes. Returns null when the
 * declaration carries no usable text, so callers decide their own fallback.
 */
export function readDeclaredAgentTitle(title: unknown): string | null {
    return resolvePluginLocalizedStringV2Text(title).trim() || null;
}

