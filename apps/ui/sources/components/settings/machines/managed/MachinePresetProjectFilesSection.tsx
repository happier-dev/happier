import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import { createDefaultWorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { useProjectFilesChoices } from '@/components/machines/projectFiles/projectFilesChoices';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';
import {
  useWorkspaceContentPolicyRows,
  WorkspaceActivationContentPolicyRows,
} from '@/components/workspaces/activation/WorkspaceActivationEditor';
import {
  projectFilesOption,
  projectFilesOptionId,
  projectFilesValueForOption,
  type ProjectFilesOptionId,
} from '@/sync/domains/machines/projectFiles/projectFilesOptions';
import { t } from '@/text';

import { ManagedFieldRow } from './MachinePresetDetail';

/** One default policy object, so an unset preset's rows keep their identity across renders. */
const DEFAULT_CONTENT_POLICY = createDefaultWorkspaceContentPolicyV1();

/**
 * "Project files" on a preset (lab machine-sandboxes-1115 F1, round 4): one "How files get in" select, then the
 * chosen option's own settings as a group titled with its name. New Session can override it per session.
 */
export function MachinePresetProjectFilesSection(
  props: Readonly<{
    value: SessionProjectFilesV1 | undefined;
    /** Absent for a viewer who cannot manage the preset: the rows stay legible, their controls dimmed. */
    onChange?: (next: SessionProjectFilesV1) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { value, onChange } = props;
  const option = projectFilesOption(value);
  // Git clone stores a repository and branch the select alone can't name; a preset already cloning keeps it.
  const available = React.useCallback(
    (id: ProjectFilesOptionId) =>
      id !== 'git_clone' || value?.kind === 'git_clone',
    [value?.kind],
  );
  const choices = useProjectFilesChoices({ available });
  // An unset preset copies once with the default content policy; editing it stores that choice explicitly.
  const rows = useWorkspaceContentPolicyRows({
    policy:
      value?.kind === 'git_clone'
        ? null
        : (value?.contentPolicy ?? DEFAULT_CONTENT_POLICY),
    commitPatterns: 'endEditing',
    disabled: !onChange,
    testIdPrefix: `${props.testID}.content`,
    onChange: (contentPolicy) =>
      onChange?.(
        value && value.kind !== 'git_clone'
          ? { ...value, contentPolicy }
          : { kind: 'copy_once', contentPolicy },
      ),
  });
  const twoWay = projectFilesOptionId(value) === 'keep_both_in_sync';
  return (
    <>
      <ItemGroup
        testID={props.testID}
        title={t('machineDetailPage.projectFiles.title')}
        description={t('machineDetailPage.projectFiles.description')}
      >
        <ManagedFieldRow
          testID={`${props.testID}.how`}
          row={{
            title: t('machineDetailPage.projectFiles.how'),
            subtitle: t(option.subtitleKey),
            choices,
            value: option.id,
            disabled: !onChange,
            onChange: (id) => {
              const next = projectFilesValueForOption(
                id as ProjectFilesOptionId,
                value,
              );
              if (next && id !== projectFilesOptionId(value)) onChange?.(next);
            },
            // Only Two-way sync reaches back into the folder: one calm line says so (round 4 fix 3b).
            ...(twoWay
              ? {
                  note: (
                    <NoticeLine
                      testID={`${props.testID}.deletions`}
                      iconName="warning-circle"
                      wrap
                      iconColor={theme.colors.state.warning.foreground}
                      title={t(
                        'machineDetailPage.projectFiles.twoWayDeletions',
                      )}
                    />
                  ),
                }
              : {}),
          }}
        />
      </ItemGroup>
      <ItemGroup testID={`${props.testID}.option`} title={t(option.titleKey)}>
        {value?.kind === 'git_clone' ? (
          <>
            <Item
              testID={`${props.testID}.repository`}
              title={t('machineDetailPage.projectFiles.repository')}
              subtitle={value.source.repository.nameWithOwner}
              mode="info"
              showChevron={false}
            />
            <Item
              testID={`${props.testID}.branch`}
              title={t('machineDetailPage.projectFiles.branch')}
              subtitle={value.branch}
              mode="info"
              showChevron={false}
            />
          </>
        ) : (
          <>
            {twoWay ? (
              <Item
                testID={`${props.testID}.conflict`}
                title={t('machineDetailPage.projectFiles.conflict')}
                subtitle={t('machineDetailPage.projectFiles.conflictHelp')}
                subtitleLines={0}
                mode="info"
                showChevron={false}
              />
            ) : null}
            {rows ? <WorkspaceActivationContentPolicyRows {...rows} /> : null}
          </>
        )}
      </ItemGroup>
    </>
  );
}
