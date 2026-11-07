import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectWorkspaceRefV1, type WorkspaceRefResolutionContextV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { RegistryCuration } from './useRegistrySuggestions';

export type RegistryProjectSuggestion = Readonly<{
    sourceId: string;
    item: RegistryCuration['curation'][number]['discovery']['items'][number];
    because: Readonly<{ kind: 'repository'; project: QualifiedProjectKeyV1;
        workspace: WorkspaceRefV1; repository: NonNullable<WorkspaceRefV1['repositoryIdentity']> }>;
}>;

/** Project accepted relationships only: no discovery, enrichment, authority or reads. */
export function matchRegistryProjectSuggestions(
    curation: RegistryCuration['curation'], project: QualifiedProjectKeyV1 | null,
    workspaceRefs: readonly WorkspaceRefV1[] | undefined,
    context: Pick<WorkspaceRefResolutionContextV1, 'normalizeServerId'> = {},
): readonly RegistryProjectSuggestion[] {
    if (!project || !workspaceRefs) return [];
    const server = context.normalizeServerId ?? ((id: string) => id);
    const facts = workspaceRefs.filter(workspace => {
        const anchor = projectWorkspaceRefV1(workspace);
        return server(anchor.serverId) === server(project.serverId) && anchor.projectKey === project.projectKey
            && workspace.repositoryIdentity !== undefined;
    });
    const seen = new Set<string>();
    const matches: RegistryProjectSuggestion[] = [];
    for (const page of curation) {
        const items = new Map(page.discovery.items.map(item => [item.id, item]));
        for (const mapping of page.discovery.suggestions ?? []) {
            const item = items.get(mapping.item);
            const workspace = facts.find(fact => fact.repositoryIdentity?.kind === mapping.because.hostingKind);
            if (!item || !workspace?.repositoryIdentity) continue;
            const identity = JSON.stringify(item.reference);
            if (seen.has(identity)) continue;
            seen.add(identity);
            matches.push({ sourceId: page.sourceId, item, because: { kind: 'repository', project,
                workspace, repository: workspace.repositoryIdentity } });
            // S40 Discover defines three authored suggestion slots; never pad them.
            if (matches.length === 3) return matches;
        }
    }
    return matches;
}
