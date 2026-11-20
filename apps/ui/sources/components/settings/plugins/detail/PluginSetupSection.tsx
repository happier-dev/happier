import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import {
  useCurrentUiContextLocalCommands,
  type CurrentUiContextLocalCommand,
} from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { StoreAddToPresetButton, type StorePresetChoice } from '@/components/store/presets/StoreAddToPreset';
import type { StorePresetDoorItem } from '@/components/store/presets/storePresetDoor';
import { t } from '@/text';

import type {
  InstalledPluginSetupRow,
  PluginSettingSetupObservation,
} from '../model/installedPluginSetup';
import type { PluginsSurfaceHost } from '../model/pluginsSurfaceRoutes';
import { useInstalledPluginSetup } from '../model/useInstalledPluginSetup';

type SetupRowPresentation = Readonly<{
  icon: IconName;
  title: string;
  status: string;
  action: string;
}>;

function presentSetupRow(
  row: InstalledPluginSetupRow,
  localize: (value: unknown) => string,
): SetupRowPresentation {
  switch (row.kind) {
    case 'connectedAccount':
      return {
        icon: 'user-circle',
        title:
          localize(row.title) ||
          t('settingsPlugins.surfaces.setupAccountFallback'),
        status: t('settingsPlugins.surfaces.setupNeedsAccount'),
        action: t('settingsPlugins.surfaces.setupConnect'),
      };
    case 'mcpSignIn':
      return {
        icon: 'plug',
        title: row.title,
        status: t('settingsPlugins.surfaces.setupNeedsSignIn'),
        action: t('settingsPlugins.surfaces.setupSignIn'),
      };
    case 'setting':
      return {
        icon: 'sliders-horizontal',
        title: localize(row.title),
        status: t('settingsPlugins.surfaces.setupNeedsValue'),
        action: t('settingsPlugins.surfaces.setupChoose'),
      };
    case 'secret':
      return {
        icon: 'key',
        title: localize(row.title),
        status: t('settingsPlugins.surfaces.setupNeedsSecret'),
        action: t('settingsPlugins.surfaces.setupChoose'),
      };
    case 'machineRecipe':
      return {
        icon: 'wrench',
        title:
          localize(row.title) ||
          t('settingsPlugins.surfaces.setupRecipeFallback'),
        status: t('settingsPlugins.surfaces.setupRecipeNotApplied'),
        action: t('settingsPlugins.surfaces.setupUseOnMachine'),
      };
  }
}

/**
 * "Finish setting up" (lab ideas-1118-platform scene 2, rounds 4–5): what an installed plugin still needs, one
 * configuration row per pending step — the thing, its status, "…" (Skip) and the one action that opens the step's
 * existing owner, so every action sits on the right edge. Steps already done or skipped collapse to quiet check
 * lines; progress reads beside the title. When every step is settled the section is one quiet line. The first
 * action leads; the rest stay secondary. Skip is also an agent command of the mounted page.
 */
