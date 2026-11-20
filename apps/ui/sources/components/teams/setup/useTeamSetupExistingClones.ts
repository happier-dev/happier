import * as React from 'react';
import { ScmRepositoryDiscoverResponseSchema } from '@happier-dev/protocol/scm/repositoryDiscovery';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { buildProjectOpenCloneDiscoveryRequest } from '@/components/projects/activation/projectOpenChoices';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

import { matchTeamSetupDiscoveredClones } from './teamSetupRepositories';
import type { TeamSetupActionContext } from './teamSetupPlan';

export type TeamSetupExistingClones = Readonly<{
  /** Null while no Machine is chosen: the search runs on that Machine only. */
  onFind: (() => void) | null;
  searching: boolean;
  folder: string | null;
  adopted: ReadonlyMap<string, string>;
  failure: string | null;
}>;

type SearchState = Readonly<{
  machineId: string;
  folder: string;
  searching: boolean;
  adopted: ReadonlyMap<string, string>;
  failure: string | null;
}>;

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * Find existing clones (plan D-F4): one person-chosen folder, one `scm.repository.discover` read of its immediate
 * children on the chosen Machine. Matches become attach choices for the ordinary Open owner; nothing scans in the
 * background and nothing is written to Git.
 */
export function useTeamSetupExistingClones(
  input: Readonly<{
    execute: FrontDoorActionExecute;
    context: TeamSetupActionContext;
    machineId: string | null;
    homeDir: string | null;
    sources: readonly ProjectSourceV1[];
  }>,
): TeamSetupExistingClones {
  const { execute, context, machineId, homeDir, sources } = input;
  const [search, setSearch] = React.useState<SearchState | null>(null);
  const current = search && search.machineId === machineId ? search : null;
  const sourcesRef = React.useRef(sources);
  sourcesRef.current = sources;
  const onFind = React.useCallback(async () => {
    if (!machineId) return;
    const folder = await openMachinePathBrowserModal({
      machineId,
      serverId: context.serverId,
      title: t('teams.join.setupPage.findClones'),
      initialPath: current?.folder ?? homeDir,
    });
    if (!folder) return;
    setSearch({
      machineId,
      folder,
      searching: true,
      adopted: NONE,
      failure: null,
    });
    const settle = (
      next: Omit<SearchState, 'machineId' | 'folder' | 'searching'>,
    ) =>
      setSearch((previous) =>
        previous?.machineId === machineId && previous.folder === folder
          ? { ...previous, ...next, searching: false }
          : previous,
      );
    const result = await execute(
      'scm.repository.discover',
      buildProjectOpenCloneDiscoveryRequest({
        folderPath: folder,
        sources: sourcesRef.current,
      }),
      { ...context, externalActionTarget: { kind: 'machine', machineId } },
    );
    if (!result.ok) {
      settle({ adopted: NONE, failure: result.error });
      return;
    }
    const parsed = ScmRepositoryDiscoverResponseSchema.safeParse(result.result);
    if (!parsed.success) {
      settle({ adopted: NONE, failure: t('common.unavailable') });
      return;
    }
    if (!parsed.data.success) {
      settle({ adopted: NONE, failure: parsed.data.error });
      return;
    }
    settle({
      adopted: matchTeamSetupDiscoveredClones(
        sourcesRef.current,
        parsed.data.matches,
      ),
      failure: null,
    });
  }, [context, current?.folder, execute, homeDir, machineId]);
  return React.useMemo(
    () => ({
      onFind: machineId
        ? () => {
            void onFind();
          }
        : null,
      searching: current?.searching ?? false,
      folder: current?.folder ?? null,
      adopted: current?.adopted ?? NONE,
      failure: current?.failure ?? null,
      }),
    [current, machineId, onFind],
  );
}
