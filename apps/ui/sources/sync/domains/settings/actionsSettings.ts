import type { ActionId } from '@happier-dev/protocol';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from '@happier-dev/protocol';

import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';

export function resolveActionsSettingsV1FromState(state: Readonly<{ settings?: unknown }>) {
    return normalizeActionsSettingsV1((state as any)?.settings?.actionsSettingsV1);
}

export function isActionEnabledInState(
    state: Readonly<{ settings?: unknown }>,
    actionId: ActionId,
    ctx?: Readonly<{ surface?: string | null; placement?: string | null }>,
): boolean {
    const settingsState = ((state as any)?.settings ?? {}) as any;
    if (isExecutionRunsFeatureAction(actionId) && !resolveLocalFeaturePolicyEnabled('execution.runs', settingsState)) {
        return false;
    }

    const settings = resolveActionsSettingsV1FromState(state);
    return isActionEnabledByActionsSettings(actionId, settings as any, ctx as any);
}
