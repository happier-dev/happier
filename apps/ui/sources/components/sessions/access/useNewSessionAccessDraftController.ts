import * as React from 'react';
import type { PrincipalRefV1} from '@happier-dev/protocol/teams/principal';
import type { SessionAccessCreationDecisionV1, SessionAccessCreationRefusalV1, SessionAccessPrincipalSummaryV1} from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
// The workspace's router: a hosted pane (the Session's Share) navigates through its destination owner.
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';

import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { buildNewSessionDraftContinueRoute } from '@/components/sessions/drafts/newSessionDraftNavigation';
import { useNewSessionHostNavigation, useNewSessionHostParams } from '@/components/sessions/new/navigation/newSessionHost';
import { presentTeamSignInRequired } from '@/components/teams/entry/teamSignInRequirement';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { useTeamGroupNameProjectionDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { getTempData, storeTempData } from '@/utils/sessions/tempDataStore';

import { useSessionAccessTeamNames } from './useSessionAccessTeamNames';
import { projectSessionAccessChipSummary } from './projectSessionAccessChipSummary';
import { projectSessionAccessPrincipal } from './projectSessionAccessEditorSnapshot';
import { projectSessionAccessContextChange } from './projectSessionAccessContextChange';
import { sessionAccessGrantMutation } from './sessionAccessGrantMutation';
import { projectSessionAccessDelegationControl, sessionAccessSubjectKey } from './projectSessionAccessEditorSnapshot';
import { resolveSessionAccessCreationDecision, resolveSessionAccessPrincipals } from '@/sync/api/session/sessionAccessApi';
import { useSessionAccessDirectory, type SessionAccessDirectoryTeamContext } from './useSessionAccessDirectory';
import { createSessionAccessQuery } from './sessionAccessQuery';
import type {
    SessionAccessEditorActions,
    SessionAccessEditorController,
    SessionAccessGrantRowModel,
    SessionAccessLevel,
    SessionAccessPrincipalPresentation,
} from './sessionAccessEditorTypes';

const ACCESS_LEVEL_OPTIONS: readonly SessionAccessLevel[] = ['view', 'edit', 'admin'];

type TeamSignInIntent = Readonly<{
    kind: 'newSessionTeamSignIn';
    draftId: string;
    draftScope: ServerAccountScope;
    scope: ServerAccountScope;
    teamId: string;
}>;

function principalKindLabel(subject: PrincipalRefV1): string {
    return subject.kind === 'account' ? t('session.access.account')
        : subject.kind === 'team' ? t('session.access.team') : t('session.access.group');
}

function fallbackPrincipal(subject: PrincipalRefV1): SessionAccessPrincipalPresentation {
    const identifier = subject.kind === 'account' ? subject.accountId : subject.kind === 'team' ? subject.teamId : `${subject.teamId}/${subject.groupId}`;
    const label = `${principalKindLabel(subject)} · ${identifier}`;
    return { ref: subject, key: sessionAccessSubjectKey(subject), displayName: label, accessibilityLabel: label };
}

function projectCreationDecisionPolicy(decision: SessionAccessCreationDecisionV1): SessionAccessDirectoryTeamContext {
    return {
        teamId: decision.teamId,
        name: decision.teamName,
        sessionCreationPolicy: decision.requiredByPolicy ? 'team_required' : decision.defaultGrant ? 'team_default' : 'private_default',
        externalSharingPolicy: decision.externalSharingPolicy,
    };
}

/**
 * The New Session access draft, edited entirely in the synchronized creation
 * document.
 *
 * It shares the exact editor component, row projector and directory sources
 * with the live controller and differs only in where a change lands: a draft
 * row is local, so adding, changing and removing are immediate and need no
 * acknowledgement, and the value travels to the server once — as the canonical
 * `initialAccess` of the fresh-create transaction. It issues no grant mutation,
 * writes no Follow, read or notification state, and applies no Team policy: the
 * creating transaction revalidates every subject, level and delegation.
 */
export function useNewSessionAccessDraftController(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    draftScope: ServerAccountScope | null;
    access: SessionInitialAccessDraftV1 | null;
    primaryTeamId: string | null;
    availability: SessionCollaborationAvailability;
    homeReconciled?: boolean;
    /**
     * Whether a mounted editor presentation is actually demanding candidate
     * discovery. The composer keeps this controller mounted for its chip label,
     * which is projected from authored grants alone; the Home directory is
     * detail work and must not start until the editor is open.
     */
    demanded: boolean;
    onChange: (next: SessionInitialAccessDraftV1 | null) => void;
    onPrimaryTeamIdChange: (next: string | null) => void;
}>): SessionAccessEditorController & Readonly<{ placementPending: boolean }> {
    const { access, availability, demanded, draftId, draftScope, onChange, onPrimaryTeamIdChange, primaryTeamId, scope } = input;
    const { teamSignInIntentId } = useNewSessionHostParams<{ teamSignInIntentId?: string }>();
    const { router: hostRouter } = useNewSessionHostNavigation();
    const draftServerId = draftScope?.serverId;
    const draftAccountId = draftScope?.accountId;
    const teamSignInOrigin = React.useMemo(() => {
        if (!draftServerId || !draftAccountId) {
            return { pathname: '/new', search: new URLSearchParams({ draftId }).toString() };
        }
        const { pathname, params } = buildNewSessionDraftContinueRoute(draftId, { serverId: draftServerId, accountId: draftAccountId });
        return { pathname, search: new URLSearchParams({ ...params, spawnServerId: scope.serverId }).toString() };
    }, [draftId, draftServerId, draftAccountId, scope.serverId]);
    const viewerProfile = useShareViewerProfile(scope);
    const [query] = React.useState(createSessionAccessQuery);
    const setQuery = query.write;
    const [revision, setRevision] = React.useState(0);
    const [pendingContextTeamId, setPendingContextTeamId] = React.useState<string | null | undefined>(undefined);
    const [explainedReason, setExplainedReason] = React.useState<Readonly<{ code: string; message: string }> | null>(null);
    const [creationOutcome, setCreationDecision] = React.useState<SessionAccessCreationDecisionV1 | SessionAccessCreationRefusalV1 | null | undefined>(undefined);
    // The Home refuses a Team whose sign-in rule the current sign-in does not meet with a typed refusal, for the
    // restored context and for a Team the person just chose; either is said once, with the step that meets it.
    const creationRefusal = creationOutcome && 'code' in creationOutcome ? creationOutcome : null;
    const creationDecision = creationRefusal ? null : creationOutcome as SessionAccessCreationDecisionV1 | null | undefined;
    const [contextRefusal, setContextRefusal] = React.useState<SessionAccessCreationRefusalV1 | null>(null);
    const signInRefusal = contextRefusal ?? creationRefusal;
    // Read at press time: navigation is not an input of the projected reason.
    const router = useRouter();
    const routerRef = React.useRef(router);
    routerRef.current = router;
    const [pendingContextDecision, setPendingContextDecision] = React.useState<Readonly<{ teamId: string; retry: number }> | null>(null);
    const [pendingContextTarget, setPendingContextTarget] = React.useState<SessionAccessDirectoryTeamContext | null>(null);
    const [contextDecisionError, setContextDecisionError] = React.useState(false);
    // Candidate names serve accounts and Groups; Team names remain live in the
    // existing qualified Team owner, including after restoring a draft.
    const scopeKey = JSON.stringify([scope.serverId, scope.accountId]);
    const [resolvedPrincipals, setResolvedPrincipals] = React.useState<Readonly<{
        scopeKey: string;
        values: Readonly<Record<string, SessionAccessPrincipalSummaryV1>>;
    }>>({ scopeKey, values: {} });
    const resolved = resolvedPrincipals.scopeKey === scopeKey ? resolvedPrincipals.values : {};
    React.useEffect(() => {
        setPendingContextDecision(null);
        setPendingContextTarget(null);
        setContextDecisionError(false);
    }, [scopeKey]);
    const grants = React.useMemo(() => access?.grants ?? [], [access]);
    const subjects = React.useMemo(() => grants.map(grant => grant.subject), [grants]);
    const teamNames = useSessionAccessTeamNames(scope, subjects);
    const groupLabelInputs = React.useMemo(() => Object.values(resolved).flatMap((principal) =>
        principal.kind === 'group' ? [{ id: principal.groupId, name: principal.name }] : []), [resolved]);
    const openedGroupDisplayNames = useTeamGroupNameProjectionDisplayNames({ scope, groups: groupLabelInputs });
    const names = React.useMemo<Readonly<Record<string, SessionAccessPrincipalPresentation>>>(() => {
        const next: Record<string, SessionAccessPrincipalPresentation> = {};
        for (const principal of Object.values(resolved)) {
            const projected = projectSessionAccessPrincipal(
                principal,
                { accountId: scope.accountId, profile: viewerProfile },
                principal.kind === 'group' ? openedGroupDisplayNames.get(principal.groupId) : undefined,
            );
            next[projected.key] = projected;
        }
        return next;
    }, [openedGroupDisplayNames, resolved, scope.accountId, viewerProfile]);
    const grantsRef = React.useRef(grants);
    grantsRef.current = grants;

    // A creation access draft is carried atomically by the fresh-create
    // transaction wherever the target Home shares Sessions at all.
    const editable = availability === 'available';

    const publish = React.useCallback((next: readonly SessionInitialAccessDraftV1['grants'][number][]) => {
        onChange(next.length === 0 ? null : { grants: [...next] });
    }, [onChange]);

    const contextTeams = React.useMemo<readonly SessionAccessDirectoryTeamContext[]>(() => grants
        .filter((grant) => grant.subject.kind === 'team')
        .map((grant) => ({ teamId: grant.subject.kind === 'team' ? grant.subject.teamId : '', name: teamNames.get(grant.subject.kind === 'team' ? grant.subject.teamId : '') ?? names[sessionAccessSubjectKey(grant.subject)]?.displayName ?? t('session.access.team') })), [grants, names, teamNames]);

    // Candidate discovery is editor detail and waits for an open presentation.
    // The primary Team's creation decision comes from the server-owned create
    // contract; it must not cause the detailed directory to mount in the chip.
    const directory = useSessionAccessDirectory({
        scope, availability, contextTeams, operations: {}, revision,
        teamSignInOrigin,
        enabled: editable && demanded,
    });
    const creationDecisionRevision = React.useRef(0);
    const creationDecisionCache = React.useRef<Readonly<{
        key: string;
        value?: SessionAccessCreationDecisionV1 | SessionAccessCreationRefusalV1 | null;
        pending?: Promise<SessionAccessCreationDecisionV1 | SessionAccessCreationRefusalV1 | null>;
    }> | null>(null);
    const [creationDecisionRetryRevision, setCreationDecisionRetryRevision] = React.useState(0);
    React.useEffect(() => {
        if (!editable || primaryTeamId === null) {
            creationDecisionRevision.current += 1;
            creationDecisionCache.current = null;
            setCreationDecision(undefined);
            return;
        }
        const requestKey = JSON.stringify([scope.serverId, scope.accountId, primaryTeamId, creationDecisionRetryRevision]);
        const cached = creationDecisionCache.current;
        if (cached?.key === requestKey && cached.value !== undefined) {
            setCreationDecision(cached.value);
            return;
        }
        const revision = ++creationDecisionRevision.current;
        let active = true;
        setCreationDecision(undefined);
        const pending = cached?.key === requestKey && cached.pending
            ? cached.pending
            : resolveSessionAccessCreationDecision({
                scope, availability, teamId: primaryTeamId,
                // The request is shared across StrictMode replays. Effect
                // liveness is checked by each consumer below; this predicate
                // only cancels the shared request when its scope/retry key is
                // no longer the active cache entry.
                isCurrent: () => creationDecisionCache.current?.key === requestKey,
            }).then((decision) => {
                if (creationDecisionCache.current?.key === requestKey) {
                    creationDecisionCache.current = { key: requestKey, value: decision };
                }
                return decision;
            }).catch(() => {
                if (creationDecisionCache.current?.key === requestKey) {
                    creationDecisionCache.current = { key: requestKey, value: null };
                }
                return null;
            });
        if (creationDecisionCache.current?.key !== requestKey || creationDecisionCache.current.pending !== pending) {
            creationDecisionCache.current = { key: requestKey, pending };
        }
        void pending.then((decision) => {
            if (active && creationDecisionRevision.current === revision) setCreationDecision(decision);
        });
        return () => { active = false; };
    }, [availability, editable, primaryTeamId, creationDecisionRetryRevision, scope.accountId, scope.serverId]);
    const selectedSubjectsKey = React.useMemo(() => JSON.stringify(grants.map((grant) => grant.subject)), [grants]);
    const resolveRevision = React.useRef(0);
    React.useEffect(() => {
        setResolvedPrincipals((current) => current.scopeKey === scopeKey ? current : { scopeKey, values: {} });
        if (!editable || !demanded || grants.length === 0) return;
        const requestRevision = ++resolveRevision.current;
        let active = true;
        void resolveSessionAccessPrincipals({
            scope, availability, subjects: grants.map((grant) => grant.subject),
            isCurrent: () => active && resolveRevision.current === requestRevision,
        }).then((principals) => {
            if (!active || resolveRevision.current !== requestRevision) return;
            setResolvedPrincipals((current) => {
                const base = current.scopeKey === scopeKey ? current.values : {};
                const next = { ...base };
                for (const principal of principals) {
                    next[sessionAccessSubjectKey(principal)] = principal;
                }
                return { scopeKey, values: next };
            });
        }).catch(() => {});
        return () => { active = false; };
    }, [availability, demanded, editable, grants, scope.accountId, scope.serverId, scopeKey, selectedSubjectsKey]);
    const directoryTeamsRef = React.useRef(directory.teamContexts);
    directoryTeamsRef.current = directory.teamContexts;
    const primaryTeamDecisionPolicy = creationDecision === undefined || creationDecision === null
        ? null
        : projectCreationDecisionPolicy(creationDecision);
    // Directory rows are presentation and discovery only. Creation policy is
    // authoritative only when the selected-Home server has returned its typed
    // decision; a missing decision must never be inferred from a cached row.
    const primaryTeamPolicy = primaryTeamDecisionPolicy;
    const primaryTeamPolicyUnavailable = primaryTeamId !== null && creationDecision !== undefined && creationDecision === null
        && creationRefusal === null && primaryTeamPolicy === null;
    const signInReason = React.useMemo(() => signInRefusal ? presentTeamSignInRequired({
        code: signInRefusal.code, teamId: signInRefusal.teamId, serverId: scope.serverId,
        accepted: signInRefusal.accepted,
        origin: () => {
            if (!contextRefusal || !draftServerId || !draftAccountId) return teamSignInOrigin;
            // A return URL can reopen a draft. Only a choice made in that draft may change its Team.
            const intentId = storeTempData({
                kind: 'newSessionTeamSignIn', draftId,
                draftScope: { serverId: draftServerId, accountId: draftAccountId },
                scope: { serverId: scope.serverId, accountId: scope.accountId },
                teamId: contextRefusal.teamId,
            } satisfies TeamSignInIntent);
            const query = new URLSearchParams(teamSignInOrigin.search);
            query.set('teamSignInIntentId', intentId);
            return { pathname: teamSignInOrigin.pathname, search: query.toString() };
        },
        navigate: (href) => routerRef.current.push(href as Href),
    }) : null, [contextRefusal, draftId, draftServerId, draftAccountId, scope.serverId, scope.accountId, signInRefusal, teamSignInOrigin]);
    // Signing in again on this Home is the natural boundary: the decision is read again then, not polled.
    React.useEffect(() => subscribeHomeCredentialChange((event) => {
        if (event.serverId !== scope.serverId) return;
        setContextRefusal(null);
        setCreationDecisionRetryRevision((value) => value + 1);
    }), [scope.serverId]);
    const primaryTeamDecisionPending = primaryTeamId !== null && creationDecision === undefined;

    const rows = React.useMemo<readonly SessionAccessGrantRowModel[]>(() => grants.map((grant) => {
        const key = sessionAccessSubjectKey(grant.subject);
        const requiredByTeamPolicy = grant.subject.kind === 'team'
            && grant.subject.teamId === primaryTeamId
            && primaryTeamPolicy?.sessionCreationPolicy === 'team_required';
        const teamName = grant.subject.kind === 'team' ? teamNames.get(grant.subject.teamId) : null;
        const principal = grant.subject.kind === 'team' && teamName
            ? projectSessionAccessPrincipal({ kind: 'team', teamId: grant.subject.teamId, name: teamName })
            : names[key] ?? fallbackPrincipal(grant.subject);
        return {
            grant: grant.subject,
            principal,
            level: editable
                ? { kind: 'editable', value: grant.accessLevel, options: ACCESS_LEVEL_OPTIONS
                    .filter((value) => !requiredByTeamPolicy || value !== 'view') }
                : { kind: 'locked', value: grant.accessLevel, reason: { code: 'session_access_sharing_unavailable', message: t('session.collaboration.accessUnavailableReason') } },
            permissionDelegation: projectSessionAccessDelegationControl({
                accessLevel: grant.accessLevel,
                canApprovePermissions: grant.canApprovePermissions,
                canChange: editable,
                reason: { code: 'session_access_sharing_unavailable', message: t('session.collaboration.accessUnavailableReason') },
            }),
            removal: requiredByTeamPolicy
                ? { kind: 'blocked', reason: { code: 'session_access_team_policy_required', message: t('session.access.required') } }
                : editable
                ? { kind: 'allowed' }
                : { kind: 'blocked', reason: { code: 'session_access_sharing_unavailable', message: t('session.collaboration.accessUnavailableReason') } },
            requiredByTeamPolicy,
            operation: { kind: 'idle' },
        };
    }), [editable, grants, names, teamNames, primaryTeamId, primaryTeamPolicy?.sessionCreationPolicy]);

    const replace = React.useCallback((subject: PrincipalRefV1, next: SessionInitialAccessDraftV1['grants'][number] | null) => {
        if (!editable) return;
        if (subject.kind === 'team' && subject.teamId === primaryTeamId
            && primaryTeamPolicy?.sessionCreationPolicy === 'team_required'
            && (next === null || next.accessLevel === 'view')) return;
        const key = sessionAccessSubjectKey(subject);
        const current = grantsRef.current;
        const index = current.findIndex((grant) => sessionAccessSubjectKey(grant.subject) === key);
        if (next === null) {
            if (index < 0) return;
            publish(current.filter((_, position) => position !== index));
            return;
        }
        publish(index < 0 ? [...current, next] : current.map((grant, position) => (position === index ? next : grant)));
    }, [editable, primaryTeamId, primaryTeamPolicy?.sessionCreationPolicy, publish]);

    /**
     * The one place a Team-policy floor is derived, for every route into a Team
     * context: a reviewed context change, a restored draft, and the Team
     * credential's visibility requirement all land here instead of seeding their
     * own grant at their own level.
     *
     * Both Team-context policies start from the same collaborative V1 proposal —
     * Edit with no delegation. Only `team_required` is enforced whenever its
     * policy is known; `team_default` merely proposes its row when this editor
     * actually enters the context, so a later removal stays the creator's
     * explicit private override and survives normal draft restoration.
     */
    const enteredContextTeamId = React.useRef(primaryTeamId);
    const contextCreationPolicy = primaryTeamPolicy?.sessionCreationPolicy;
    React.useEffect(() => {
        const entering = enteredContextTeamId.current !== primaryTeamId;
        if (primaryTeamId === null) enteredContextTeamId.current = null;
        else if (contextCreationPolicy) enteredContextTeamId.current = primaryTeamId;
        if (!editable || primaryTeamId === null || primaryTeamDecisionPending) return;
        if (contextCreationPolicy !== 'team_required'
            && !(entering && contextCreationPolicy === 'team_default')) return;
        const subject = { kind: 'team' as const, teamId: primaryTeamId };
        const existing = grantsRef.current.find((grant) => sessionAccessSubjectKey(grant.subject) === sessionAccessSubjectKey(subject));
        if (existing && existing.accessLevel !== 'view') return;
        replace(subject, sessionAccessGrantMutation(subject, { accessLevel: 'edit', canApprovePermissions: false }));
    }, [contextCreationPolicy, editable, primaryTeamDecisionPending, primaryTeamId, replace]);

    const submitContext = React.useCallback((teamId: string | null, targetOverride?: SessionAccessDirectoryTeamContext | null) => {
        const target = teamId === null ? null
            : targetOverride ?? (teamId === primaryTeamId && primaryTeamPolicy
                ? primaryTeamPolicy
                : directoryTeamsRef.current.find((team) => team.teamId === teamId) ?? null);
        if (teamId !== null && (!target?.sessionCreationPolicy || !target.externalSharingPolicy)) return;
        onPrimaryTeamIdChange(teamId);
        setPendingContextTeamId(undefined);
        setPendingContextTarget(null);
        setContextDecisionError(false);
    }, [onPrimaryTeamIdChange, primaryTeamId, primaryTeamPolicy]);

    React.useEffect(() => {
        const request = pendingContextDecision;
        if (request === null) return;
        let active = true;
        void resolveSessionAccessCreationDecision({
            scope, availability, teamId: request.teamId,
            isCurrent: () => active,
        }).then((decision) => {
            if (!active) return;
            if (decision !== null && 'code' in decision) {
                setPendingContextDecision(null);
                setContextDecisionError(false);
                setContextRefusal(decision);
                return;
            }
            if (decision === null) {
                setContextDecisionError(true);
                setExplainedReason({ code: 'session_access_context_policy_unavailable', message: t('session.access.contextPolicyUnavailable') });
                return;
            }
            const target = projectCreationDecisionPolicy(decision);
            setPendingContextDecision(null);
            setContextDecisionError(false);
            const consequences = projectSessionAccessContextChange({
                target,
                current: primaryTeamPolicy,
                grants: grantsRef.current,
            });
            if (consequences.length > 0) {
                setPendingContextTarget(target);
                setPendingContextTeamId(request.teamId);
                return;
            }
            submitContext(request.teamId, target);
        }).catch(() => {
            if (!active) return;
            setContextDecisionError(true);
            setExplainedReason({ code: 'session_access_context_policy_unavailable', message: t('session.access.contextPolicyUnavailable') });
        });
        return () => { active = false; };
    }, [availability, pendingContextDecision, primaryTeamPolicy, scope.accountId, scope.serverId, submitContext]);

    const setContext = React.useCallback((teamId: string | null) => {
        if (!editable || primaryTeamId === teamId || (primaryTeamId !== null && (primaryTeamDecisionPending || primaryTeamPolicyUnavailable))) return;
        if (creationDecision?.requiredByPolicy === true) return;
        setContextRefusal(null);
        // A restored Team this sign-in cannot use leaves Private one press away.
        if (teamId === null && creationRefusal !== null) {
            submitContext(null);
            return;
        }
        if (teamId !== null && teamId !== primaryTeamId) {
            setContextDecisionError(false);
            setExplainedReason(null);
            setPendingContextDecision((current) => ({ teamId, retry: (current?.teamId === teamId ? current.retry : 0) + 1 }));
            return;
        }
        const target = teamId === null ? null : primaryTeamPolicy;
        if (teamId !== null && (!target?.sessionCreationPolicy || !target.externalSharingPolicy)) return;
        const current = primaryTeamId === null ? null : primaryTeamPolicy;
        if (primaryTeamId !== null && !current) return;
        const consequences = projectSessionAccessContextChange({ target, current, grants: grantsRef.current });
        if (consequences.length > 0) {
            setPendingContextTarget(target);
            setPendingContextTeamId(teamId);
            return;
        }
        submitContext(teamId, target);
    }, [creationDecision?.requiredByPolicy, creationRefusal, editable, primaryTeamDecisionPending, primaryTeamId, primaryTeamPolicy, primaryTeamPolicyUnavailable, submitContext]);

    React.useEffect(() => {
        if (typeof teamSignInIntentId !== 'string' || !editable || !scope.accountId || !draftScope
            || primaryTeamDecisionPending) return;
        const intent = getTempData<TeamSignInIntent>(teamSignInIntentId);
        hostRouter.setParams({ teamSignInIntentId: undefined });
        if (intent?.kind !== 'newSessionTeamSignIn' || intent.draftId !== draftId
            || !areServerAccountScopesEqual(intent.draftScope, draftScope)
            || !areServerAccountScopesEqual(intent.scope, scope)) return;
        setContext(intent.teamId);
    }, [draftId, draftScope, editable, hostRouter, primaryTeamDecisionPending, scope, setContext, teamSignInIntentId]);

    const actions = React.useMemo<SessionAccessEditorActions>(() => ({
        setQuery,
        retryContent: () => {
            setCreationDecisionRetryRevision((value) => value + 1);
            if (pendingContextDecision !== null) {
                setPendingContextDecision((current) => current === null ? current : { ...current, retry: current.retry + 1 });
            }
            setRevision((value) => value + 1);
        },
        retryDirectory: (kind) => { directory.retry(kind); setRevision((value) => value + 1); },
        loadMore: (kind) => directory.loadMore(kind),
        retryMutation: () => {},
        addPrincipal: (subject) => {
            // Candidate additions use the neutral direct-share default. A
            // primary-Team required floor is composed only by the reviewed
            // context transition below from that Team's server projection.
            replace(subject, sessionAccessGrantMutation(subject, { accessLevel: 'view', canApprovePermissions: false }));
            setQuery('');
        },
        setAccessLevel: (subject, level) => {
            const existing = grantsRef.current.find((grant) => sessionAccessSubjectKey(grant.subject) === sessionAccessSubjectKey(subject));
            if (!existing) return;
            replace(subject, sessionAccessGrantMutation(subject, { accessLevel: level, canApprovePermissions: level === 'view' ? false : existing.canApprovePermissions }));
        },
        setPermissionDelegation: (subject, enabled) => {
            const existing = grantsRef.current.find((grant) => sessionAccessSubjectKey(grant.subject) === sessionAccessSubjectKey(subject));
            if (!existing || existing.accessLevel === 'view') return;
            replace(subject, sessionAccessGrantMutation(subject, { accessLevel: existing.accessLevel, canApprovePermissions: enabled }));
        },
        // A draft principal has never been granted anything, so removing it is
        // immediate and confirmation would be ceremony without consequence.
        requestRemove: (subject) => replace(subject, null),
        confirmRemove: (subject) => replace(subject, null),
        cancelRemove: () => {},
        explain: setExplainedReason,
        setContext,
        confirmContext: () => { if (pendingContextTeamId !== undefined) submitContext(pendingContextTeamId, pendingContextTarget); },
        cancelContext: () => { setPendingContextTeamId(undefined); setPendingContextTarget(null); },
        clearAccess: () => {
            onChange(null);
            onPrimaryTeamIdChange(null);
        },
        // A draft has no committed audience yet: there is nothing to prepare or inspect
        // until the Session and its grants exist.
        prepareAccess: () => {},
        toggleAllRecipients: () => {},
        loadMoreRecipients: () => {},
    }), [directory, pendingContextDecision, pendingContextTarget, pendingContextTeamId, replace, setContext, submitContext]);

    // Candidate presentation is captured as it is chosen so the selected row
    // keeps its real name without a second identity lookup.
    const sections = React.useMemo(() => directory.sections.map((section) => ({
        ...section,
        ...(section.resolveCandidates ? {
            resolveCandidates: async (search: string, signal: AbortSignal) => {
                const candidates = await section.resolveCandidates!(search, signal);
                setResolvedPrincipals((current) => {
                    // Copy-on-first-change: unchanged names keep their identity so the
                    // rows around them are not rebuilt by a search that found nothing new.
                    const base = current.scopeKey === scopeKey ? current.values : {};
                    let next: Record<string, SessionAccessPrincipalSummaryV1> | null = null;
                    for (const candidate of candidates) {
                        const summary = candidate.principalSummary;
                        if (!summary || (next ?? base)[candidate.principal.key] === summary) continue;
                        const updated: Record<string, SessionAccessPrincipalSummaryV1> = next ?? { ...base };
                        updated[candidate.principal.key] = summary;
                        next = updated;
                    }
                    return next === null ? current : { scopeKey, values: next };
                });
                return candidates;
            },
        } : {}),
    })), [directory.sections, scopeKey]);

    const defaultGrant = creationDecision?.defaultGrant;
    const differsFromDefault = primaryTeamId === null
        ? grants.length > 0
        : grants.some((grant) => grant.subject.kind !== 'team' || grant.subject.teamId !== primaryTeamId) ? true
        : creationDecision?.teamId !== primaryTeamId ? false
        : defaultGrant === null ? grants.length > 0
        : grants.length !== 1 || !grants.some((grant) => grant.subject.kind === 'team'
            && grant.subject.teamId === primaryTeamId
            && grant.accessLevel === defaultGrant?.accessLevel
            && grant.canApprovePermissions === defaultGrant?.canApprovePermissions);

    return {
        query,
        placementPending: differsFromDefault || primaryTeamPolicyUnavailable || contextDecisionError
            || pendingContextDecision !== null || pendingContextTeamId !== undefined || explainedReason !== null
            || input.homeReconciled === true || (!editable && grants.length > 0),
        actions,
        model: {
            revision,
            accessMode: editable ? 'editable' : 'read_only',
            ...(editable ? {} : { readOnlyReason: { code: 'session_access_sharing_unavailable', message: t('session.collaboration.accessUnavailableReason') } }),
            content: { phase: 'ready', hasLastAcknowledgedSnapshot: true },
            owner: null,
            grants: rows,
            directory: { sections },
            summary: projectSessionAccessChipSummary({ grants: rows, audienceComplete: true }),
            context: {
                primaryTeamId,
                // A refused Team is said by its own choice below, with the step that meets its rule; nothing repeats it.
                ...(pendingContextDecision || contextDecisionError ? {
                    operation: contextDecisionError ? 'error' as const : 'saving' as const,
                    ...(contextDecisionError ? { error: {
                        code: 'session_access_context_policy_unavailable', message: t('session.access.contextPolicyUnavailable'), retryable: true,
                    } } : {}),
                } : {}),
                options: [
                    { teamId: null, label: t('session.access.private'),
                        ...(primaryTeamPolicy?.sessionCreationPolicy === 'team_required' ? { blockedReason: {
                            code: 'session_access_team_policy_required', message: t('session.access.required'),
                        } } : primaryTeamPolicyUnavailable ? { blockedReason: {
                            code: 'session_access_context_policy_unavailable', message: t('session.access.contextPolicyUnavailable'),
                        } } : {}) },
                    ...[
                        ...(primaryTeamPolicy && !directory.teamContexts.some((team) => team.teamId === primaryTeamPolicy.teamId) ? [primaryTeamPolicy] : []),
                        ...(signInRefusal && !directory.teamContexts.some((team) => team.teamId === signInRefusal.teamId)
                            ? [{ teamId: signInRefusal.teamId, name: signInRefusal.teamName }] : []),
                        ...directory.teamContexts,
                    ].map((team) => ({ teamId: team.teamId, label: team.name,
                        ...(signInReason && team.teamId === signInRefusal?.teamId ? { blockedReason: signInReason }
                        : primaryTeamDecisionPending || pendingContextDecision?.teamId === team.teamId ? { blockedReason: {
                            code: 'session_access_context_policy_unavailable', message: t('session.access.contextPolicyUnavailable'),
                        } } : creationDecision?.requiredByPolicy === true && team.teamId !== primaryTeamId
                            ? { blockedReason: { code: 'session_access_team_policy_required', message: t('session.access.required') } }
                            : team.teamId === primaryTeamId && primaryTeamPolicyUnavailable ? { blockedReason: {
                            code: 'session_access_context_policy_unavailable', message: t('session.access.contextPolicyUnavailable'),
                        } } : {}),
                    })),
                ],
                ...(pendingContextTeamId !== undefined ? { confirmation: {
                    teamId: pendingContextTeamId,
                        label: pendingContextTeamId === null ? t('session.access.private')
                        : pendingContextTarget?.name ?? t('session.access.team'),
                    consequences: projectSessionAccessContextChange({
                        target: pendingContextTeamId === null ? null : pendingContextTarget,
                        current: primaryTeamPolicy,
                        grants,
                    }),
                } } : {}),
            },
            ...(explainedReason
                ? { notice: { message: explainedReason.message, reason: explainedReason } }
                : input.homeReconciled
                    ? { notice: { message: t('session.access.homeReconciled'), reason: {
                        code: 'session_access_home_reconciled', message: t('session.access.homeReconciled'),
                    } } }
                : editable || grants.length === 0
                    ? {}
                    : { notice: { message: t('session.collaboration.accessUnavailableReason'), action: 'clear_access' as const } }),
        },
    };
}
