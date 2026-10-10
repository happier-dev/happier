import * as React from 'react';
import type { AccountDisplayProfileV1 } from '@happier-dev/protocol';
import { TeamsPageV1Schema, type TeamExternalSharingPolicyV1, type TeamMembershipV1, type TeamSessionCreationPolicyV1, type TeamsPageV1 } from '@happier-dev/protocol/teams';

import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { searchSessionAccessAccountPage } from '@/sync/api/session/sessionAccessApi';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { listTeamGroups } from '@/sync/ops/teams/teamGroupOperations';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';

import { projectSessionAccessPrincipal } from './projectSessionAccessEditorSnapshot';
import type {
    SessionAccessCandidateRowModel,
    SessionAccessDirectoryKind,
    SessionAccessDirectorySectionModel,
    SessionAccessGrantOperationModel,
} from './sessionAccessEditorTypes';

export type SessionAccessDirectoryTeamContext = Readonly<{
    teamId: string;
    name: string;
    sessionCreationPolicy?: TeamSessionCreationPolicyV1;
    externalSharingPolicy?: TeamExternalSharingPolicyV1;
}>;

type DirectoryCandidateRow = SessionAccessCandidateRowModel & Readonly<{
    /** Retain the Home's safe display facts so local viewer-profile changes do not erase them. */
    accountProfile?: AccountDisplayProfileV1;
}>;

type Page = Readonly<{
    rows: readonly DirectoryCandidateRow[];
    teamContexts?: readonly SessionAccessDirectoryTeamContext[];
    nextCursor: string | null;
    failed: boolean;
    loadingMore?: boolean;
    query?: string;
}>;

type GroupTeamPage = Readonly<{
    team: SessionAccessDirectoryTeamContext;
    rows: readonly SessionAccessCandidateRowModel[];
    nextCursor: string | null;
    initialized: boolean;
    failed: boolean;
}>;

type GroupDirectoryPage = Readonly<{
    byTeam: Readonly<Record<string, GroupTeamPage>>;
    teamCursor: string | null;
    teamDiscoveryFailed: boolean;
    loadingMore: boolean;
    revision: number;
}>;

/**
 * One shared idle operation so an untouched candidate keeps its row identity
 * across every re-resolve. Rows are fetched with this value and the current
 * operation is applied on the way out, never frozen into the cached page.
 */
const IDLE_OPERATION: SessionAccessGrantOperationModel = Object.freeze({ kind: 'idle' });
const EMPTY_PAGE: Page = Object.freeze({ rows: [], nextCursor: null, failed: false });
const EMPTY_TEAM_CONTEXTS: readonly SessionAccessDirectoryTeamContext[] = Object.freeze([]);
const ALL_DIRECTORY_KINDS: readonly SessionAccessDirectoryKind[] = Object.freeze(['account', 'team', 'group']);
const EMPTY_GROUP_PAGE: GroupDirectoryPage = Object.freeze({
    byTeam: {},
    teamCursor: null,
    teamDiscoveryFailed: false,
    loadingMore: false,
    revision: 0,
});

function groupRows(page: GroupDirectoryPage): readonly SessionAccessCandidateRowModel[] {
    return Object.values(page.byTeam).flatMap((source) => source.rows);
}

/**
 * One Team membership as a candidate row.
 *
 * Suspended memberships remain visible in administration history, but they are
 * not current collaboration principals and cannot be assigned new credential
 * access or External API keys — so the same status rule applies to the roster
 * page and to a lookup the Home answered.
 */
function teamMemberRows(
    memberships: readonly TeamMembershipV1[],
    viewer: Parameters<typeof projectSessionAccessPrincipal>[1],
): readonly DirectoryCandidateRow[] {
    return memberships
        .filter((membership) => membership.status === 'active')
        .map((membership) => ({
            principal: projectSessionAccessPrincipal({
                kind: 'account', accountId: membership.accountId,
                username: membership.account.username,
                firstName: membership.account.firstName,
                lastName: membership.account.lastName,
                avatarUrl: membership.account.avatarUrl,
            }, viewer),
            accountProfile: membership.account,
            teamMembership: { teamId: membership.teamId, teamMembershipId: membership.id, accountId: membership.accountId },
            addition: { kind: 'allowed' as const }, operation: IDLE_OPERATION,
        }));
}

