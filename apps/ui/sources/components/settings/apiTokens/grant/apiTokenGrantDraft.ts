import {
    API_TOKEN_FULL_GRANT_V1,
    ApiTokenGrantOriginV1Schema,
    ApiTokenGrantV1Schema,
    isApiTokenDeploymentGrantV1,
    isApiTokenGrantActionAllowedV1,
    type ApiTokenGrantV1,
} from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ActionIdFamilyV1 } from '@happier-dev/protocol/actions/actionIds';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';

/**
 * The draft a person edits in the grant editor is the protocol grant itself: every edit produces a
 * complete `ApiTokenGrantV1`, and the protocol schema decides whether it can be sent. Fields the
 * editor does not show (`permissionModes`, `create`) pass through untouched, so Settings → Embeds
 * can own them on the same value.
 */

/** Where a newly limited token starts: nothing to do until actions are chosen; everything else open. */
export const API_TOKEN_LIMITED_GRANT_START_V1: ApiTokenGrantV1 = Object.freeze({
    ...API_TOKEN_FULL_GRANT_V1,
    actions: Object.freeze({ families: [], ids: [] }),
});

export type ApiTokenGrantDraftIssue = 'actions_required' | 'automations_required' | 'targets_required' | 'models_required';

/** What still blocks sending the grant, in editor order. Empty means the protocol accepts it. */
export function resolveApiTokenGrantDraftIssues(grant: ApiTokenGrantV1): readonly ApiTokenGrantDraftIssue[] {
    const issues: ApiTokenGrantDraftIssue[] = [];
    if (grant.actions && grant.actions.families.length === 0 && grant.actions.ids.length === 0) issues.push('actions_required');
    if (grant.automationIds && grant.automationIds.length === 0) issues.push('automations_required');
    if (grant.targets && grant.targets.sessions.length === 0 && grant.targets.machines.length === 0 && !grant.targets.environments?.length) issues.push('targets_required');
    if (grant.models && grant.models.length === 0) issues.push('models_required');
    return issues;
}

