import * as React from 'react';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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

function setupRowKey(row: InstalledPluginSetupRow): string {
  switch (row.kind) {
    case 'connectedAccount':
      return `account:${row.service.pluginId}/${row.service.localId}`;
    case 'mcpSignIn':
      return `mcp:${row.serverId}`;
    case 'setting':
    case 'secret':
      return `${row.kind}:${row.fieldId}`;
    case 'machineRecipe':
      return `recipe:${row.ref.pluginId}/${row.ref.recipeId}`;
  }
}

/**
 * "Finish setting up" (lab ideas-1118-platform scene 2): what an installed plugin still needs, one configuration row
 * per need — the thing, its status, and the one action that opens the need's existing owner. Healthy is quiet: with
 * nothing left the section is absent. The first row's action leads; the rest stay secondary.
 */
export function PluginSetupSection(
  props: Readonly<{
    pluginId: string;
    host: PluginsSurfaceHost;
    projection: PluginProjectionV2 | null;
    machineId: string | null;
    serverId: string | null;
    settings?: readonly PluginSettingSetupObservation[];
    testID?: string;
  }>,
) {
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const { rows, open } = useInstalledPluginSetup({
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
  if (rows.length === 0) return null;
  const testID =
    props.testID ?? `settings.plugins.detail.${props.pluginId}.setup`;
  return (
    <ItemGroup testID={testID} title={t('settingsPlugins.surfaces.setupTitle')}>
      {rows.map((row, index) => {
        const presentation = presentSetupRow(row, localize);
        const key = setupRowKey(row);
        return (
          <Item
            key={key}
            testID={`${testID}.${key}`}
            icon={<Icon name={presentation.icon} />}
            title={presentation.title}
            subtitle={presentation.status}
            showChevron={false}
            mode="info"
            rightElement={
              <RoundButton
                testID={`${testID}.${key}.action`}
                size="small"
                display={index === 0 ? 'default' : 'secondary'}
                title={presentation.action}
                accessibilityLabel={`${presentation.action}: ${presentation.title}`}
                onPress={() => {
                  void open(row);
                }}
              />
            }
          />
        );
      })}
    </ItemGroup>
  );
}