function narrow(rows: readonly SessionAccessCandidateRowModel[], query: string): readonly SessionAccessCandidateRowModel[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => [row.principal.displayName, row.principal.secondaryLabel]
        .some((value) => value?.toLocaleLowerCase().includes(needle)));
}

export type SessionAccessDirectory = Readonly<{
    sections: readonly SessionAccessDirectorySectionModel[];
    teamContexts: readonly SessionAccessDirectoryTeamContext[];
    activeTeamContexts: readonly SessionAccessDirectoryTeamContext[];
    teamDirectoryStatus: 'loading' | 'ready' | 'error';
    teamDirectoryComplete: boolean;
    loadMore: (kind: SessionAccessDirectoryKind) => void;
    retry: (kind: SessionAccessDirectoryKind) => void;
}>;

/**
 * The heterogeneous candidate presentation the access editor renders, composed
 * from the independently owned directory sources.
 *
 * Each kind keeps its own owner, ranking, cursor and failure. Every lookup for a
 * person is the Home's: Accounts through the collaboration-eligible projection of
 * the incumbent username directory, and Team members through the roster's own
 * bounded `teams.members.list` query, so one matcher decides who matches and a
 * member on an unread page is found exactly like one on the first. The Team and
 * Group directory intents still declare no query contract
 * (`TeamsListInputV1Schema`, `TeamGroupsListInputV1Schema`), so those bounded
 * pages are narrowed locally rather than by inventing a search API. No cursor is
 * merged, nothing is re-ranked across kinds, and identity is always the
 * kind-qualified subject reference — never a display name.
 *
 * Groups have no Home-wide directory operation, so Group discovery composes the
 * complete member-Team directory with each Team's independently paged Group
 * directory. Existing grant/context Teams seed display names but never bound the
 * candidate set: a Group can be selected before its Team has a Session grant.
 */
