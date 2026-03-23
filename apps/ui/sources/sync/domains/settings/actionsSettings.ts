import type { ActionId } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol';

import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';

export function resolveActionsSettingsV1FromState(state: Readonly<{ settings?: unknown }>) {
    const parsed = ActionsSettingsV1Schema.safeParse((state as any)?.settings?.actionsSettingsV1);
    if (parsed.success) return parsed.data as any;
    return { v: 1 as const, actions: {} };
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
