import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/selection/v1';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

export type SessionModelPickerValue = ProviderBoundModelRef | null;
export type SessionModelPickerOptionValue = SessionModelPickerValue | TeamCredentialProviderModelSelectionV1;

export function isTeamCredentialProviderModelPickerValue(
    value: SessionModelPickerOptionValue,
): value is TeamCredentialProviderModelSelectionV1 {
    return value !== null && 'kind' in value && value.kind === 'team_credential_provider_model';
}

/**
 * Canonical UI identity for a session model selection.
 *
 * The key deliberately includes the Agent target and Provider connection so
 * equal vendor model ids from native, work, and personal connections never
 * collapse into one row or favorite.
 */
export function sessionModelSelectionKey(value: SessionModelPickerOptionValue): string {
    return value === null
        ? 'automatic'
        : isTeamCredentialProviderModelPickerValue(value)
            ? JSON.stringify(['team_resource', value.teamId, value.resourceId, value.expectedResourceRevision, value.deliveryMode, value.agentTargetKey, value.modelId])
            : JSON.stringify([value.agentTargetKey, value.providerConnectionId, value.modelId]);
}
