import type { ActionSettingsActionId, ActionsSettingsV1 } from '@happier-dev/protocol';
import type { TranslationKey } from '@/text';

import {
    resolveActionSettingsTargetControlState,
    type ActionSettingsTargetId,
} from './actionSettingsTargets';
import type { ActionSettingsTargetState } from './buildActionSettingsEntries';
import type { ActionSettingsTargetDefinition } from './actionSettingsTargetDefinitions';

export type ActionSettingsEntryStatusTarget = Readonly<{
    id: ActionSettingsTargetId;
    state: ActionSettingsTargetState;
    definition: ActionSettingsTargetDefinition;
}>;

export type ActionSettingsEntryStatusSummary = Readonly<{
    allowedCount: number;
    askFirstCount: number;
    offCount: number;
    unavailableCount: number;
}>;

export type ActionSettingsEntryStatusPart = Readonly<{
    key: keyof ActionSettingsEntryStatusSummary;
    count: number;
    labelKey: Extract<TranslationKey, `settingsActions.status.${string}`>;
}>;

export function resolveActionSettingsEntryStatusSummary(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targets: readonly ActionSettingsEntryStatusTarget[];
}>): ActionSettingsEntryStatusSummary {
    const summary = {
        allowedCount: 0,
        askFirstCount: 0,
        offCount: 0,
        unavailableCount: 0,
    };

    for (const target of params.targets) {
        if (target.state === 'unavailable') {
            summary.unavailableCount += 1;
            continue;
        }

        const controlState = resolveActionSettingsTargetControlState({
            settings: params.settings,
            actionId: params.actionId,
            targetId: target.id,
            target: target.definition,
            available: true,
        });

        if (controlState.kind === 'approval') {
            if (controlState.value === 'ask_first') {
                summary.askFirstCount += 1;
            } else if (controlState.value === 'allowed') {
                summary.allowedCount += 1;
            } else {
                summary.offCount += 1;
            }
            continue;
        }

        if (controlState.kind === 'switch' && controlState.value === 'on') {
            summary.allowedCount += 1;
        } else {
            summary.offCount += 1;
        }
    }

    return summary;
}

export function listActionSettingsEntryStatusParts(
    summary: ActionSettingsEntryStatusSummary,
): readonly ActionSettingsEntryStatusPart[] {
    const parts: readonly ActionSettingsEntryStatusPart[] = [
        { key: 'allowedCount', count: summary.allowedCount, labelKey: 'settingsActions.status.allowed' },
        { key: 'askFirstCount', count: summary.askFirstCount, labelKey: 'settingsActions.status.askFirst' },
        { key: 'offCount', count: summary.offCount, labelKey: 'settingsActions.status.off' },
    ];

    return parts.filter((part) => part.count > 0);
}
