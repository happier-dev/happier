import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { t } from '@/text';

export type ProjectSourceGroup = Readonly<{ id: string; title: string; sources: readonly ProjectSourceV1[] }>;

export function readSourceTeamId(source: Readonly<{ audience?: ProjectSourceV1['audience'] }>): string | null {
    for (const grant of source.audience ?? []) {
        if (grant.principal.kind === 'team' || grant.principal.kind === 'group') return grant.principal.teamId;
    }
    return null;
}

/** The admitted catalog's grouping, shared by its rail and every Projects Add entrance. */
export function groupProjectSources(input: Readonly<{
    sources: readonly ProjectSourceV1[];
    accountId: string;
    teamName: (teamId: string) => string | null;
}>): readonly ProjectSourceGroup[] {
    const yours: ProjectSourceV1[] = [];
    const byTeam = new Map<string, ProjectSourceV1[]>();
    const shared: ProjectSourceV1[] = [];
    for (const source of input.sources) {
        if (source.createdByAccountId === input.accountId) { yours.push(source); continue; }
        const teamId = readSourceTeamId(source);
        if (teamId && input.teamName(teamId)) byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), source]);
        else shared.push(source);
    }
    return [
        ...(yours.length ? [{ id: 'yours', title: t('projects.sources.groupYours'), sources: yours }] : []),
        ...[...byTeam].map(([teamId, sources]) => ({ id: `team:${teamId}`, title: t('projects.sources.groupFrom', { team: input.teamName(teamId) ?? '' }), sources })),
        ...(shared.length ? [{ id: 'shared', title: t('projects.sources.groupShared'), sources: shared }] : []),
    ];
}
