import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Pages and lists resolve admitted provenance against the same authorized Source read. */
export function readProjectSourceLink(input: Readonly<{
    serverId: string;
    sourceId: string | null;
    source?: Readonly<{ serverId: string; source: ProjectSourceV1 }> | null;
}>): ProjectSourceV1 | null {
    return input.source?.source.id === input.sourceId
        && areServerProfileIdentifiersEquivalent(input.source.serverId, input.serverId) ? input.source.source : null;
}
