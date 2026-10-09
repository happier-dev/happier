import * as React from 'react';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { seedAndOpenProjectDraft } from './activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from './activation/projectOpenPresentation';
import { buildProjectSourceOpenRoute, readProjectOpenRouteDraft } from './activation/projectOpenRoute';
import type { ProjectsAddMenuSources } from './ProjectsAddMenu';
import type { ProjectsTreeSavedItem } from './ProjectsTree';
import { useProjectSources } from './sources/useProjectSources';
import { groupProjectSources } from './sources/projectSourceGroups';
import type { ProjectSourceDraft } from './sources/projectSourcesController';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { describeProjectSourceRow } from './sources/projectSourceAddress';

const NO_ACCOUNT_SCOPE = { serverId: '', accountId: '' } as const;

/**
 * Where Projects come from, composed once for every Projects entrance (column, phone list, the
 * none-open page — lab p-projects TREE/TREEp): the "+" menu's your Sources then each Team's, Clone and
 * Manage, and your own Sources that have no checkout yet ("Saved, not open"). Opening a Source or a
 * clone goes through the one Open draft seed with the captured Account lifetime.
 */
export function useProjectsSourcesComposition(openedSourceIds: ReadonlySet<string>) {
    const accountScope = useActiveServerAccountScope();
    const router = useRouter();
    const navigateToOpen = useNavigateToProjectOpen();
    const sources = useProjectSources(accountScope ?? NO_ACCOUNT_SCOPE, { enabled: accountScope != null });
    const teamServerIds = React.useMemo(() => (accountScope ? [accountScope.serverId] : []), [accountScope?.serverId]);
    const teamsDirectory = useTeamsDirectory({ serverIds: teamServerIds, enabled: accountScope != null });
    const teamName = React.useCallback((teamId: string) => teamsDirectory.rows.find(row => row.team.id === teamId)?.team.name ?? null, [teamsDirectory.rows]);
    const creationTarget = React.useRef<Readonly<{ ref: WorkspaceRefV1; lifetime: NonNullable<ReturnType<typeof captureActiveServerAccountScopeLifetime>> }> | null>(null);
    const saveSourceCreation = React.useCallback(async () => {
        const target = creationTarget.current;
        if (!target?.lifetime.isCurrent()) return { kind: 'unavailable' as const };
        const created = sources.controller.getSnapshot().creationDraft ? await sources.controller.save() : sources.controller.getSnapshot().current;
        if (!created) return { kind: 'not_saved' as const, issue: sources.controller.getSnapshot().issue };
        if (!target.lifetime.isCurrent() || creationTarget.current !== target) return { kind: 'unavailable' as const };
        const account = await captureLazyActionAccountContext(target.lifetime.scope.serverId);
        try {
            if (!target.lifetime.isCurrent() || account.accountId !== target.lifetime.scope.accountId) return { kind: 'unavailable' as const };
            const recorded = await createUiProjectAccountRowsClient(account).recordWorkspaceSource(workspaceAddressFromRefV1(target.ref),
                { sourceId: created.id, revision: created.revision });
            if (!recorded.ok) return { kind: 'provenance_not_saved' as const, source: created, issue: recorded.errorCode };
            creationTarget.current = null;
            return { kind: 'saved' as const, source: created };
        } finally { account.dispose(); }
    }, [sources.controller, sources.state.creationDraft]);
    const saveAsSource = React.useCallback(async (ref: WorkspaceRefV1, draft?: ProjectSourceDraft) => {
        if (sources.controller.getSnapshot().mutation !== 'idle' || sources.controller.getSnapshot().uncertainCreate)
            return { kind: 'not_saved' as const, issue: sources.controller.getSnapshot().issue };
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || lifetime.scope.serverId !== ref.serverId || lifetime.scope.accountId !== accountScope?.accountId)
            return { kind: 'unavailable' as const };
        creationTarget.current = { ref, lifetime };
        sources.controller.beginCreate(draft ?? { name: resolveWorkspaceRefDisplayName(ref) });
        if (!draft) return { kind: 'editing' as const };
        return saveSourceCreation();
    }, [accountScope?.accountId, saveSourceCreation, sources.controller]);

    const openSource = React.useCallback((source: ProjectSourceV1) => {
        if (!accountScope) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const selection = readProjectOpenRouteDraft(buildProjectSourceOpenRoute(accountScope.serverId, source).params);
        if (!selection || !lifetime?.isCurrent() || lifetime.scope.serverId !== accountScope.serverId
            || lifetime.scope.accountId !== accountScope.accountId) return;
        fireAndForget(seedAndOpenProjectDraft({ selection, lifetime, navigate: navigateToOpen }), { tag: 'projects.openSource' });
    }, [accountScope, navigateToOpen]);

    const addSources = React.useMemo((): ProjectsAddMenuSources | null => {
        if (!accountScope) return null;
        const groups = groupProjectSources({ sources: sources.state.rows, accountId: accountScope.accountId, teamName });
        return {
            yours: groups.find(group => group.id === 'yours')?.sources ?? [],
            teams: groups.filter(group => group.id !== 'yours').map(group => ({ title: group.title, sources: group.sources })),
            onOpen: openSource,
            onManage: () => router.push('/projects/sources'),
        };
    }, [accountScope, openSource, router, sources.state.rows, teamName]);

    const saved = React.useMemo((): Readonly<{ items: readonly ProjectsTreeSavedItem[]; onOpen: (key: string) => void }> | null => {
        if (!accountScope) return null;
        const unopened = sources.state.rows.filter((source) => source.createdByAccountId === accountScope.accountId && !openedSourceIds.has(source.id));
        return {
            items: unopened.map((source) => ({ key: source.id, title: source.name, subtitle: describeProjectSourceRow(source) })),
            onOpen: (key: string) => {
                const source = unopened.find((candidate) => candidate.id === key);
                if (source) openSource(source);
            },
        };
    }, [accountScope, openSource, openedSourceIds, sources.state.rows]);

    const cloneRepository = React.useCallback(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) return;
        fireAndForget(seedAndOpenProjectDraft({ selection: { serverId: lifetime.scope.serverId }, lifetime,
            navigate: navigateToOpen }), { tag: 'projects.open' });
    }, [navigateToOpen]);

    return { addSources, saved, cloneRepository, sources: sources.state.rows, teamName, saveAsSource, saveSourceCreation,
        sourceCreation: sources, dismissSourceCreation: () => { creationTarget.current = null; sources.controller.discard(); } };
}
