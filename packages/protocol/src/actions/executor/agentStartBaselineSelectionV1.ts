import type { AgentStartContextV1 } from '../../account/settings/admitAgentStartV1.js';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { resolveConnectedServiceBindingsForChild, type ConnectedServiceBindingsV2 } from '../../connect/connectedServiceBindings.js';

/** Credential-route decision only; native dispatch owns its wire failure details. */
export class AgentStartBaselineSelectionErrorV1 extends Error {
    readonly code = 'execution_run_child_choice_required';
    constructor() {
        super('Choose a child credential route; direct Team credential custody cannot be inherited.');
        this.name = 'AgentStartBaselineSelectionErrorV1';
    }
}

/** Pure selection only: no Action admission or Workflow schema initialization. */
export function resolveAgentStartBaselineSelectionV1<Profile, Connected>(input: Readonly<{
    targetKey?: string;
    profileId: Profile;
    connectedServices: Connected;
    connectedServicesDefaultServiceIds?: unknown;
    modelSelection?: unknown;
    teamCredentialModel?: unknown;
    childSelection?: unknown;
}>, parent: (Omit<NonNullable<AgentStartContextV1['baseline']['configuration']>, 'connectedServices'>
    & Readonly<{ connectedServices?: ConnectedServiceBindingsV2 | null; directParentCustody?: true }>) | undefined): Readonly<{
    profileId?: Profile | string;
    connectedServices?: Connected | ConnectedServiceBindingsV2 | null;
}> {
    const originTargetKey = parent?.agentTarget ? buildBackendTargetKeyV2(parent.agentTarget) : undefined;
    const sameAgent = input.targetKey !== undefined && input.targetKey === originTargetKey;
    const model = input.modelSelection && typeof input.modelSelection === 'object'
        ? 'ref' in input.modelSelection ? input.modelSelection.ref : input.modelSelection : undefined;
    const explicitSource = input.modelSelection === null || input.teamCredentialModel !== undefined
        || input.childSelection === 'agentDefault'
        || (Array.isArray(input.connectedServicesDefaultServiceIds) && input.connectedServicesDefaultServiceIds.length > 0)
        || (model && typeof model === 'object' && (
            ('source' in model && model.source === 'team_resource')
            || ('providerConnectionId' in model && model.providerConnectionId != null)
        ));
    const connectedServices = resolveConnectedServiceBindingsForChild({ explicitSelection: input.connectedServices,
        resolvedTargetKey: input.targetKey, originTargetKey,
        originBindings: explicitSource ? undefined : parent?.connectedServices });
    if (input.connectedServices === undefined && !explicitSource && input.targetKey
        && (parent?.directParentCustody || (connectedServices !== undefined && parent?.connectedServices
            && Object.values(parent.connectedServices.bindingsByServiceId).some(binding => binding.source === 'team_resource' && binding.deliveryMode === 'direct')))) {
        throw new AgentStartBaselineSelectionErrorV1();
    }
    const profileId = input.profileId === undefined && sameAgent && input.childSelection !== 'agentDefault'
        ? parent?.profileId : input.profileId;
    return {
        ...(profileId !== undefined ? { profileId } : {}),
        ...(connectedServices !== undefined ? { connectedServices } : {}),
    };
}
