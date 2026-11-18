import type { ActionSettingsActionId, ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { TranslationKey } from '@/text';

import {
    resolveActionSettingsTargetControlState,
    type ActionSettingsTargetId,
} from './actionSettingsTargets';
import type { ActionSettingsTargetState } from './buildActionSettingsEntries';
import type { ActionSettingsTargetDefinition } from './actionSettingsTargetDefinitions';
import { getActionTargetApprovalPolicy } from './actionSettingsTargetApproval';
import { getActionSettingsTargetDefaultSelected } from './actionSettingsTargetSelection';

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
    audiences: readonly ActionSettingsAudienceStatus[];
    danger: 'destructive' | 'external' | null;
}>;

type ActionSettingsAudience = 'human' | 'agent' | 'integration';
type ActionSettingsAudienceStatus = Readonly<{
    audience: ActionSettingsAudience;
    allowedCount: number;
    askFirstCount: number;
    offCount: number;
    /** Some surface of this audience was set away from its default (a choice, or a surface turned off). */
    departed?: boolean;
}>;

export type ActionSettingsEntryStatusPart = Readonly<{
    labelKey: Extract<TranslationKey,
        `settingsActions.status.${ActionSettingsAudience}${'Allowed' | 'AskFirst' | 'Off'}`
        | `settingsActions.status.${'allOff' | 'destructive' | 'external'}`>;
    partial: boolean;
}>;

export function resolveActionSettingsEntryStatusSummary(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targets: readonly ActionSettingsEntryStatusTarget[];
    scmRemoteConfirmPolicy?: unknown;
}>): ActionSettingsEntryStatusSummary {
    const summary = {
        allowedCount: 0,
        askFirstCount: 0,
        offCount: 0,
        unavailableCount: 0,
    };
    const audiences: ActionSettingsAudienceStatus[] = [];
    let danger: ActionSettingsEntryStatusSummary['danger'] = null;

    for (const target of params.targets) {
        const declaredDanger = target.definition.contributedAction?.dangerLevel;
        if (declaredDanger === 'destructive') danger = 'destructive';
        else if (danger === null && (declaredDanger === 'externalSideEffect' || declaredDanger === 'writesRemote')) danger = 'external';
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
            scmRemoteConfirmPolicy: params.scmRemoteConfirmPolicy,
        });
        const audience: ActionSettingsAudience = target.id === 'agent' || target.id === 'voice' || target.id === 'voice_panel'
            ? 'agent' : target.definition.kind === 'placement' || target.id === 'contextual_ui' || target.id === 'slash_command'
                ? 'human' : 'integration';
        // Visibility controls do not own execution approval. The incumbent
        // approval owner maps the target and retains its manifest facts.
        const approvalRequired = controlState.kind === 'approval' ? controlState.approvalRequiredByPolicy
            : getActionTargetApprovalPolicy({
                settings: params.settings, actionId: params.actionId, targetId: target.id,
                target: target.definition, scmRemoteConfirmPolicy: params.scmRemoteConfirmPolicy,
            }).approvalRequiredByPolicy;
        const key = params.settings.actions[params.actionId]?.enabled === false || controlState.value === 'off'
            ? 'offCount' : approvalRequired ? 'askFirstCount' : 'allowedCount';
        summary[key] += 1;
        const index = audiences.findIndex((entry) => entry.audience === audience);
        const previous = index === -1 ? { audience, allowedCount: 0, askFirstCount: 0, offCount: 0 } : audiences[index]!;
        // A departure is a choice away from the target's own default: a target turned away from where it starts
        // (opt-in placements start off), or an approval other than the inherited default. A target that can't
        // skip review asks first by default, so that is no choice (WAVE-ACCEPT-1118D).
        const startsOn = getActionSettingsTargetDefaultSelected({
            settings: params.settings, actionId: params.actionId, targetId: target.id, target: target.definition,
        });
        const on = controlState.value !== 'off';
        const departs = params.settings.actions[params.actionId]?.enabled === false || on !== startsOn
            || (on && controlState.kind === 'approval' && controlState.approvalWaivable && controlState.value !== 'default');
        const next = { ...previous, [key]: previous[key] + 1, ...(departs || previous.departed ? { departed: true } : {}) };
        if (index === -1) audiences.push(next);
        else audiences[index] = next;
    }

    return { ...summary, audiences: (['human', 'agent', 'integration'] as const).flatMap((audience) => audiences.filter((entry) => entry.audience === audience)), danger };
}

export function listActionSettingsEntryStatusParts(
    summary: ActionSettingsEntryStatusSummary,
): readonly ActionSettingsEntryStatusPart[] {
    const parts: ActionSettingsEntryStatusPart[] = summary.allowedCount === 0 && summary.askFirstCount === 0 && summary.offCount > 0
        // "Off" is a departure too: an Action that only starts off (an untouched opt-in placement) says nothing.
        && summary.audiences.some((audience) => audience.departed === true)
        ? [{ labelKey: 'settingsActions.status.allOff', partial: false }]
        // Each audience is named once: by the state most of its surfaces have (a tie reads as the stricter one),
        // marked partial when some surfaces differ, so a row never repeats "Some integrations".
        // A row shows only what departs from the defaults; an audience left on its defaults says nothing.
        : summary.audiences.filter((audience) => audience.departed === true).flatMap((audience) => {
            const total = audience.allowedCount + audience.askFirstCount + audience.offCount;
            const [key, suffix] = ([['offCount', 'Off'], ['askFirstCount', 'AskFirst'], ['allowedCount', 'Allowed']] as const)
                .reduce((best, candidate) => audience[candidate[0]] > audience[best[0]] ? candidate : best);
            return total === 0 ? [] : [{ labelKey: `settingsActions.status.${audience.audience}${suffix}` as const, partial: audience[key] < total }];
        });
    if (summary.danger) parts.push({ labelKey: `settingsActions.status.${summary.danger}`, partial: false });
    return parts;
}
