import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import {
  FreshCopyRetiredNotice,
  FreshCopyRow,
} from '@/components/projects/workers/MachineProjectWorkSection';
import type {
  MachineFreshCopy,
  MachineFreshCopyNotice,
} from '@/components/projects/workers/useMachineFreshCopies';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAllMachines } from '@/sync/store/hooks';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { t } from '@/text';

/**
 * Dev-only: the Machine page's Fresh copies section in the removal states QA cannot reach without removing a
 * copy. It mounts the shipped row and notice owners with fixture data; nothing it shows issues an Action.
 * `?state=confirm` (default, press Remove… to see the choices), `retired` (removed, another Machine did not
 * answer), `refused` (the other Machine refused the dependency check) or `inUse`.
 */
export type FreshCopySpecimenState =
  | 'confirm'
  | 'retired'
  | 'refused'
  | 'inUse';

const noop = () => {};

export function FreshCopyStatesSpecimen(
  props: Readonly<{ state: FreshCopySpecimenState }>,
) {
  const serverId = useActiveServerSnapshot().serverId || '';
  const compact = useViewportClass() === 'compact';
  // A real Machine of this Account names the source and the Machine that did not answer.
  const machineIds = useAllMachines((machines) =>
    machines
      .map((machine) => machine.id)
      .slice(0, 2)
      .join('\n'),
  ) as string;
  const [
    targetMachineId = 'specimen-worker',
    sourceMachineId = targetMachineId,
  ] = machineIds.split('\n').filter(Boolean);
  const copy = React.useMemo<MachineFreshCopy>(() => {
    const source = {
      id: 'specimen-source',
      serverId,
      machineId: sourceMachineId,
      rootPath: '/Users/ada/code/harbor-api',
      label: 'harbor-api',
      createdAtMs: 1,
      projectKey: 'harbor-api',
    };
    const target = {
      id: 'specimen-target',
      serverId,
      machineId: targetMachineId,
      rootPath: '/home/ada/.happier/copies/harbor-api',
      label: 'harbor-api',
      createdAtMs: 1,
      projectKey: 'harbor-api',
    };
    return {
      relationship: {
        v: 1,
        relationshipId: 'specimen-copy',
        controllerMachineId: sourceMachineId,
        alphaWorkspaceRefId: source.id,
        betaWorkspaceRefId: target.id,
        mode: 'keep_synced',
        enabled: true,
        policy: {
          v: 1,
          selection: 'git_worktree',
          extraIgnorePatterns: [],
          extraIncludePatterns: [],
        },
      } as never,
      source: source as never,
      target: target as never,
      lastCleanSyncAtMs: Date.now() - 4 * 60_000,
      sizeBytes: 182_400_000,
      review: null,
      name: 'harbor-api',
      sourceRefId: source.id,
      sourceMachineId,
    };
  }, [serverId, sourceMachineId, targetMachineId]);
  const uncheckedMachineIds = React.useMemo(() => [sourceMachineId], [sourceMachineId]);
  const notice: MachineFreshCopyNotice | null =
    props.state === 'refused'
      ? {
          relationshipId: 'specimen-copy',
          targetRootPath: copy.target.rootPath,
          kind: 'failed',
          text: t('projectWorkers.removeFailed'),
          reason: t('workspaceSync.error.dependenciesUnavailable'),
          errorCode: 'workspace_sync_dependencies_unavailable',
          failureCause: {
            phase: 'workspace_sync.retirement.dependencies',
            errorClass: 'Error',
            errorCode: 'workspace_sync_dependencies_unavailable',
            httpStatus: null,
            nativeErrorCode: 'RPC_FORBIDDEN',
          },
        }
      : props.state === 'inUse'
        ? {
            relationshipId: 'specimen-copy',
            targetRootPath: copy.target.rootPath,
            kind: 'in_use',
            text: t('projectWorkers.removeInUse'),
            errorCode: 'workspace_sync_relationship_in_use',
            dependencies: [
              {
                operationId: 'specimen-run',
                workspaceRefId: 'specimen-target',
                state: 'running',
              },
            ],
          }
        : null;
  return (
    <ItemList testID="fresh-copy-states-specimen">
      <PageHeader
        title={t('projectWorkers.workSection')}
        description={t('projectWorkers.workSectionDetail')}
      />
      <ItemGroup
        surface="none"
        title={t('projectWorkers.freshCopies')}
        description={t('projectWorkers.freshCopiesDetail')}
      >
        {props.state === 'retired' ? (
          <FreshCopyRetiredNotice
            testID="fresh-copy-states.retired"
            serverId={serverId}
            onDismiss={noop}
            notice={{
              relationshipId: 'specimen-copy',
              targetRootPath: copy.target.rootPath,
              kind: 'retired',
              text: t('projectWorkers.copyDefinitionRetired'),
              uncheckedMachineIds,
            }}
          />
        ) : (
          <FreshCopyRow
            testID="fresh-copy-states.copy"
            serverId={serverId}
            machineName={t('machine.thisMachineInSentence')}
            copy={copy}
            compact={compact}
            busy={false}
            approvalId={null}
            notice={notice}
            onRemove={noop}
            onRefresh={noop}
          />
        )}
      </ItemGroup>
    </ItemList>
  );
}
