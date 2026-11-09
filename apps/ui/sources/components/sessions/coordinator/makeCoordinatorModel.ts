import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';
import type { SessionCoordinatorEffectV1, SessionCoordinatorEnableInputV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorActionsV1';
import {
    prepareSessionCoordinatorSetupV1,
    type SessionCoordinatorCreationDefaultsV1,
    type SessionCoordinatorRuleCensusV1,
} from '@happier-dev/protocol/sessions/follow/sessionCoordinatorSetupV1';
import type { FollowRulePreviewResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveCoordinatorKeepDefault } from '@happier-dev/protocol/account/settings/accountSettings';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';

type RuleSuggestion =
    SessionCoordinatorEnableInputV1['ruleSuggestions'][number];
export type MakeCoordinatorKeep = SessionCoordinatorEnableInputV1['keep'];

export type MakeCoordinatorRuleDraft = Readonly<{
    scope: 'project' | 'home';
    suggestion: RuleSuggestion;
    enabled: boolean;
}>;

export type MakeCoordinatorDraft = Readonly<{
    project: QualifiedProjectKeyV1 | null;
    /** Captured private inference authority, retained through retirement for this dialog opening. */
    projectInferenceScope: ServerAccountScope | null;
    projectCensusScope: ServerAccountScope | null;
    roleId: string;
    keep: MakeCoordinatorKeep;
    /** True while the place is still the one the Settings default resolved to (the dialog says "From your setting"). */
    keepFromSetting: boolean;
    keepPreference: SessionCoordinatorCreationDefaultsV1['coordinationCoordinatorKeep'];
    managedBySessionId: string | null;
    answersWorkerQuestions: boolean;
    rules: readonly MakeCoordinatorRuleDraft[];
}>;

/**
 * The dialog's starting choices (C1 §6, lab P3 M/M2/M1): the project rule first and on, the Home-wide rule
 * second and off (on when the session has no project); the place the Settings default resolves to for that
 * scope; Managed by only when exactly one other session follows Home-wide. Protocol owns every suggestion.
 */
export function buildMakeCoordinatorDraft(
    input: Readonly<{
        serverId: string;
        sessionId: string;
        ownerMetadata: Readonly<Record<string, unknown>> | null;
        projectKey?: string | null;
        workspaceRefs?: readonly WorkspaceRefV1[];
        workspaceRefsScope?: ServerAccountScope | null;
        sessionAuthority?: Pick<Session, 'ownerAccountId' | 'access' | 'accessLevel'>;
        settings: SessionCoordinatorCreationDefaultsV1;
        ruleIds: Readonly<{ project: string; home: string }>;
        ruleCensus: SessionCoordinatorRuleCensusV1 | null;
    }>,
): MakeCoordinatorDraft {
    const census = admitProjectWorkspaceCensusForSubject({
        subject: { kind: 'session', ...input.sessionAuthority }, rowServerId: input.serverId,
        censusServerId: input.workspaceRefsScope?.serverId, viewerAccountId: input.workspaceRefsScope?.accountId,
        workspaceRefs: input.workspaceRefs,
    });
    const association = resolveSessionProjectKeyV1(input.ownerMetadata, input.serverId, census.workspaceRefs,
        { ...workspaceRefResolutionContextV1(), projectKey: input.projectKey });
    const project = association.kind === 'resolved' ? association.projectKey : null;
    const scope = project ? 'project' : 'home';
    // Both suggestions are prepared so the person can turn either on; the Settings switches decide which appear.
    const setup = prepareSessionCoordinatorSetupV1({
        serverId: input.serverId,
        sessionId: input.sessionId,
        scope,
        project,
        settings: {
            ...input.settings,
            coordinationCoordinatorSuggestHomeRule: true,
            coordinationCoordinatorSuggestProjectRule: project !== null,
        },
        ruleIds: input.ruleIds,
        ruleCensus: input.ruleCensus,
    });
    const rules: MakeCoordinatorRuleDraft[] = setup.ruleSuggestions.flatMap(
        (suggestion): MakeCoordinatorRuleDraft[] => {
            const ruleScope =
                suggestion.source.ruleId === input.ruleIds.project ? 'project' : 'home';
            const offered =
                ruleScope === 'project'
                    ? input.settings.coordinationCoordinatorSuggestProjectRule
                    : input.settings.coordinationCoordinatorSuggestHomeRule ||
                        scope === 'home';
            return offered
                ? [{ scope: ruleScope, suggestion, enabled: ruleScope === scope }]
                : [];
        },
    );
    return {
        project,
        projectInferenceScope: association.kind === 'resolved' && association.ref ? input.workspaceRefsScope ?? null : null,
        projectCensusScope: census.admitted ? input.workspaceRefsScope ?? null : null,
        roleId: setup.roleId,
        keep: setup.keep,
        keepFromSetting: true,
        keepPreference: setup.keepPreference,
        managedBySessionId: setup.managedBySessionId,
        answersWorkerQuestions: setup.answersWorkerQuestions,
        rules,
    };
}

/** Reconcile before rendering or submitting, not only after a revoked rule has committed. */
export function reconcileMakeCoordinatorProjectDraft(
    current: MakeCoordinatorDraft,
    prepared: MakeCoordinatorDraft,
    rulesChosen: boolean,
): MakeCoordinatorDraft {
    if (current.projectInferenceScope
        && !areServerAccountScopesEqual(current.projectInferenceScope, prepared.projectCensusScope)) {
        const project = prepared.projectInferenceScope ? null : prepared.project;
        if (!project && !current.project && !current.rules.some(rule => rule.scope === 'project')
            && (current.projectCensusScope === prepared.projectCensusScope
                || areServerAccountScopesEqual(current.projectCensusScope, prepared.projectCensusScope))) return current;
        const rules = prepared.rules.filter(rule => rule.scope !== 'project' || project !== null).map(rule => ({ ...rule,
            enabled: current.rules.find(previous => previous.scope === rule.scope)?.enabled ?? false }));
        return { ...current, project,
            // Retain the inference's original authority through retirement.
            projectInferenceScope: project ? prepared.projectInferenceScope : current.projectInferenceScope,
            projectCensusScope: prepared.projectCensusScope, rules };
    }
    if (current.project || !prepared.project) return current;
    const rules = rulesChosen ? prepared.rules.map(rule => ({ ...rule,
        enabled: current.rules.find(previous => previous.scope === rule.scope)?.enabled ?? false })) : prepared.rules;
    const homeWide = rules.some(rule => rule.scope === 'home' && rule.enabled);
    return { ...current, project: prepared.project,
        projectInferenceScope: prepared.projectInferenceScope,
        projectCensusScope: prepared.projectCensusScope, rules,
        keep: current.keepFromSetting ? resolveCoordinatorKeepDefault(current.keepPreference, homeWide ? 'home' : 'project') : current.keep };
}

/** Turning a rule on or off re-resolves the place while it still follows the Settings default. */
export function toggleMakeCoordinatorRule(
    draft: MakeCoordinatorDraft,
    scope: 'project' | 'home',
    enabled: boolean,
): MakeCoordinatorDraft {
    const rules = draft.rules.map((rule) =>
        rule.scope === scope ? { ...rule, enabled } : rule,
    );
    if (!draft.keepFromSetting) return { ...draft, rules };
    const homeWide = rules.some((rule) => rule.scope === 'home' && rule.enabled);
    return {
        ...draft,
        rules,
        keep: resolveCoordinatorKeepDefault(
            draft.keepPreference,
            homeWide ? 'home' : 'project',
        ),
    };
}

export function buildMakeCoordinatorEnableInput(
    draft: MakeCoordinatorDraft,
    current: Readonly<{ currentManagerSessionId: string | null }>,
): Omit<SessionCoordinatorEnableInputV1, 'sessionId'> {
    return {
        roleId: draft.roleId,
        keep: draft.keep,
        answersWorkerQuestions: draft.answersWorkerQuestions,
        ruleSuggestions: draft.rules
            .filter((rule) => rule.enabled)
            .map((rule) => rule.suggestion),
        ...(draft.managedBySessionId !== current.currentManagerSessionId
            ? {
                    managedBy: {
                        managerSessionId: draft.managedBySessionId,
                        expectedManagerSessionId: current.currentManagerSessionId,
                    },
                }
            : {}),
    };
}

/** Keep Follow's accepted CAS revision in the existing draft when another setup step needs Retry. */
export function applyMakeCoordinatorEffectsToDraft(
    draft: MakeCoordinatorDraft,
    effects: readonly SessionCoordinatorEffectV1[],
): MakeCoordinatorDraft {
    const rules = draft.rules.map(rule => {
        const accepted = effects.find(effect => effect.operation === 'rule' && effect.ruleId === rule.suggestion.source.ruleId
            && effect.status === 'accepted');
        if (accepted?.status !== 'accepted' || accepted.version === undefined
            || accepted.version === rule.suggestion.expectedVersion) return rule;
        return { ...rule, suggestion: { ...rule.suggestion, expectedVersion: accepted.version } };
    });
    return rules.every((rule, index) => rule === draft.rules[index]) ? draft : { ...draft, rules };
}

export type MakeCoordinatorOutcome = Readonly<{
    done: boolean;
    approvalPending: boolean;
    /** The typed code of a refused Role step, so the dialog can explain it and keep the rest as done. */
    roleRefusalCode: string | null;
    /** Unfinished steps other than the refused Role. */
    otherUnfinished: number;
}>;

/** What one `session.coordinator.enable` result leaves for the person: finished, waiting on approval, or a held Role. */
export function readMakeCoordinatorOutcome(effects: readonly SessionCoordinatorEffectV1[]): MakeCoordinatorOutcome {
    const unfinished = effects.filter((effect) => effect.status !== 'accepted');
    const roleRefusal = unfinished.find((effect) => effect.operation === 'role' && effect.status === 'failed');
    return {
        done: unfinished.length === 0,
        approvalPending: unfinished.some((effect) => effect.status === 'approval_required'),
        roleRefusalCode: roleRefusal?.status === 'failed' ? roleRefusal.errorCode : null,
        otherUnfinished: unfinished.length - (roleRefusal ? 1 : 0),
    };
}

export type MakeCoordinatorOverlap = Readonly<{
    rule: OpenedSessionFollowRuleV1;
    receiverSessionId: string;
    count: number;
}>;

/** Which other sessions' rules already hear about the sessions this rule would match, and how many. */
export function describeMakeCoordinatorOverlap(
    input: Readonly<{
        sessionId: string;
        census: SessionCoordinatorRuleCensusV1 | null;
        overlaps: FollowRulePreviewResultV1['overlaps'];
    }>,
): readonly MakeCoordinatorOverlap[] {
    if (!input.census || input.census.coverage !== 'complete') return [];
    const byId = new Map(input.census.rules.map((rule) => [rule.ruleId, rule]));
    return input.overlaps.flatMap((overlap) => {
        const rule = byId.get(overlap.ruleId);
        if (
            !rule ||
            rule.receiver.kind !== 'session' ||
            rule.receiver.sessionId === input.sessionId ||
            overlap.matches.length === 0
        )
            return [];
        return [
            {
                rule,
                receiverSessionId: rule.receiver.sessionId,
                count: overlap.matches.length,
            },
        ];
    });
}
