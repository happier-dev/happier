import {
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
} from '@happier-dev/plugin-sdk/experimental/sessions';

function normalizeReasoningEffort(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSessionMetadata(session: unknown): Record<string, unknown> | null {
    if (!isRecord(session)) return null;
    return isRecord(session.metadata) ? session.metadata : null;
}

function readSessionConfigOptionOverrideValue(raw: unknown, key: string): unknown {
    if (!isRecord(raw)) return undefined;
    if (raw.v !== 1) return undefined;
    const overrides = isRecord(raw.overrides) ? raw.overrides : null;
    const override = isRecord(overrides?.[key]) ? overrides[key] : null;
    return override?.value;
}

function hasExplicitReasoningEffortOverride(metaOverrides: Record<string, unknown> | undefined): boolean {
    if (!metaOverrides) return false;
    return Object.prototype.hasOwnProperty.call(metaOverrides, 'reasoningEffort')
        || Object.prototype.hasOwnProperty.call(metaOverrides, 'reasoning_effort');
}

export function buildClaudeReasoningEffortMessageMetaOverrides(params: Readonly<{
    session: unknown;
    metaOverrides?: Record<string, unknown>;
}>): Record<string, unknown> | undefined {
    const metaOverrides = isRecord(params.metaOverrides) ? params.metaOverrides : undefined;
    if (hasExplicitReasoningEffortOverride(metaOverrides)) {
        return metaOverrides;
    }

    const metadata = readSessionMetadata(params.session);
    const reasoningEffort = normalizeReasoningEffort(
        readSessionConfigOptionOverrideValue(
            readMetadataAliasValue(
                metadata,
                SESSION_CONFIG_OPTION_OVERRIDES_KEY,
                LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
            ),
            'reasoning_effort',
        ),
    );

    if (!reasoningEffort) {
        return metaOverrides;
    }

    return {
        ...(metaOverrides ?? {}),
        reasoningEffort,
    };
}
