import { ACTION_ID_FAMILIES_V1, type ActionIdFamilyV1 } from '@happier-dev/protocol/actions/actionIds';
import { DECISION_ACTION_IDS, TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS } from '@happier-dev/protocol/actions/decisionAuthority';
import { listActionSpecsForSurface, type ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type {
    DaemonProviderModelProjectionGroupV1,
    DaemonProviderModelProjectionRowV1,
} from '@happier-dev/protocol/rpc';

import {
    ACTION_SETTINGS_FAMILY_ORDER,
    resolveActionIdFamilySettingsFamily,
    type ActionSettingsFamily,
} from '@/components/settings/actions/actionSettingsFamily';
import { providerModelConnectionTitle } from '@/providers/models/providerModelConnectionTitle';

import { apiTokenGrantModelKey } from './apiTokenGrantDraft';

/** An Action a token can be granted: exposed to External API & SDK and runnable by automation. */
export type ApiTokenGrantableAction = Readonly<{
    id: string;
    title: string;
    description: string | null;
    family: ActionIdFamilyV1 | null;
}>;

export type ApiTokenGrantableFamily = Readonly<{
    family: ActionIdFamilyV1;
    actionCount: number;
}>;

/** One coarse Action settings family with the protocol families and actions a token can be granted. */
export type ApiTokenGrantActionGroup = Readonly<{
    settingsFamily: ActionSettingsFamily;
    families: readonly ApiTokenGrantableFamily[];
    actions: readonly ApiTokenGrantableAction[];
}>;

const FAMILY_BY_ACTION_ID: ReadonlyMap<string, ActionIdFamilyV1> = (() => {
    const index = new Map<string, ActionIdFamilyV1>();
    for (const [family, ids] of Object.entries(ACTION_ID_FAMILIES_V1) as [ActionIdFamilyV1, readonly string[]][]) {
        for (const id of ids) if (!index.has(id)) index.set(id, family);
    }
    return index;
})();

/** Decisions are the Approve switch, and discovery always passes: neither is chosen as an Action. */
const NOT_CHOSEN_AS_ACTIONS: ReadonlySet<string> = new Set<string>([
    ...DECISION_ACTION_IDS,
    ...ACTION_ID_FAMILIES_V1.discovery,
]);

function isGrantableSpec(spec: ActionSpec): boolean {
    if (NOT_CHOSEN_AS_ACTIONS.has(spec.id)) return false;
    return spec.requiredAuthority === 'account_automation'
        || (TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(spec.id);
}

/**
 * The Action choices for a token grant, grouped the way Action settings groups them. Only Actions the
 * External API & SDK surface exposes are offered (the spec's own `surfaces.api`, never a UI
 * re-derivation), and a protocol family is offered only when it contains at least one of them.
 */
export function buildApiTokenGrantActionGroups(specs: readonly ActionSpec[] = listActionSpecsForSurface('api')): readonly ApiTokenGrantActionGroup[] {
    const actionsByGroup = new Map<ActionSettingsFamily, ApiTokenGrantableAction[]>();
    const familyCounts = new Map<ActionIdFamilyV1, number>();
    for (const spec of specs) {
        if (!isGrantableSpec(spec)) continue;
        const family = FAMILY_BY_ACTION_ID.get(spec.id) ?? null;
        const group = family ? resolveActionIdFamilySettingsFamily(family) : 'general';
        const list = actionsByGroup.get(group) ?? [];
        list.push({ id: spec.id, title: spec.title, description: spec.description ?? null, family });
        actionsByGroup.set(group, list);
        if (family) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }
    return ACTION_SETTINGS_FAMILY_ORDER.flatMap((settingsFamily) => {
        const actions = (actionsByGroup.get(settingsFamily) ?? []).sort((left, right) => left.title.localeCompare(right.title));
        if (actions.length === 0) return [];
        const families = [...new Set(actions.flatMap((action) => (action.family ? [action.family] : [])))]
            .map((family) => ({ family, actionCount: familyCounts.get(family) ?? 0 }));
        return [{ settingsFamily, families, actions }];
    });
}

/** The title of a granted Action id (a spec title), or null for an id this client does not know. */
export function resolveApiTokenGrantActionTitle(actionId: string, groups: readonly ApiTokenGrantActionGroup[]): string | null {
    for (const group of groups) {
        const action = group.actions.find((entry) => entry.id === actionId);
        if (action) return action.title;
    }
    return null;
}

export type ApiTokenGrantModelOption = Readonly<{
    key: string;
    ref: ProviderBoundModelRef;
    name: string;
    description: string | null;
}>;

/** An Agent's own catalog model (the native, connection-less ref). */
export type ApiTokenGrantNativeModel = Readonly<{ id: string; name: string; description?: string | null }>;

/** One connection of the provider-model projection, reduced to the facts a grant choice reads. */
export type ApiTokenGrantProviderModelGroup = Pick<
    DaemonProviderModelProjectionGroupV1,
    'connectionId' | 'providerName' | 'connectionName' | 'connectionRole' | 'connectionDisplayNameMode'
> & Readonly<{
    rows: readonly Readonly<{
        ref: DaemonProviderModelProjectionRowV1['ref'];
        descriptor: Pick<DaemonProviderModelProjectionRowV1['descriptor'], 'id' | 'name' | 'description'>;
    }>[];
}>;

/**
 * The models a grant can allow for one Agent, in the model manager's order: the Agent's native
 * catalog models, then every provider-connected model the provider-model projection reports, each
 * with the projection's full provider-bound ref. A granted ref neither offers is kept last, named
 * by its model id, so it can still be seen and removed.
 */
export function buildApiTokenGrantModelOptions(input: Readonly<{
    agentTargetKey: string;
    nativeModels: readonly ApiTokenGrantNativeModel[];
    providerGroups: readonly ApiTokenGrantProviderModelGroup[];
    granted: readonly ProviderBoundModelRef[] | null;
}>): readonly ApiTokenGrantModelOption[] {
    const options: ApiTokenGrantModelOption[] = [];
    const seen = new Set<string>();
    const add = (ref: ProviderBoundModelRef, name: string, description: string | null) => {
        if (ref.agentTargetKey !== input.agentTargetKey) return;
        const key = apiTokenGrantModelKey(ref);
        if (seen.has(key)) return;
        seen.add(key);
        options.push({ key, ref, name, description });
    };
    for (const model of input.nativeModels) {
        add({ agentTargetKey: input.agentTargetKey, providerConnectionId: null, modelId: model.id }, model.name || model.id, model.description ?? null);
    }
    for (const group of input.providerGroups) {
        const connection = providerModelConnectionTitle(group);
        for (const row of group.rows) add(row.ref, row.descriptor.name || row.ref.modelId, connection);
    }
    for (const ref of input.granted ?? []) add(ref, ref.modelId, null);
    return options;
}
