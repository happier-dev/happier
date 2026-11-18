import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { EXISTING_SESSION_FIELD_APPLICATIONS } from '@happier-dev/protocol/sessions/authoring/existingSessionFieldApplication';
import type { SessionAuthoringControls } from './useSessionAuthoringControls';
import { resolveSessionAuthoringFieldControl, type SessionAuthoringControlFacts, type SessionAuthoringFieldControlModel, type SessionAuthoringFieldId } from './sessionAuthoringFieldControls';

/** Each target carries its own published catalogs, resolved for the effective Agent. */
export type CrossSessionAuthoringControlTarget = Readonly<{
    agentId: string | null;
    values: WorkflowSessionAuthoringSelection;
    controls: SessionAuthoringControls;
    facts?: SessionAuthoringControlFacts;
}>;

type Options = Extract<SessionAuthoringFieldControlModel, { kind: 'options' }>;

function intersectOptions(models: readonly Options[], mixedLabel: string): Options {
    const first = models[0]!;
    const others = models.slice(1).map(model => new Map(model.options.map(option => [option.id, option])));
    const options = first.options.filter(option => others.every(choices => choices.has(option.id)))
        .map(option => others.some(choices => choices.get(option.id)?.disabled) ? { ...option, disabled: true } : option);
    const mixed = models.some(model => model.selectedOptionId !== first.selectedOptionId);
    if (!mixed) return { ...first, options };
    let unselectedOptionId = '';
    while (options.some(option => option.id === unselectedOptionId)) unselectedOptionId += '_';
    const { preserved: _preserved, unselectedLabel: _label, ...base } = first;
    return { ...base, options, selectedOptionId: unselectedOptionId,
        ...(mixed ? { unselectedLabel: mixedLabel } : {}) };
}

export function resolveCrossSessionAuthoringFieldControl(params: Readonly<{
    field: SessionAuthoringFieldId;
    targets: readonly CrossSessionAuthoringControlTarget[];
    selection?: WorkflowSessionAuthoringSelection;
    agentSwitchingEnabled: boolean;
    mixedLabel: string;
}>): SessionAuthoringFieldControlModel {
    const { field, targets, selection = {}, mixedLabel } = params;
    const unavailable = (reason: Extract<SessionAuthoringFieldControlModel, { kind: 'unavailable' }>['reason']): SessionAuthoringFieldControlModel => ({ field, kind: 'unavailable', reason });
    if (field === 'agentTarget' && !params.agentSwitchingEnabled) return unavailable('feature_disabled');
    if (targets.length === 0 || EXISTING_SESSION_FIELD_APPLICATIONS[field].via === 'unsupported') return unavailable('not_supported_on_target');
    if (!selection.agentTarget && (field === 'modelSelection' || field === 'sessionConfigOptionOverrides' || field === 'connectedServices')
        && targets.some(target => target.agentId !== targets[0]!.agentId)) return unavailable('requires_agent_target');
    const models = targets.map(target => resolveSessionAuthoringFieldControl({
        field, agentId: target.agentId, controls: target.controls, facts: target.facts,
        values: { ...target.values, ...selection,
            ...(selection.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: {
                ...selection.sessionConfigOptionOverrides,
                overrides: { ...target.values.sessionConfigOptionOverrides?.overrides, ...selection.sessionConfigOptionOverrides.overrides },
            } } : {}),
        },
    }));
    const refusal = models.find(model => model.kind === 'unavailable');
    if (refusal) return refusal;
    const first = models[0]!;
    if (first.kind === 'options') {
        const optionsModels = models.filter((model): model is Options => model.kind === 'options');
        if (optionsModels.length !== models.length) return unavailable('not_supported_on_target');
        const result = intersectOptions(optionsModels, mixedLabel);
        return result.options.length ? result : unavailable('not_supported_on_target');
    }
    if (first.kind === 'optionGroups') {
        const groupsModels = models.filter(model => model.kind === 'optionGroups');
        if (groupsModels.length !== models.length) return unavailable('not_supported_on_target');
        const groups = first.groups.flatMap(group => {
            const peers = groupsModels.map(model => model.groups.find(peer => peer.id === group.id));
            if (peers.some(peer => !peer)) return [];
            const result = intersectOptions(peers.map(peer => ({ ...peer!, kind: 'options', field, title: group.title })), mixedLabel);
            return result.options.length ? [{ id: group.id, title: group.title, options: result.options,
                selectedOptionId: result.selectedOptionId, ...(result.unselectedLabel ? { unselectedLabel: result.unselectedLabel } : {}) }] : [];
        });
        return groups.length ? { ...first, groups } : unavailable('not_supported_on_target');
    }
    // Connected Services retain the canonical account picker; the host supplies its exact Home context.
    return first.kind === 'connectedServices' ? first : unavailable('not_supported_on_target');
}
