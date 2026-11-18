import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionProjectFilesSourceV1, SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useProjectFilesChoices } from '@/components/machines/projectFiles/projectFilesChoices';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  projectFilesOption,
  projectFilesOptionId,
  projectFilesValueForOption,
  type ProjectFilesOptionId,
} from '@/sync/domains/machines/projectFiles/projectFilesOptions';
import { useMachineField } from '@/sync/store/hooks';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

const CHANGE_DEFAULT = '__project-files-change-default';
const OPTIONS_CATEGORY = 'options';
const DEFAULT_CATEGORY = 'default';
/** The popover reads its four meanings side by side without wrapping each to a word (lab F2: 404 wide). */
const MENU_MAX_WIDTH = 404;

/** "Copies ~/code/happier", "Clones leeroy/happier at v0.3": what happens to the folder, as a verb phrase. */
function verbPhrase(
  value: SessionProjectFilesV1 | undefined,
  folder: string,
): string {
  if (value?.kind === 'git_clone') {
    // A clone that names its repository and branch says them; otherwise they are the folder's own.
    return value.source && value.branch
      ? t('machineDetailPage.projectFiles.clones', {
          repository: value.source.repository.nameWithOwner,
          branch: value.branch,
        })
      : t('machineDetailPage.projectFiles.clonesFolder', { folder });
  }
  if (value?.kind === 'sync') {
    return value.mode === 'keep_both_in_sync'
      ? t('machineDetailPage.projectFiles.syncsBothWays', { folder })
      : t('machineDetailPage.projectFiles.syncsOneWay', { folder });
  }
  return t('machineDetailPage.projectFiles.copies', { folder });
}

/**
 * The outcome line's verb phrase (lab machine-sandboxes-1115 F2): it names what happens to the folder and is the
 * one place to change that for this Session. Its menu lists the option owner's choices with Default and Advanced,
 * and leads to the preset for a lasting change. Choosing the preset's own option clears the override.
 */
export function ProjectFilesOutcomeChoice(
  props: Readonly<{
    testID: string;
    /** The selected folder on its Machine; absent before one is chosen. */
    source: SessionProjectFilesSourceV1 | undefined;
    presetDefault: SessionProjectFilesV1 | undefined;
    override: SessionProjectFilesV1 | undefined;
    onChange: (value: SessionProjectFilesV1 | undefined) => void;
    /** The preset whose default this is; absent until it is read. */
    preset: Readonly<{ serverId: string; id: string; name: string }> | null;
  }>,
) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // The folder as the composer's folder chip names it: home-relative on its own Machine.
  const homeDir = useMachineField(props.source?.target.machineId ?? '', 'metadata', 'homeDir',
    { enabled: props.source !== undefined, serverId: props.source?.target.serverId ?? null });
  const folder = props.source ? formatPathRelativeToHome(props.source.directory, homeDir,
    // The home folder itself reads in words in a sentence, never as a bare ~.
    { homeLabel: t('machineDetailPage.projectFiles.homeFolder') }) : null;
  const effective = props.override ?? props.presetDefault;
  const defaultId = projectFilesOptionId(props.presetDefault);
  const effectiveId = projectFilesOptionId(effective);
  const choices = useProjectFilesChoices();
  const presetName =
    props.preset?.name ?? t('machineDetailPage.isolation.summary.unnamed');
  const items = React.useMemo<DropdownMenuItem[]>(
    () => [
      // A menu hung from a link (not a field) checks its current choice itself.
      ...choices.map((choice) => ({ ...choice, category: OPTIONS_CATEGORY, checked: choice.id === effectiveId })),
      ...(props.preset
        ? [
            {
              id: CHANGE_DEFAULT,
              category: DEFAULT_CATEGORY,
              testID: `${props.testID}.change-default`,
              title: t('machineDetailPage.projectFiles.changeDefault', {
                preset: presetName,
              }),
            },
          ]
        : []),
    ],
    [choices, effectiveId, presetName, props.preset, props.testID],
  );
  const label = verbPhrase(
    effective,
    folder ?? t('machineDetailPage.projectFiles.yourFolder'),
  );
  const description = t(projectFilesOption(props.presetDefault).forSessionKey, {
    preset: presetName,
  });
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      variant="selectable"
      search={false}
      rowKind="item"
      selectedId={effectiveId}
      items={items}
      showCategoryTitles={false}
      separateCategories
      matchTriggerWidth={false}
      maxWidthCap={MENU_MAX_WIDTH}
      placement="bottom"
      popoverAnchorAlign="start"
      popoverPhonePresentation="sheet"
      popoverSheetHeader="none"
      popoverAccessibilityLabel={t('machineDetailPage.projectFiles.title')}
      header={
        <View style={styles.header}>
          <Text variant="label" emphasis="semiBold" accessibilityRole="header">
            {t('machineDetailPage.projectFiles.title')}
          </Text>
          <Text style={styles.description}>{description}</Text>
        </View>
      }
      onSelect={(id) => {
        setOpen(false);
        if (id === CHANGE_DEFAULT) {
          if (!props.preset) return;
          const href = `/settings/machines/presets/${encodeURIComponent(props.preset.id)}?serverId=${encodeURIComponent(props.preset.serverId)}`;
          const result = runGuardedNavigation(() => router.push(href as never));
          if (result !== true)
            fireAndForget(result, {
              tag: 'ProjectFilesOutcomeChoice.changeDefault',
            });
          return;
        }
        const chosen = id as ProjectFilesOptionId;
        if (chosen === defaultId) return props.onChange(undefined);
        const next = projectFilesValueForOption(chosen, effective);
        if (next) props.onChange(next);
      }}
      trigger={({ toggle }) => (
        <TextLinkButton
          testID={`${props.testID}.trigger`}
          label={label}
          onPress={toggle}
          expanded={open}
          tone="quiet"
          size="meta"
        />
      )}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    // On the rows' own text edge (`MENU_ROW_METRICS`), above the choices it explains.
    paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s4,
    rowGap: theme.space.s2,
  },
  description: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
