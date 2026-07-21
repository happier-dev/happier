import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import { resolveMetadataStringOverrideV1 } from '@happier-dev/agents';

import type { SessionComposerNonSteerablePayloadReason } from '@/agents/registry/registryUiBehavior';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionConfigOptionOverridesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

const CLAUDE_NON_STEERABLE_META_KEYS = new Set([
    'model',
    'fallbackModel',
    'reasoningEffort',
    'ultracode',
    'maxThinkingTokens',
]);

const CLAUDE_NON_STEERABLE_CONFIG_OPTION_IDS = new Set([
    'reasoning_effort',
    'ultracode',
    'max_thinking_tokens',
    'maxThinkingTokens',
]);

function normalizeUpdatedAt(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeConfigValue(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

function hasProviderConfigMeta(metaOverrides: Record<string, unknown> | undefined): boolean {
    if (!metaOverrides) return false;
    for (const key of CLAUDE_NON_STEERABLE_META_KEYS) {
        if (Object.prototype.hasOwnProperty.call(metaOverrides, key)) {
            return true;
        }
    }
    return false;
}

function hasFreshModelOverride(session: Session | null | undefined): boolean {
    if (!session) return false;
    const localUpdatedAt = normalizeUpdatedAt(session.modelModeUpdatedAt);
    if (localUpdatedAt === 0) return false;

    const metadataOverride = resolveMetadataStringOverrideV1(session.metadata, 'modelOverrideV1', 'modelId');
    const metadataUpdatedAt = normalizeUpdatedAt(metadataOverride?.updatedAt);
    if (localUpdatedAt <= metadataUpdatedAt) return false;

    const selectedModelId = typeof session.modelMode === 'string' ? session.modelMode.trim() : '';
    if (!selectedModelId) return false;
    const currentModelId = metadataOverride?.value?.trim() ?? '';
    if (selectedModelId === 'default' && currentModelId.length === 0) return false;
    return selectedModelId !== currentModelId;
}

function readMetadataConfigOptionOverrides(session: Session | null | undefined): AcpConfigOptionOverridesV1 | null {
    return readSessionConfigOptionOverridesState(session?.metadata ?? null);
}

function hasFreshConfigOptionOverride(
    session: Session | null | undefined,
    configOptionOverrides: AcpConfigOptionOverridesV1 | null | undefined,
): boolean {
    const overrides = configOptionOverrides?.overrides;
    if (!overrides || typeof overrides !== 'object') return false;

    const metadataOverrides = readMetadataConfigOptionOverrides(session)?.overrides ?? {};
    for (const optionId of CLAUDE_NON_STEERABLE_CONFIG_OPTION_IDS) {
        const entry = overrides[optionId];
        const value = normalizeConfigValue(entry?.value);
        if (value === null) continue;

        const metadataEntry = metadataOverrides[optionId];
        const metadataValue = normalizeConfigValue(metadataEntry?.value);
        const updatedAt = normalizeUpdatedAt(entry?.updatedAt);
        const metadataUpdatedAt = normalizeUpdatedAt(metadataEntry?.updatedAt);
        if (updatedAt > metadataUpdatedAt || value !== metadataValue) {
            return true;
        }
    }
    return false;
}

export function classifyClaudeSessionComposerNonSteerablePayload(params: Readonly<{
    session: Session | null | undefined;
    configOptionOverrides: AcpConfigOptionOverridesV1 | null | undefined;
    metaOverrides?: Record<string, unknown>;
}>): SessionComposerNonSteerablePayloadReason | null {
    if (
        hasProviderConfigMeta(params.metaOverrides)
        || hasFreshModelOverride(params.session)
        || hasFreshConfigOptionOverride(params.session, params.configOptionOverrides)
    ) {
        return 'provider_config_change_refused';
    }
    return null;
}
