import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type ProjectSourceRepositoryFacts = Readonly<{ status: 'unknown' }>
    | Readonly<{ status: 'observed'; observation: NonNullable<WorkspaceRefV1['repositoryObservation']> }>;
const UNKNOWN: ProjectSourceRepositoryFacts = Object.freeze({ status: 'unknown' });

/** Latest observed exact Source revision in this Home's opened private checkout census; no freshness claim. */
export function projectSourceRepositoryFacts(serverId: string, sources: readonly ProjectSourceV1[],
    workspaceRefs: readonly WorkspaceRefV1[] | undefined): ReadonlyMap<string, ProjectSourceRepositoryFacts> {
    const current = new Map(sources.map(source => [source.id, source.revision]));
    const result = new Map<string, ProjectSourceRepositoryFacts>(sources.map(source => [source.id, UNKNOWN]));
    for (const ref of workspaceRefs ?? []) {
        const observation = ref.repositoryObservation;
        if (!areServerProfileIdentifiersEquivalent(ref.serverId, serverId) || !ref.source || !observation
            || observation.source.sourceId !== ref.source.sourceId || observation.source.revision !== ref.source.revision
            || current.get(ref.source.sourceId) !== ref.source.revision) continue;
        const previous = result.get(ref.source.sourceId);
        if (previous?.status !== 'observed' || observation.observedAtMs > previous.observation.observedAtMs) {
            result.set(ref.source.sourceId, { status: 'observed', observation });
        }
    }
    return result;
}
