import type { ProviderBoundModelRef } from '@happier-dev/protocol';

export type SessionModelPickerValue = ProviderBoundModelRef | null;

/**
 * Canonical UI identity for a session model selection.
 *
 * The key deliberately includes the Agent target and Provider connection so
 * equal vendor model ids from native, work, and personal connections never
 * collapse into one row or favorite.
 */
export function sessionModelSelectionKey(value: SessionModelPickerValue): string {
    return value === null
        ? 'automatic'
        : JSON.stringify([value.agentTargetKey, value.providerConnectionId, value.modelId]);
}
