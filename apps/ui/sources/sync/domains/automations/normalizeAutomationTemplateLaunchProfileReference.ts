import {
    readBackendTargetRefV2,
    type AiLaunchProfile,
    type ProviderSettingsMigrationStateV1,
} from '@happier-dev/protocol';

import { resolveLaunchProfileAuthoringIntent } from '@/sync/domains/profiles/resolveLaunchProfileAuthoringIntent';

import type { AutomationTemplate } from './automationTypes';

function parsePersistableBackendTargetKey(targetKey: string): NonNullable<AutomationTemplate['backendTarget']> {
    const { sourceKind: _sourceKind, ...target } = readBackendTargetRefV2(targetKey);
    return target;
}

export function normalizeAutomationTemplateLaunchProfileReference(params: Readonly<{
    template: AutomationTemplate;
    profiles: readonly AiLaunchProfile[];
    migration: ProviderSettingsMigrationStateV1 | undefined;
}>): AutomationTemplate {
    const rawProfileId = typeof params.template.profileId === 'string'
        ? params.template.profileId.trim()
        : '';
    if (!rawProfileId) return params.template;

    const intent = resolveLaunchProfileAuthoringIntent({
        profileId: rawProfileId,
        profiles: params.profiles,
        migration: params.migration,
    });
    const { profileId: _legacyProfileId, modelId, modelUpdatedAt, ...withoutLegacyReference } = params.template;
    const normalizedProfile = intent.profileId ? { profileId: intent.profileId } : {};
    const hasExplicitStructuredModel = Object.prototype.hasOwnProperty.call(params.template, 'modelSelection');
    const hasExplicitLegacyModel = Object.prototype.hasOwnProperty.call(params.template, 'modelId');

    if (hasExplicitStructuredModel || hasExplicitLegacyModel || !intent.modelSelection) {
        const preferredTarget = !params.template.backendTarget
            && !params.template.agent
            && intent.preferredAgentTargetKey
            ? { backendTarget: parsePersistableBackendTargetKey(intent.preferredAgentTargetKey) }
            : {};
        return {
            ...withoutLegacyReference,
            ...normalizedProfile,
            ...preferredTarget,
            ...(hasExplicitStructuredModel ? { modelSelection: params.template.modelSelection } : {}),
            ...(hasExplicitLegacyModel ? { modelId, ...(modelUpdatedAt !== undefined ? { modelUpdatedAt } : {}) } : {}),
        };
    }

    return {
        ...withoutLegacyReference,
        ...normalizedProfile,
        backendTarget: parsePersistableBackendTargetKey(intent.modelSelection.ref.agentTargetKey),
        modelSelection: intent.modelSelection,
    };
}
