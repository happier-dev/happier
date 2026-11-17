import { TEAM_SHAREABLE_RESOURCE_KINDS_V1, type TeamShareableResourceKindV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';

import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import type { TranslationKeyNoParams } from '@/text';

export type TeamSharedKindPresentation = Readonly<{ icon: IconName; title: TranslationKeyNoParams; order: number }>;

/**
 * How each kind the summary owner reports reads, on the overview and on its own list. Keyed by the owner's enum,
 * so a new kind fails to compile here rather than disappearing; the order is the lab's (people, compute, content).
 */
export const TEAM_SHARED_KIND_PRESENTATION: Readonly<Record<TeamShareableResourceKindV1, TeamSharedKindPresentation>> = {
    sessions: { icon: 'chats-circle', title: 'teams.overview.shared.kinds.sessions', order: 0 },
    workflows: { icon: 'tree-structure', title: 'teams.overview.shared.kinds.workflows', order: 1 },
    discussions: { icon: 'chat-circle', title: 'teams.overview.shared.kinds.discussions', order: 2 },
    machines: { icon: 'hard-drives', title: 'teams.overview.shared.kinds.machines', order: 3 },
    machinePools: { icon: 'desktop', title: 'teams.overview.shared.kinds.machinePools', order: 4 },
    machinePresets: { icon: 'stack', title: 'teams.overview.shared.kinds.machinePresets', order: 5 },
    projectSources: { icon: 'git-branch', title: 'teams.overview.shared.kinds.projectSources', order: 6 },
    projectDocuments: { icon: 'file-text', title: 'teams.overview.shared.kinds.projectDocuments', order: 7 },
    prompts: { icon: 'note', title: 'teams.overview.shared.kinds.prompts', order: 8 },
    otherArtifacts: { icon: 'files', title: 'teams.overview.shared.kinds.otherArtifacts', order: 9 },
    accountCollections: { icon: 'squares-four', title: 'teams.overview.shared.kinds.accountCollections', order: 10 },
    savedSecrets: { icon: 'key', title: 'teams.overview.shared.kinds.savedSecrets', order: 11 },
    credentials: { icon: 'link', title: 'teams.overview.shared.kinds.credentials', order: 12 },
};

/** Kinds whose own list this Team page opens; Sessions and Credentials keep their shipped Team pages. */
export type TeamSharedListKind = Exclude<TeamShareableResourceKindV1, 'sessions' | 'credentials' | 'accountCollections'>;

const PAGE_ELSEWHERE = new Set<TeamShareableResourceKindV1>(['sessions', 'credentials', 'accountCollections']);
const LIST_KINDS: ReadonlySet<string> = new Set(TEAM_SHAREABLE_RESOURCE_KINDS_V1.filter(kind => !PAGE_ELSEWHERE.has(kind)));

export function readTeamSharedListKind(value: string | undefined): TeamSharedListKind | null {
    return value !== undefined && LIST_KINDS.has(value) ? value as TeamSharedListKind : null;
}