export function useSessionAccessDirectory(input: Readonly<{
    scope: ServerAccountScope;
    sessionId?: string;
    availability: SessionCollaborationAvailability;
    contextTeams: readonly SessionAccessDirectoryTeamContext[];
    operations: Readonly<Record<string, SessionAccessGrantOperationModel>>;
    /** Bumped by the owner to force a re-resolve after a mutation or retry. */
    revision: number;
    enabled: boolean;
    teamAddress?: TeamAddress;
    principalKinds?: readonly SessionAccessDirectoryKind[];
}>): SessionAccessDirectory {
    const { availability, enabled, operations, revision, scope, sessionId } = input;
    const viewerProfile = useShareViewerProfile(scope);
    const viewer = React.useMemo(() => ({ accountId: scope.accountId, profile: viewerProfile }), [scope.accountId, viewerProfile]);
    const viewerPresentationKey = JSON.stringify(viewerProfile);
    const scopeKey = `${scope.serverId} ${scope.accountId} ${availability} ${sessionId ?? 'draft'}`;
    const contextTeams = input.contextTeams;
    const teamAddress = input.teamAddress ?? null;
    const principalKinds = input.principalKinds ?? ALL_DIRECTORY_KINDS;
    const allowsAccounts = principalKinds.includes('account');
    const allowsTeams = principalKinds.includes('team');
    const allowsGroups = principalKinds.includes('group');
    // The lookup the person is typing IS the roster's sequence identity: the Home answers it,
    // and its cursor continues that answer. Holding the query anywhere else would give the
    // section two pagers — one describing the matches, one paging the unqueried roster.
    const [teamMemberQuery, setTeamMemberQuery] = React.useState('');
    const teamMembers = useTeamMembersRoster({ scope, address: teamAddress, filter: 'all', query: teamMemberQuery, enabled: enabled && teamAddress !== null && allowsAccounts });
    const teamGroups = useTeamGroups({ scope, address: teamAddress, archived: 'active', enabled: enabled && teamAddress !== null && allowsGroups });
    const contextTeamKey = contextTeams.map((team) => team.teamId).sort().join(',');
    const [pages, setPages] = React.useState<Readonly<Record<string, Page>>>({});
    const [groupPage, setGroupPage] = React.useState<GroupDirectoryPage | null>(null);
    const currentScope = React.useRef(scopeKey);
    currentScope.current = scopeKey;
    const pagesRef = React.useRef(pages);
    pagesRef.current = pages;
    const groupPageRef = React.useRef(groupPage);
    groupPageRef.current = groupPage;
    const groupRequest = React.useRef<Promise<GroupDirectoryPage> | null>(null);
    const firstTeamPageRequest = React.useRef<Promise<Readonly<{ rows: readonly SessionAccessCandidateRowModel[]; teamContexts?: readonly SessionAccessDirectoryTeamContext[]; nextCursor: string | null }>> | null>(null);
    const contextTeamsRef = React.useRef(contextTeams);
    contextTeamsRef.current = contextTeams;

    React.useEffect(() => {
        firstTeamPageRequest.current = null;
        groupRequest.current = null;
        setPages({});
        setGroupPage(null);
        setTeamMemberQuery('');
    }, [scopeKey]);

    const operation = React.useCallback(
        (key: string): SessionAccessGrantOperationModel => operations[key] ?? IDLE_OPERATION,
        [operations],
    );

    /**
     * A live add is dispatched by subject before any grant row exists, so the
     * candidate row is the only place its pending, failed, or settled state can
     * appear. Rows are republished from the retained page with the current
     * operation instead of refetching, and an unaffected row is returned by
     * identity so the list does not rebuild it.
     */
    const applyOperations = React.useCallback((
        rows: readonly DirectoryCandidateRow[],
    ): readonly SessionAccessCandidateRowModel[] => {
        let changed = false;
        const next = rows.map((row) => {
            const current = operation(row.principal.key);
            // A loaded directory page remains its Home's answer. The viewer's own display fields
            // can refresh locally without querying or borrowing the focused Home's Profile.
            const principal = row.principal.ref.kind === 'account' && row.principal.ref.accountId === scope.accountId
                ? presentSharePrincipal({ ref: row.principal.ref, profile: row.accountProfile,
                    viewerProfile, viewerAccountId: scope.accountId })
                : row.principal;
            const samePrincipal = principal.displayName === row.principal.displayName
                && principal.secondaryLabel === row.principal.secondaryLabel
                && principal.accessibilityLabel === row.principal.accessibilityLabel
                && principal.avatar?.imageUrl === row.principal.avatar?.imageUrl;
            if (row.operation === current && samePrincipal) return row;
            changed = true;
            return { ...row, principal: samePrincipal ? row.principal : principal, operation: current };
        });
        return changed ? next : rows;
    }, [operation, scope.accountId, viewerProfile]);

    /**
     * Only non-idle operations enter the section resolver keys, so an editor with
     * nothing in flight keeps one stable key and the list's dynamic-section cache
     * is never invalidated by an unrelated render.
     */
    const operationsKey = React.useMemo(() => Object.entries(operations)
        .filter(([, value]) => value.kind !== 'idle')
        .map(([key, value]) => `${key}=${value.kind}${value.kind === 'error' ? `:${value.error.code}` : ''}`)
        .sort()
        .join(','), [operations]);

    const loadTeams = React.useCallback(async (cursor: string | null) => {
        const outcome = await runTeamAction({
            scope,
            actionId: 'teams.list',
            input: { v: 1, scope: 'member', archived: 'active', ...(cursor ? { cursor } : {}) },
            parse: (value): TeamsPageV1 => TeamsPageV1Schema.parse(value),
        });
        if (outcome.kind !== 'succeeded') throw new Error(outcome.failure.kind);
        return {
            rows: outcome.value.items.map((team) => {
                const principal = projectSessionAccessPrincipal({ kind: 'team', teamId: team.id, name: team.name });
                return { principal, addition: { kind: 'allowed' as const }, operation: IDLE_OPERATION };
            }),
            teamContexts: outcome.value.items.map((team) => ({
                teamId: team.id,
                name: team.name,
                sessionCreationPolicy: team.policy.sessionCreationPolicy,
                externalSharingPolicy: team.policy.externalSharingPolicy,
            })),
            nextCursor: outcome.value.nextCursor,
        };
    }, [scope]);

    const loadFirstTeamPage = React.useCallback(() => {
        const acknowledged = pagesRef.current.team;
        if (acknowledged) return Promise.resolve(acknowledged);
        const active = firstTeamPageRequest.current;
        if (active) return active;
        const request = loadTeams(null);
        firstTeamPageRequest.current = request;
        void request.catch(() => {
            if (firstTeamPageRequest.current === request) firstTeamPageRequest.current = null;
        });
        return request;
    }, [loadTeams]);

    const loadGroupSource = React.useCallback(async (
        source: GroupTeamPage,
    ): Promise<GroupTeamPage> => {
        const cursor = source.initialized ? source.nextCursor : null;
        const outcome = await listTeamGroups({
            scope,
            address: { serverId: scope.serverId, teamId: source.team.teamId },
            archived: 'active',
            ...(cursor ? { cursor } : {}),
        }).catch(() => null);
        if (!outcome) return { ...source, failed: true };
        if (outcome.kind !== 'succeeded') return { ...source, failed: true };
        const nextRows = outcome.value.items.map((group) => {
            const principal = projectSessionAccessPrincipal({
                kind: 'group', teamId: group.teamId, groupId: group.id, name: group.name, teamName: source.team.name,
            });
            return { principal, addition: { kind: 'allowed' as const }, operation: IDLE_OPERATION };
        });
        const seen = new Set(source.rows.map((row) => row.principal.key));
        return {
            team: source.team,
            rows: [...source.rows, ...nextRows.filter((row) => !seen.has(row.principal.key))],
            nextCursor: outcome.value.nextCursor,
            initialized: true,
            failed: false,
        };
    }, [scope]);

    const advanceGroups = React.useCallback((mode: 'initial' | 'more' | 'retry'): Promise<GroupDirectoryPage> => {
        if (groupRequest.current) return groupRequest.current;
        const request = (async () => {
            let teamPage = pagesRef.current.team;
            let teamDiscoveryFailed = groupPageRef.current?.teamDiscoveryFailed ?? false;
            if (teamPage?.failed) teamDiscoveryFailed = true;
            if (!teamPage || (mode === 'retry' && teamPage.failed)) {
                try {
                    if (teamPage?.failed) firstTeamPageRequest.current = null;
                    const first = await loadFirstTeamPage();
                    teamPage = { ...first, failed: false };
                    if (currentScope.current === scopeKey) {
                        setPages((current) => ({ ...current, team: teamPage! }));
                    }
                    teamDiscoveryFailed = false;
                } catch {
                    teamDiscoveryFailed = true;
                }
            }

            let base = groupPageRef.current ?? {
                ...EMPTY_GROUP_PAGE,
                teamCursor: teamPage?.nextCursor ?? null,
            };
            const teams = new Map(contextTeamsRef.current.map((team) => [team.teamId, team]));
            for (const team of teamPage?.teamContexts ?? []) teams.set(team.teamId, team);
            let byTeam = { ...base.byTeam };
            for (const team of teams.values()) {
                if (!byTeam[team.teamId]) {
                    byTeam[team.teamId] = { team, rows: [], nextCursor: null, initialized: false, failed: false };
                }
            }

            let teamCursor = base.teamCursor ?? teamPage?.nextCursor ?? null;
            const candidates = () => Object.values(byTeam).filter((source) => mode === 'retry'
                ? source.failed || !source.initialized
                : !source.initialized || (mode === 'more' && source.nextCursor !== null));
            let sources = candidates();

            // A Group continuation advances one bounded Team-directory page
            // only after all currently known Group sources have had a chance
            // to advance. It never drains either directory eagerly.
            if (sources.length === 0 && teamCursor && (mode === 'more' || (mode === 'retry' && teamDiscoveryFailed))) {
                try {
                    const nextTeams = await loadTeams(teamCursor);
                    const previousTeam = pagesRef.current.team ?? EMPTY_PAGE;
                    const knownRows = new Set(previousTeam.rows.map((row) => row.principal.key));
                    const knownTeams = new Set((previousTeam.teamContexts ?? []).map((team) => team.teamId));
                    const mergedTeamPage: Page = {
                        rows: [...previousTeam.rows, ...nextTeams.rows.filter((row) => !knownRows.has(row.principal.key))],
                        teamContexts: [...(previousTeam.teamContexts ?? []), ...(nextTeams.teamContexts ?? []).filter((team) => !knownTeams.has(team.teamId))],
                        nextCursor: nextTeams.nextCursor,
                        failed: false,
                    };
                    if (currentScope.current === scopeKey) setPages((current) => ({ ...current, team: mergedTeamPage }));
                    for (const team of nextTeams.teamContexts ?? []) {
                        if (!byTeam[team.teamId]) byTeam[team.teamId] = {
                            team, rows: [], nextCursor: null, initialized: false, failed: false,
                        };
                    }
                    teamCursor = nextTeams.nextCursor;
                    teamDiscoveryFailed = false;
                    sources = Object.values(byTeam).filter((source) => !source.initialized);
                } catch {
                    teamDiscoveryFailed = true;
                }
            }

            if (sources.length > 0) {
                const loaded = await Promise.all(sources.map(loadGroupSource));
                for (const source of loaded) byTeam[source.team.teamId] = source;
            }
            return {
                byTeam,
                teamCursor,
                teamDiscoveryFailed,
                loadingMore: false,
                revision: base.revision + 1,
            };
        })();
        groupRequest.current = request;
        void request.then(() => {
            if (groupRequest.current === request) groupRequest.current = null;
        }, () => {
            if (groupRequest.current === request) groupRequest.current = null;
        });
        return request;
    }, [loadFirstTeamPage, loadGroupSource, loadTeams, scopeKey]);

    const resolveAccount = React.useCallback(async (
        query: string,
        signal: AbortSignal,
    ): Promise<readonly SessionAccessCandidateRowModel[]> => {
        const existing = pagesRef.current.account;
        if (existing?.query === query && !existing.failed) return applyOperations(existing.rows);
        try {
            const page = await searchSessionAccessAccountPage({
                scope,
                availability,
                query,
                signal,
                isCurrent: () => currentScope.current === scopeKey,
            });
            if (currentScope.current !== scopeKey || signal.aborted) return [];
            const next: Page = {
                rows: page.rows.map((principal) => ({
                    principal: projectSessionAccessPrincipal(principal, viewer),
                    accountProfile: principal,
                    addition: { kind: 'allowed' as const },
                    operation: IDLE_OPERATION,
                })),
                nextCursor: page.nextCursor,
                failed: false,
                query,
            };
            setPages((current) => ({ ...current, account: next }));
            return applyOperations(next.rows);
        } catch (error) {
            if (currentScope.current === scopeKey && !signal.aborted) {
                setPages((current) => ({ ...current, account: { ...EMPTY_PAGE, query, failed: true } }));
            }
            throw error;
        }
    }, [applyOperations, availability, scope, scopeKey, sessionId, viewer]);

    /**
     * Looking a Team member up asks the Home, exactly as the roster screen does,
     * so a member on an unread page is found and this editor never becomes a
     * second matcher for the same question.
     *
     * The lookup is published to the roster rather than fetched here: that owner
     * already fences superseded answers and binds its cursor to the query, so
     * "Load more" continues the matches the person is looking at instead of the
     * unqueried roster, and the section's `hasMore` describes that same sequence.
     */
    const resolveTeamMember = React.useCallback(async (
        rosterRows: readonly SessionAccessCandidateRowModel[],
        query: string,
    ): Promise<readonly SessionAccessCandidateRowModel[]> => {
        const search = query.trim();
        setTeamMemberQuery((current) => (current === search ? current : search));
        return applyOperations(rosterRows);
    }, [applyOperations]);

    const resolvePaged = React.useCallback(async (
        kind: 'team' | 'group',
        query: string,
    ): Promise<readonly SessionAccessCandidateRowModel[]> => {
        if (kind === 'group') {
            const existing = groupPageRef.current;
            if (existing) return applyOperations(narrow(groupRows(existing), query));
            const page = await advanceGroups('initial');
            if (currentScope.current !== scopeKey) return [];
            setGroupPage(page);
            return applyOperations(narrow(groupRows(page), query));
        }
        const existing = pagesRef.current.team ?? EMPTY_PAGE;
        if (existing.rows.length > 0) return applyOperations(narrow(existing.rows, query));
        try {
            const page = await loadFirstTeamPage();
            if (currentScope.current !== scopeKey) return [];
            setPages((current) => ({ ...current, team: { ...page, failed: false } }));
            return applyOperations(narrow(page.rows, query));
        } catch (error) {
            if (currentScope.current === scopeKey) {
                setPages((current) => ({ ...current, team: { ...EMPTY_PAGE, failed: true } }));
            }
            throw error;
        }
    }, [advanceGroups, applyOperations, loadFirstTeamPage, scopeKey]);

    const loadMore = React.useCallback((kind: SessionAccessDirectoryKind) => {
        if (teamAddress) {
            if (kind === 'account') void teamMembers.loadMore();
            if (kind === 'group') void teamGroups.loadMore();
            return;
        }
        if (kind === 'account') {
            const existing = pagesRef.current.account;
            if (!existing?.nextCursor || existing.loadingMore || existing.query === undefined) return;
            setPages((current) => ({ ...current, account: { ...(current.account ?? existing), loadingMore: true, failed: false } }));
            void (async () => {
                try {
                    const page = await searchSessionAccessAccountPage({
                        scope,
                        availability,
                        query: existing.query!,
                        cursor: existing.nextCursor,
                        isCurrent: () => currentScope.current === scopeKey,
                    });
                    if (currentScope.current !== scopeKey) return;
                    setPages((current) => {
                        const previous = current.account ?? existing;
                        if (previous.query !== existing.query) return current;
                        const seen = new Set(previous.rows.map((row) => row.principal.key));
                        const rows = page.rows.map((principal) => ({
                            principal: projectSessionAccessPrincipal(principal, viewer),
                            accountProfile: principal,
                            addition: { kind: 'allowed' as const },
                            operation: IDLE_OPERATION,
                        }));
                        return { ...current, account: {
                            ...previous,
                            rows: [...previous.rows, ...rows.filter((row) => !seen.has(row.principal.key))],
                            nextCursor: page.nextCursor,
                            loadingMore: false,
                            failed: false,
                        } };
                    });
                } catch {
                    if (currentScope.current !== scopeKey) return;
                    setPages((current) => current.account?.query !== existing.query ? current : ({ ...current, account: {
                        ...current.account, loadingMore: false, failed: true,
                    } }));
                }
            })();
            return;
        }
        if (kind === 'group') {
            const existing = groupPageRef.current;
            if (existing?.loadingMore) return;
            if (existing) setGroupPage({ ...existing, loadingMore: true });
            void advanceGroups('more').then((page) => {
                if (currentScope.current === scopeKey) setGroupPage(page);
            });
            return;
        }
        const existing = pagesRef.current.team ?? EMPTY_PAGE;
        if (!existing.nextCursor || existing.loadingMore) return;
        setPages((current) => ({ ...current, team: { ...(current.team ?? existing), loadingMore: true, failed: false } }));
        void (async () => {
            try {
                const page = await loadTeams(existing.nextCursor);
                if (currentScope.current !== scopeKey) return;
                setPages((current) => {
                    const previous = current.team ?? EMPTY_PAGE;
                    const seen = new Set(previous.rows.map((row) => row.principal.key));
                    return {
                        ...current,
                        team: {
                            rows: [...previous.rows, ...page.rows.filter((row) => !seen.has(row.principal.key))],
                            teamContexts: [...(previous.teamContexts ?? []), ...(page.teamContexts ?? []).filter((team) => !(previous.teamContexts ?? []).some((item) => item.teamId === team.teamId))],
                            nextCursor: page.nextCursor,
                            failed: false,
                            loadingMore: false,
                        },
                    };
                });
            } catch {
                if (currentScope.current !== scopeKey) return;
                setPages((current) => ({ ...current, team: { ...(current.team ?? EMPTY_PAGE), failed: true, loadingMore: false } }));
            }
        })();
    }, [advanceGroups, availability, loadTeams, scope, scopeKey, sessionId, teamAddress, teamGroups, teamMembers, viewer]);

    // Context uses the same Team directory page as candidate discovery. Loading
    // it when the editor opens makes eligible Teams visible before a search,
    // without adding a context-specific fetch, cache, or policy owner.
    React.useEffect(() => {
        // An empty or failed page is still an acknowledged attempt. Re-running
        // it on every render creates a refresh loop and makes authoritative
        // empty-directory recovery impossible; only the explicit retry removes
        // the page and starts another attempt.
        if (!enabled || teamAddress || availability !== 'available' || pagesRef.current.team !== undefined) return;
        void resolvePaged('team', '').catch(() => {});
    }, [availability, enabled, resolvePaged, revision, teamAddress]);

    const retry = React.useCallback((kind: SessionAccessDirectoryKind) => {
        if (teamAddress) {
            if (kind === 'account') void teamMembers.reload();
            if (kind === 'group') void teamGroups.reload();
            return;
        }
        if (kind === 'account') {
            const existing = pagesRef.current.account;
            if (!existing) return;
            if (existing.rows.length > 0 && existing.nextCursor) {
                loadMore('account');
                return;
            }
            setPages((current) => {
                const next = { ...current };
                delete next.account;
                return next;
            });
            return;
        }
        if (kind === 'group') {
            const existing = groupPageRef.current;
            if (existing?.loadingMore) return;
            if (existing) setGroupPage({ ...existing, loadingMore: true });
            void advanceGroups('retry').then((page) => {
                if (currentScope.current === scopeKey) setGroupPage(page);
            });
            return;
        }
        if (kind === 'team') {
            const existing = pagesRef.current.team;
            if (existing && existing.rows.length > 0 && existing.nextCursor) {
                loadMore('team');
                return;
            }
            firstTeamPageRequest.current = null;
        }
        setPages((current) => {
            if (!current[kind]) return current;
            const next = { ...current };
            delete next[kind];
            return next;
        });
    }, [advanceGroups, loadMore, scopeKey, teamAddress, teamGroups, teamMembers]);

    const sections = React.useMemo(() => {
        if (!enabled) return [];
        const accountPage = pages.account ?? EMPTY_PAGE;
        const directoryError = { code: 'session_access_directory_failed', message: t('errors.operationFailed'), retryable: true } as const;
        if (teamAddress) {
            const accountRows = teamMemberRows(teamMembers.rows, viewer);
            const groupCandidateRows: readonly SessionAccessCandidateRowModel[] = teamGroups.rows.map((group) => ({
                principal: projectSessionAccessPrincipal({
                    kind: 'group', teamId: group.teamId, groupId: group.id, name: group.name,
                    teamName: contextTeams.find((team) => team.teamId === group.teamId)?.name ?? '',
                }),
                teamGroup: { teamId: group.teamId, teamGroupId: group.id },
                addition: { kind: 'allowed' as const }, operation: IDLE_OPERATION,
            }));
            const scoped: SessionAccessDirectorySectionModel[] = [{
                kind: 'account' as const, title: t('session.access.people'), candidates: accountRows,
                status: teamMembers.status === 'error' ? 'error' as const : teamMembers.status === 'loading' ? 'loading' as const : teamMembers.status === 'loading_more' ? 'refreshing' as const : 'idle' as const,
                ...(teamMembers.status === 'error' ? { error: directoryError } : {}),
                cursor: teamMembers.hasMore ? `team-members:${teamMemberQuery}:${teamMembers.rows.length}` : null,
                hasMore: teamMembers.hasMore, loadingMore: teamMembers.status === 'loading_more',
                resolverKey: `${scopeKey}:team-members:${revision}:${teamMemberQuery}:${teamMembers.rows.length}:${teamMembers.status}:${operationsKey}:${viewerPresentationKey}`,
                resolveCandidates: (query: string) => resolveTeamMember(accountRows, query),
            }, {
                kind: 'group' as const, title: t('session.access.groups'), candidates: groupCandidateRows,
                status: teamGroups.status === 'error' ? 'error' as const : teamGroups.status === 'loading' ? 'loading' as const : teamGroups.status === 'loading_more' ? 'refreshing' as const : 'idle' as const,
                ...(teamGroups.status === 'error' ? { error: directoryError } : {}),
                cursor: teamGroups.hasMore ? `team-groups:${teamGroups.rows.length}` : null,
                hasMore: teamGroups.hasMore, loadingMore: teamGroups.status === 'loading_more',
                resolverKey: `${scopeKey}:team-groups:${revision}:${teamGroups.rows.length}:${teamGroups.status}:${operationsKey}`,
                resolveCandidates: async (query: string) => applyOperations(narrow(groupCandidateRows, query)),
            }];
            return scoped.filter((section) => principalKinds.includes(section.kind));
        }
        const built: SessionAccessDirectorySectionModel[] = [{
            kind: 'account',
            title: t('session.access.people'),
            candidates: [],
            status: accountPage.failed ? 'error' : accountPage.loadingMore ? 'refreshing' : 'idle',
            ...(accountPage.failed ? { error: directoryError } : {}),
            cursor: accountPage.nextCursor,
            hasMore: accountPage.nextCursor !== null,
            loadingMore: accountPage.loadingMore ?? false,
            resolverKey: `${scopeKey}:account:${revision}:${accountPage.query ?? ''}:${accountPage.rows.length}:${accountPage.failed}:${operationsKey}:${viewerPresentationKey}`,
            resolveCandidates: resolveAccount,
        }];
        // Team and Group grants exist only where the Home shares Sessions.
        if (availability !== 'available') return built.filter((section) => principalKinds.includes(section.kind));
        const teamPage = pages.team ?? EMPTY_PAGE;
        built.push({
            kind: 'team',
            title: t('session.access.teams'),
            candidates: applyOperations(teamPage.rows),
            status: teamPage.failed ? 'error' : teamPage.loadingMore ? 'refreshing' : 'idle',
            ...(teamPage.failed ? { error: directoryError } : {}),
            cursor: teamPage.nextCursor,
            hasMore: teamPage.nextCursor !== null,
            loadingMore: teamPage.loadingMore ?? false,
            resolverKey: `${scopeKey}:team:${revision}:${teamPage.rows.length}:${teamPage.failed}:${operationsKey}`,
            resolveCandidates: (query) => resolvePaged('team', query),
        });
        const currentGroupPage = groupPage ?? EMPTY_GROUP_PAGE;
        const groupSources = Object.values(currentGroupPage.byTeam);
        const knownTeamIds = new Set(groupSources.map((source) => source.team.teamId));
        const hasUninitializedKnownTeam = [...contextTeams, ...(teamPage.teamContexts ?? [])]
            .some((team) => !knownTeamIds.has(team.teamId));
        const groupFailed = currentGroupPage.teamDiscoveryFailed || groupSources.some((source) => source.failed);
        const groupHasMore = groupFailed
            || hasUninitializedKnownTeam
            || currentGroupPage.teamCursor !== null
            || groupSources.some((source) => !source.initialized || source.nextCursor !== null);
        built.push({
            kind: 'group',
            title: t('session.access.groups'),
            candidates: applyOperations(groupRows(currentGroupPage)),
            status: groupFailed ? 'error' : currentGroupPage.loadingMore ? 'refreshing' : 'idle',
            ...(groupFailed ? { error: directoryError } : {}),
            cursor: groupHasMore ? `${scopeKey}:groups:${currentGroupPage.revision}` : null,
            hasMore: groupHasMore,
            loadingMore: currentGroupPage.loadingMore,
            resolverKey: `${scopeKey}:group:${revision}:${contextTeamKey}:${currentGroupPage.revision}:${groupRows(currentGroupPage).length}:${groupFailed}:${operationsKey}`,
            resolveCandidates: (query) => resolvePaged('group', query),
        });
        return built.filter((section) => principalKinds.includes(section.kind));
    }, [applyOperations, availability, contextTeamKey, contextTeams, enabled, groupPage, operationsKey, pages, principalKinds, resolveAccount, resolvePaged, resolveTeamMember, revision, scopeKey, teamAddress, teamGroups.hasMore, teamGroups.rows, teamGroups.status, teamMemberQuery, teamMembers.hasMore, teamMembers.rows, teamMembers.status, viewer, viewerPresentationKey]);

    const teamContexts = React.useMemo(() => {
        const discovered = pages.team?.teamContexts ?? [];
        const byId = new Map(contextTeams.map((team) => [team.teamId, team]));
        for (const team of discovered) byId.set(team.teamId, team);
        return [...byId.values()];
    }, [contextTeams, pages.team?.teamContexts]);

    const activeTeamContexts = pages.team?.teamContexts ?? EMPTY_TEAM_CONTEXTS;
    const teamDirectoryStatus = !pages.team ? 'loading' as const
        : pages.team.failed ? 'error' as const
            : 'ready' as const;
    const teamDirectoryComplete = teamDirectoryStatus === 'ready'
        && pages.team?.nextCursor === null;

    return React.useMemo(() => ({
        sections,
        teamContexts,
        activeTeamContexts,
        teamDirectoryStatus,
        teamDirectoryComplete,
        loadMore,
        retry,
    }), [activeTeamContexts, loadMore, retry, sections, teamContexts, teamDirectoryComplete, teamDirectoryStatus]);
}