export function PluginSetupSection(
  props: Readonly<{
    pluginId: string;
    /** The plugin's name, for the settled "is set up" line. */
    title: string;
    host: PluginsSurfaceHost;
    projection: PluginProjectionV2 | null;
    machineId: string | null;
    serverId: string | null;
    settings?: readonly PluginSettingSetupObservation[];
    /**
     * A recipe's second outcome (lab ideas-1118-platform round 4, "Use on a machine"): add it to a preset's Setup.
     * The host swaps in the one preset editor (`StorePresetEditorHandoff`), whose Save owns the write.
     */
    onAddToPreset?: (choice: StorePresetChoice, item: StorePresetDoorItem) => void;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const { rows, steps, progress, open, skip, recipeScope } = useInstalledPluginSetup({
    pluginId: props.pluginId,
    host: props.host,
    installed: true,
    projection: props.projection,
    machineId: props.machineId,
    serverId: props.serverId,
    ...(props.settings ? { settings: props.settings } : {}),
  });
  const localize = React.useCallback(
    (value: unknown) =>
      value === null || value === undefined
        ? ''
        : localizePluginText(props.pluginId, value),
    [localizePluginText, props.pluginId],
  );
  const skipCommands = React.useMemo<readonly CurrentUiContextLocalCommand[]>(
    () =>
      skip === null
        ? []
        : rows.map((row) => ({
            key: `plugin.setup.skip:${props.pluginId}:${row.id}`,
            title: `${t('settingsPlugins.surfaces.setupSkip')}: ${presentSetupRow(row, localize).title}`,
            invoke: () => skip(row),
          })),
    [localize, props.pluginId, rows, skip],
  );
  useCurrentUiContextLocalCommands(skipCommands, { contextKey: `plugin.setup:${props.pluginId}` });
  if (progress.total === 0) return null;
  const testID = props.testID ?? `settings.plugins.detail.${props.pluginId}.setup`;
  const settled = steps.filter((step) => step.status !== 'pending');
  if (rows.length === 0) {
    return (
      <View testID={`${testID}.complete`} style={styles.complete}>
        <Icon name="check-circle" color={theme.colors.state.success.foreground} />
        <Text variant="body" style={styles.completeText}>
          {t('settingsPlugins.surfaces.setupComplete', { name: props.title })}
        </Text>
      </View>
    );
  }
  return (
    <>
      <ItemGroup
        testID={testID}
        title={t('settingsPlugins.surfaces.setupTitle')}
        titleAccessory={
          <Text variant="meta" style={styles.progress} testID={`${testID}.progress`}>
            {t('settingsPlugins.surfaces.setupProgress', progress)}
          </Text>
        }
      >
        {rows.map((row, index) => {
          const presentation = presentSetupRow(row, localize);
          return (
            <Item
              key={row.id}
              testID={`${testID}.${row.id}`}
              icon={<Icon name={presentation.icon} />}
              title={presentation.title}
              subtitle={presentation.status}
              showChevron={false}
              mode="info"
              rightElement={
                <View style={styles.rowActions}>
                  {skip ? (
                    <ItemRowActions
                      title={presentation.title}
                      overflowOnly
                      overflowTriggerTestID={`${testID}.${row.id}.more`}
                      actions={[{ id: 'skip', title: t('settingsPlugins.surfaces.setupSkip'), icon: 'skip-forward',
                        onPress: () => skip(row) }]}
                    />
                  ) : null}
                  {row.kind === 'machineRecipe' && props.onAddToPreset ? (
                    // "Use on a machine" (lab ideas-1118-platform round 4): one control with the recipe's two outcomes,
                    // run it now on a chosen Machine (its Setup review) or add it to a preset's Setup (the preset editor).
                    <StoreAddToPresetButton
                      testID={`${testID}.${row.id}.use`}
                      size="small"
                      serverId={recipeScope?.serverId ?? null}
                      item={row.item}
                      name={presentation.title}
                      onChoose={(choice) => props.onAddToPreset?.(choice, row.item)}
                      runNow={{
                        title: presentation.action,
                        machinesTitle: t('settingsPlugins.surfaces.setupRunNow'),
                        presetsTitle: t('settingsPlugins.surfaces.setupAddToPresetSetup'),
                        onRun: (machineId) => { void open(row, presentation.title, machineId); },
                      }}
                    />
                  ) : (
                    <RoundButton
                      testID={`${testID}.${row.id}.action`}
                      size="small"
                      display={index === 0 ? 'default' : 'secondary'}
                      title={presentation.action}
                      accessibilityLabel={`${presentation.action}: ${presentation.title}`}
                      onPress={() => {
                        void open(row, presentation.title);
                      }}
                    />
                  )}
                </View>
              }
            />
          );
        })}
      </ItemGroup>
      {settled.length > 0 ? (
        <View style={styles.settled} testID={`${testID}.settled`}>
          {settled.map((step) => (
            <View key={step.id} style={styles.settledLine}>
              <Icon name="check" color={theme.colors.text.tertiary} />
              <Text variant="meta" style={styles.settledText} numberOfLines={1}>
                {step.status === 'skipped'
                  ? `${presentSetupRow(step, localize).title} · ${t('settingsPlugins.surfaces.setupSkipped')}`
                  : presentSetupRow(step, localize).title}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  progress: { color: theme.colors.text.secondary },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  // On the section's text edge, so the settled lines read as the section's own tail.
  settled: {
    paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s8,
    gap: theme.space.s4,
  },
  settledLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  settledText: { flexShrink: 1, color: theme.colors.text.secondary },
  complete: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
    paddingVertical: theme.space.s12,
  },
  completeText: { flexShrink: 1, color: theme.colors.text.primary },
}));
