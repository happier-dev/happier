import { isNativeAutomaticModelSelectionInputV1, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/selection/v1';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { PersonalSessionModelRef, SessionModelRefV2 } from '@happier-dev/protocol/providers/selection/v2';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

export type SessionModelPickerValue = PersonalSessionModelRef | null;
export type SessionModelPickerOptionValue = SessionModelPickerValue | TeamCredentialProviderModelSelectionV1;

/** The picker retains every source fact while adapting to its existing source-aware option contract. */
export function sessionModelPickerValueFromRef(ref: ProviderBoundModelRef | SessionModelRefV2 | null | undefined): SessionModelPickerOptionValue {
    if (!ref) return null;
    if (!('source' in ref) || ref.source === 'connected_account') return ref;
    if (ref.source === 'team_resource') {
        const { source: _source, ...selection } = ref;
        return { kind: 'team_credential_provider_model', ...selection };
    }
    return { agentTargetKey: ref.agentTargetKey, modelId: ref.modelId,
        providerConnectionId: ref.source === 'account_provider_connection' ? ref.providerConnectionId : null };
}

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
    if (value === null) return 'automatic';
    if (isTeamCredentialProviderModelPickerValue(value)) {
        return JSON.stringify(['team_resource', value.teamId, value.resourceId, value.expectedResourceRevision, value.deliveryMode, value.agentTargetKey, value.modelId]);
    }
    if ('source' in value) {
        return JSON.stringify([value.source, qualifiedPurposeKey(value.purpose), value.endpointTemplateId, value.agentTargetKey, value.modelId]);
    }
    return isNativeAutomaticModelSelectionInputV1(value)
        ? 'automatic'
        : JSON.stringify([value.agentTargetKey, value.providerConnectionId, value.modelId]);
}
