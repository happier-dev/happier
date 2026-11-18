import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectPendingSharedSetupV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
  openProjectSharedSetupUpdate,
  type ProjectSharedSetupUpdateInput,
} from './ProjectSharedSetupUpdateSheet';

/** "adds 2 setup steps and 1 script": the pending setup's counts, in the order its owner lists them. */
export function describePendingSharedSetupSummary(
  summary: ProjectPendingSharedSetupV1['summary'],
): string {
  const parts = summary.map(({ kind, count }) =>
    t(`projects.scripts.pendingShared.kind.${kind}`, { count }),
  );
  if (parts.length <= 1) return parts[0] ?? '';
  return t('projects.scripts.filesList', {
    head: parts.slice(0, -1).join(', '),
    last: parts[parts.length - 1]!,
  });
}

const selectMachineName = (machine: Machine | null) =>
  machine ? getMachineSentenceName(machine) : null;

/**
 * A shared setup this checkout's Project has but has not taken (lab L6 hint): one row naming the
 * Source and what it adds, with Review opening the same review the update check uses, for first use.
 * Nothing is read upstream until Review.
 */
export function PendingSharedSetupRow(
  props: Readonly<{
    workspace: WorkspaceAddressV1;
    binding: ServerCredentialAccountScopeBinding | null;
    pending: ProjectPendingSharedSetupV1;
    decide: ProjectSharedSetupUpdateInput['decide'];
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const machineName =
    useServerScopedMachine(
      props.workspace.serverId,
      props.workspace.machineId,
      selectMachineName,
    ) ?? props.workspace.machineId;
  const adds = describePendingSharedSetupSummary(props.pending.summary);
  const { binding, workspace, pending, decide } = props;
  const review = React.useCallback(() => {
    if (!binding) return;
    openProjectSharedSetupUpdate({
      workspace,
      binding,
      sourceId: pending.source.id,
      sourceName: pending.source.name,
      machineName,
      decide,
      pending: true,
    });
  }, [
    binding,
    workspace,
    pending.source.id,
    pending.source.name,
    machineName,
    decide,
  ]);
  return (
    <Item
      testID={props.testID}
      icon={
        <Icon name="users" size={18} color={theme.colors.text.secondary} />
      }
      // Its own title beside the repository's Setup row; the shared layer's mark, as in the page header facts.
      title={t('projects.scripts.pendingShared.title')}
      subtitle={
        adds
          ? t('projects.scripts.pendingShared.line', {
              source: pending.source.name,
              adds,
            })
          : pending.source.name
      }
      subtitleLines={2}
      showChevron={false}
      rightElementOutsidePressable
      accessoryLayout="inline"
      rightElement={
        <RoundButton
          size="small"
          display="secondary"
          testID={`${props.testID}.review`}
          title={t('projects.widgets.scriptsReview')}
          disabled={!binding}
          onPress={review}
        />
      }
    />
  );
}
