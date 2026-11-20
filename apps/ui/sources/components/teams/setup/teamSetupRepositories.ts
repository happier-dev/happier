import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import {
  readScmHostingRepositoryIdentity,
  sameScmHostingRepositoryIdentity,
} from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { ScmRepositoryDiscoverMatch } from '@happier-dev/protocol/scm/repositoryDiscovery';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import {
  buildProjectOpenDraft,
  buildProjectOpenInput,
  selectProjectOpenDiscoveredClone,
  suggestProjectOpenDestination,
  type ProjectOpenChoiceState,
} from '@/components/projects/activation/projectOpenChoices';

import type { TeamSetupRepository } from './teamSetupPlan';

export type TeamSetupRepositoryTarget = Readonly<{
  serverId: string;
  machineId: string;
  homeDir: string | null;
}>;

/**
 * One shared repository as the ordinary Open owner takes it: the member's registered checkout of the Source when
 * one exists, a clone they adopted through Find (attached as it is), or else a fresh clone into the suggested folder.
 */
export function buildTeamSetupRepository(
  source: ProjectSourceV1,
  target: TeamSetupRepositoryTarget,
  adoptedPath: string | null,
  checkout: WorkspaceRefV1 | null = null,
): TeamSetupRepository | null {
  const subject = { kind: 'source' as const, source };
  const base: ProjectOpenChoiceState = {
    serverId: target.serverId,
    machineId: target.machineId,
    machineHomeDir: target.homeDir,
    subject,
    ref: source.defaultRef ?? null,
    use: 'clone',
    branch: '',
    destination: '',
    checkouts: [],
  };
  let state: ProjectOpenChoiceState;
  if (checkout) {
    state = { ...base, use: 'existing', checkoutId: checkout.id, checkouts: [checkout] };
  } else if (adoptedPath) {
    state = selectProjectOpenDiscoveredClone(base, {
      rootPath: adoptedPath,
      repositoryIdentity: readSourceIdentity(source)!,
    });
  } else {
    const destination = suggestProjectOpenDestination(base);
    if (!destination) return null;
    state = { ...base, destination };
  }
  const input = buildProjectOpenInput(buildProjectOpenDraft(state), state.checkouts);
  if (!input) return null;
  const { serverId: _serverId, machineId: _machineId, ...rest } = input;
  return { id: source.id, input: rest };
}

function readSourceIdentity(source: Pick<ProjectSourceV1, 'repository'>) {
  return source.repository
    ? readScmHostingRepositoryIdentity({
        ...source.repository.provider,
        nameWithOwner: source.repository.repository.nameWithOwner,
      })
    : null;
}

/** Which discovered clone belongs to which shared repository; the SCM owner already normalized each origin. */
export function matchTeamSetupDiscoveredClones(
  sources: readonly Pick<ProjectSourceV1, 'id' | 'repository'>[],
  matches: readonly ScmRepositoryDiscoverMatch[],
): ReadonlyMap<string, string> {
  const adopted = new Map<string, string>();
  for (const source of sources) {
    const identity = readSourceIdentity(source);
    const match = matches.find((candidate) =>
      sameScmHostingRepositoryIdentity(identity, candidate.repositoryIdentity),
    );
    if (match) adopted.set(source.id, match.rootPath);
  }
  return adopted;
}