/** The one validity decision: the protocol schema the Home also applies. */
export function isApiTokenGrantDraftSendable(grant: ApiTokenGrantV1): boolean {
    return ApiTokenGrantV1Schema.safeParse(grant).success;
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export type ApiTokenGrantOriginInputResult =
    | Readonly<{ ok: true; origin: string }>
    | Readonly<{ ok: false; reason: 'empty' | 'invalid' | 'duplicate' }>;

/**
 * Reads a website a person typed into the origin the grant stores. A bare host means HTTPS (HTTP for
 * loopback, where local development servers live); anything after the host is dropped because
 * browsers send only the origin. The protocol origin schema is the only acceptance rule.
 */
export function readApiTokenGrantOriginInput(input: string, existing: readonly string[]): ApiTokenGrantOriginInputResult {
    const trimmed = input.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `${LOOPBACK_HOST.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
    let origin: string;
    try {
        origin = new URL(withScheme).origin;
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    if (!ApiTokenGrantOriginV1Schema.safeParse(origin).success) return { ok: false, reason: 'invalid' };
    if (existing.includes(origin)) return { ok: false, reason: 'duplicate' };
    return { ok: true, origin };
}

function toggle<T>(list: readonly T[], item: T, key: (value: T) => string = String): T[] {
    const itemKey = key(item);
    return list.some((entry) => key(entry) === itemKey)
        ? list.filter((entry) => key(entry) !== itemKey)
        : [...list, item];
}

export function setApiTokenGrantAllActions(grant: ApiTokenGrantV1, all: boolean): ApiTokenGrantV1 {
    if (all === (grant.actions === null)) return grant;
    return { ...grant, actions: all ? null : { families: [], ids: [] } };
}

export function toggleApiTokenGrantFamily(grant: ApiTokenGrantV1, family: ActionIdFamilyV1): ApiTokenGrantV1 {
    const actions = grant.actions ?? { families: [], ids: [] };
    return { ...grant, actions: { ...actions, families: toggle(actions.families, family) } };
}

export function toggleApiTokenGrantActionId(grant: ApiTokenGrantV1, actionId: string): ApiTokenGrantV1 {
    const actions = grant.actions ?? { families: [], ids: [] };
    return { ...grant, actions: { ...actions, ids: toggle(actions.ids, actionId) } };
}

export function setApiTokenGrantAllTargets(grant: ApiTokenGrantV1, all: boolean): ApiTokenGrantV1 {
    if (all === (grant.targets === null)) return grant;
    return { ...grant, targets: all ? null : { sessions: [], machines: [] } };
}

export function toggleApiTokenGrantTarget(
    grant: ApiTokenGrantV1,
    target: Readonly<
        | { kind: 'session'; sessionId: string }
        | { kind: 'machine'; machineId: string }
        | { kind: 'environment'; environmentId: string }
    >,
): ApiTokenGrantV1 {
    const targets = grant.targets ?? { sessions: [], machines: [] };
    return {
        ...grant,
        targets: target.kind === 'session'
            ? { ...targets, sessions: toggle(targets.sessions, target.sessionId) }
            : target.kind === 'machine'
                ? { ...targets, machines: toggle(targets.machines, target.machineId) }
                : { ...targets, environments: toggle(targets.environments ?? [], target.environmentId) },
    };
}

export function apiTokenGrantModelKey(ref: ProviderBoundModelRef): string {
    return JSON.stringify([ref.agentTargetKey, ref.providerConnectionId, ref.modelId]);
}

export function setApiTokenGrantAnyModel(grant: ApiTokenGrantV1, any: boolean): ApiTokenGrantV1 {
    if (any === (grant.models === null)) return grant;
    return { ...grant, models: any ? null : [] };
}

export function toggleApiTokenGrantModel(grant: ApiTokenGrantV1, ref: ProviderBoundModelRef): ApiTokenGrantV1 {
    return { ...grant, models: toggle(grant.models ?? [], ref, apiTokenGrantModelKey) };
}

/** The Action whose operand the Automation restriction narrows. */
export const API_TOKEN_GRANT_RUN_NOW_ACTION_ID = 'workflow.trigger.run_now';

/**
 * The Automation choice belongs beside the actions while the token can run an Automation now, and
 * stays while a restriction exists so a person can see and remove it.
 */
export function apiTokenGrantOffersAutomations(grant: ApiTokenGrantV1): boolean {
    return grant.automationIds != null || isApiTokenGrantActionAllowedV1(grant, API_TOKEN_GRANT_RUN_NOW_ACTION_ID);
}

export function setApiTokenGrantAnyAutomation(grant: ApiTokenGrantV1, any: boolean): ApiTokenGrantV1 {
    if (any === (grant.automationIds == null)) return grant;
    return { ...grant, automationIds: any ? null : [] };
}

export function toggleApiTokenGrantAutomation(grant: ApiTokenGrantV1, automationId: string): ApiTokenGrantV1 {
    return { ...grant, automationIds: toggle(grant.automationIds ?? [], automationId) };
}

/** The saved deployment choice: Automatic, or Ask (the field absent). The protocol decides where Automatic is valid. */
export function setApiTokenGrantDeployApproval(grant: ApiTokenGrantV1, approval: 'automatic' | 'ask'): ApiTokenGrantV1 {
    if (approval === 'automatic') return grant.deployApproval === 'automatic' ? grant : { ...grant, deployApproval: 'automatic' };
    if (grant.deployApproval === undefined) return grant;
    const { deployApproval: _cleared, ...ask } = grant;
    return ask;
}

/**
 * The editor's one coherence step after any edit: Automatic deployment belongs only to the exact
 * single-Environment deployment grant (the protocol's own predicate). An edit that widens the grant
 * returns it with Ask and `cleared`, so the editor says so in place instead of leaving an unsendable
 * draft or dropping the choice silently.
 */
export function reconcileApiTokenGrantDeployApproval(grant: ApiTokenGrantV1): Readonly<{ grant: ApiTokenGrantV1; cleared: boolean }> {
    if (grant.deployApproval !== 'automatic' || isApiTokenDeploymentGrantV1(grant)) return { grant, cleared: false };
    return { grant: setApiTokenGrantDeployApproval(grant, 'ask'), cleared: true };
}

export function setApiTokenGrantApprove(grant: ApiTokenGrantV1, approve: boolean): ApiTokenGrantV1 {
    return grant.approve === approve ? grant : { ...grant, approve };
}

export function addApiTokenGrantOrigin(grant: ApiTokenGrantV1, origin: string): ApiTokenGrantV1 {
    return grant.origins.includes(origin) ? grant : { ...grant, origins: [...grant.origins, origin] };
}

export function removeApiTokenGrantOrigin(grant: ApiTokenGrantV1, origin: string): ApiTokenGrantV1 {
    return grant.origins.includes(origin) ? { ...grant, origins: grant.origins.filter((entry) => entry !== origin) } : grant;
}

/** Structural equality over the fields a person can change, so Save knows whether anything did. */
export function areApiTokenGrantsEqual(left: ApiTokenGrantV1, right: ApiTokenGrantV1): boolean {
    return JSON.stringify(canonicalGrant(left)) === JSON.stringify(canonicalGrant(right));
}

function canonicalGrant(grant: ApiTokenGrantV1) {
    const sorted = (values: readonly string[]) => [...values].sort();
    return {
        ...grant,
        actions: grant.actions ? { families: sorted(grant.actions.families), ids: sorted(grant.actions.ids) } : null,
        targets: grant.targets ? { sessions: sorted(grant.targets.sessions), machines: sorted(grant.targets.machines), environments: sorted(grant.targets.environments ?? []) } : null,
        origins: sorted(grant.origins),
        models: grant.models ? sorted(grant.models.map(apiTokenGrantModelKey)) : null,
        automationIds: grant.automationIds ? sorted(grant.automationIds) : null,
        permissionModes: grant.permissionModes ? sorted(grant.permissionModes) : null,
    };
}
