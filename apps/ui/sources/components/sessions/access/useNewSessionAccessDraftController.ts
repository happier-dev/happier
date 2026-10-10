import * as React from 'react';
import type { PrincipalRefV1, SessionAccessCreationDecisionV1, SessionInitialAccessDraftV1 } from '@happier-dev/protocol';

import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';

import { projectSessionAccessChipSummary } from './projectSessionAccessChipSummary';
import { projectSessionAccessPrincipal } from './projectSessionAccessEditorSnapshot';
import { projectSessionAccessContextChange } from './projectSessionAccessContextChange';
import { sessionAccessGrantMutation } from './sessionAccessGrantMutation';
import { projectSessionAccessDelegationControl, sessionAccessSubjectKey } from './projectSessionAccessEditorSnapshot';
import { resolveSessionAccessCreationDecision, resolveSessionAccessPrincipals } from '@/sync/api/session/sessionAccessApi';
import { useSessionAccessDirectory, type SessionAccessDirectoryTeamContext } from './useSessionAccessDirectory';
import type {
    SessionAccessEditorActions,
    SessionAccessEditorController,
    SessionAccessGrantRowModel,
    SessionAccessLevel,
    SessionAccessPrincipalPresentation,
} from './sessionAccessEditorTypes';

const ACCESS_LEVEL_OPTIONS: readonly SessionAccessLevel[] = ['view', 'edit', 'admin'];

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
}>): SessionAccessEditorController {
    const { access, availability, demanded, onChange, onPrimaryTeamIdChange, primaryTeamId, scope } = input;
    const viewerProfile = useShareViewerProfile(scope);
    const [query, setQuery] = React.useState('');
    const [revision, setRevision] = React.useState(0);
    const [pendingContextTeamId, setPendingContextTeamId] = React.useState<string | null | undefined>(undefined);
    const [explainedReason, setExplainedReason] = React.useState<Readonly<{ code: string; message: string }> | null>(null);
    const [creationDecision, setCreationDecision] = React.useState<SessionAccessCreationDecisionV1 | null | undefined>(undefined);
    const [pendingContextDecision, setPendingContextDecision] = React.useState<Readonly<{ teamId: string; retry: number }> | null>(null);
    const [pendingContextTarget, setPendingContextTarget] = React.useState<SessionAccessDirectoryTeamContext | null>(null);
    const [contextDecisionError, setContextDecisionError] = React.useState(false);
    // Display names come from the candidate row the person actually chose. A
    // restored draft has only Home-local identifiers, so its rows stay labelled
    // by kind rather than inventing a name for an identifier.
    const scopeKey = JSON.stringify([scope.serverId, scope.accountId]);
    const [resolvedNames, setResolvedNames] = React.useState<Readonly<{
        scopeKey: string;
        values: Readonly<Record<string, SessionAccessPrincipalPresentation>>;
    }>>({ scopeKey, values: {} });
    const names = resolvedNames.scopeKey === scopeKey ? resolvedNames.values : {};
    React.useEffect(() => {
        setPendingContextDecision(null);
        setPendingContextTarget(null);
        setContextDecisionError(false);
    }, [scopeKey]);
    const grants = React.useMemo(() => access?.grants ?? [], [access]);
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
        .map((grant) => ({ teamId: grant.subject.kind === 'team' ? grant.subject.teamId : '', name: names[sessionAccessSubjectKey(grant.subject)]?.displayName ?? t('session.access.team') })), [grants, names]);

    // Candidate discovery is editor detail and waits for an open presentation.
    // The primary Team's creation decision comes from the server-owned create
    // contract; it must not cause the detailed directory to mount in the chip.
    const directory = useSessionAccessDirectory({
        scope, availability, contextTeams, operations: {}, revision,
        enabled: editable && demanded,
    });
    const creationDecisionRevision = React.useRef(0);
    const creationDecisionCache = React.useRef<Readonly<{
        key: string;
        value?: SessionAccessCreationDecisionV1 | null;
        pending?: Promise<SessionAccessCreationDecisionV1 | null>;
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
        setResolvedNames((current) => current.scopeKey === scopeKey ? current : { scopeKey, values: {} });
        if (!editable || !demanded || grants.length === 0) return;
        const requestRevision = ++resolveRevision.current;
        let active = true;
        void resolveSessionAccessPrincipals({
            scope, availability, subjects: grants.map((grant) => grant.subject),
            isCurrent: () => active && resolveRevision.current === requestRevision,
        }).then((principals) => {
            if (!active || resolveRevision.current !== requestRevision) return;
            setResolvedNames((current) => {
                const base = current.scopeKey === scopeKey ? current.values : {};
                const next = { ...base };
                for (const principal of principals) {
                    const projected = projectSessionAccessPrincipal(principal, { accountId: scope.accountId, profile: viewerProfile });
                    next[projected.key] = projected;
                }
                return { scopeKey, values: next };
            });
        }).catch(() => {});
        return () => { active = false; };
    }, [availability, demanded, editable, grants, scope.accountId, scope.serverId, scopeKey, selectedSubjectsKey, viewerProfile]);
    const directoryTeamsRef = React.useRef(directory.teamContexts);
    directoryTeamsRef.current = directory.teamContexts;
    const primaryTeamDecisionPolicy = creationDecision === undefined || creationDecision === null
        ? null
        : projectCreationDecisionPolicy(creationDecision);
    // Directory rows are presentation and discovery only. Creation policy is
    // authoritative only when the selected-Home server has returned its typed
    // decision; a missing decision must never be inferred from a cached row.
    const primaryTeamPolicy = primaryTeamDecisionPolicy;
    const primaryTeamPolicyUnavailable = primaryTeamId !== null && creationDecision !== undefined && creationDecision === null && primaryTeamPolicy === null;
    const primaryTeamDecisionPending = primaryTeamId !== null && creationDecision === undefined;

    const rows = React.useMemo<readonly SessionAccessGrantRowModel[]>(() => grants.map((grant) => {
        const key = sessionAccessSubjectKey(grant.subject);
        const requiredByTeamPolicy = grant.subject.kind === 'team'
            && grant.subject.teamId === primaryTeamId
            && primaryTeamPolicy?.sessionCreationPolicy === 'team_required';
        const principal = names[key] ?? fallbackPrincipal(grant.subject);
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
    }), [editable, grants, names, primaryTeamId, primaryTeamPolicy?.sessionCreationPolicy]);

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
            if (decision === null) {
                setContextDecisionError(true);
                setExplainedReason({ code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed') });
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
            setExplainedReason({ code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed') });
        });
        return () => { active = false; };
    }, [availability, pendingContextDecision, primaryTeamPolicy, scope.accountId, scope.serverId, submitContext]);

    const setContext = React.useCallback((teamId: string | null) => {
        if (!editable || primaryTeamId === teamId || (primaryTeamId !== null && (primaryTeamDecisionPending || primaryTeamPolicyUnavailable))) return;
        if (creationDecision?.requiredByPolicy === true) return;
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
    }, [creationDecision?.requiredByPolicy, editable, primaryTeamDecisionPending, primaryTeamId, primaryTeamPolicy, primaryTeamPolicyUnavailable, submitContext]);

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
                setResolvedNames((current) => {
                    // Copy-on-first-change: unchanged names keep their identity so the
                    // rows around them are not rebuilt by a search that found nothing new.
                    const base = current.scopeKey === scopeKey ? current.values : {};
                    let next: Record<string, SessionAccessPrincipalPresentation> | null = null;
                    for (const candidate of candidates) {
                        if ((next ?? base)[candidate.principal.key] === candidate.principal) continue;
                        next ??= { ...base };
                        next[candidate.principal.key] = candidate.principal;
                    }
                    return next === null ? current : { scopeKey, values: next };
                });
                return candidates;
            },
        } : {}),
    })), [directory.sections]);

    return {
        actions,
        model: {
            revision,
            accessMode: editable ? 'editable' : 'read_only',
            ...(editable ? {} : { readOnlyReason: { code: 'session_access_sharing_unavailable', message: t('session.collaboration.accessUnavailableReason') } }),
            content: { phase: 'ready', hasLastAcknowledgedSnapshot: true },
            owner: null,
            grants: rows,
            directory: { query, sections },
            summary: projectSessionAccessChipSummary({ grants: rows, audienceComplete: true }),
            context: {
                primaryTeamId,
                ...(pendingContextDecision || contextDecisionError ? {
                    operation: contextDecisionError ? 'error' as const : 'saving' as const,
                    ...(contextDecisionError ? { error: {
                        code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed'), retryable: true,
                    } } : {}),
                } : {}),
                options: [
                    { teamId: null, label: t('session.access.private'),
                        ...(primaryTeamPolicy?.sessionCreationPolicy === 'team_required' ? { blockedReason: {
                            code: 'session_access_team_policy_required', message: t('session.access.required'),
                        } } : primaryTeamPolicyUnavailable ? { blockedReason: {
                            code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed'),
                        } } : {}) },
                    ...[
                        ...(primaryTeamPolicy && !directory.teamContexts.some((team) => team.teamId === primaryTeamPolicy.teamId) ? [primaryTeamPolicy] : []),
                        ...directory.teamContexts,
                    ].map((team) => ({ teamId: team.teamId, label: team.name,
                        ...(primaryTeamDecisionPending || pendingContextDecision?.teamId === team.teamId ? { blockedReason: {
                            code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed'),
                        } } : creationDecision?.requiredByPolicy === true && team.teamId !== primaryTeamId
                            ? { blockedReason: { code: 'session_access_team_policy_required', message: t('session.access.required') } }
                            : team.teamId === primaryTeamId && primaryTeamPolicyUnavailable ? { blockedReason: {
                            code: 'session_access_context_policy_unavailable', message: t('errors.operationFailed'),
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
