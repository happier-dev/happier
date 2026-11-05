import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type {
  InstallableAutoUpdateMode,
  InstallableDepDataLike,
  InstallableRegistryEntry,
} from '@/capabilities/installablesRegistry';
import { isInstallableDepUpdateAvailable } from '@/capabilities/installablesUpdateAvailable';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { useInstallableDepInstall } from './useInstallableDepInstall';

export type MachineToolCapabilitiesStatus =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'error'
  | 'not-supported';

function readLatestVersion(
  status: InstallableDepDataLike | null,
): string | null {
  const check = status?.latestVersionCheck;
  return check && check.ok ? check.latestVersion : null;
}

/** The row's one state line: quiet when the tool is installed and current, otherwise what is true or next. */
function describeToolState(
  entry: InstallableRegistryEntry,
  status: InstallableDepDataLike | null,
  capabilities: MachineToolCapabilitiesStatus,
): string {
  const parts: string[] = [];
  if (entry.experimental)
    parts.push(t('machineDetailPage.toolsPage.experimental'));
  if (entry.subtitle) parts.push(entry.subtitle);
  const state = (() => {
    // The last answer stays readable while a check runs or the machine is away.
    if (status) {
      if (status.runtimeState === 'downloading')
        return t('deps.installable.downloading');
      // Not installed is said by its section (Can be installed), not by every row.
      if (!status.installed) return null;
      const latest = readLatestVersion(status);
      if (isInstallableDepUpdateAvailable(status) && latest)
        return t('machineDetailPage.toolsPage.versionAvailable', {
          version: latest,
        });
      return parts.length > 0 ? null : t('deps.ui.installed');
    }
    if (capabilities === 'loading')
      return t('machineDetailPage.toolsPage.checking');
    if (capabilities === 'not-supported')
      return t('deps.ui.notAvailableUpdateCli');
    if (capabilities === 'error')
      return t('machineDetailPage.toolsPage.cantCheck');
    if (capabilities === 'loaded') return null;
    return t('deps.ui.notAvailable');
  })();
  if (state) parts.push(state);
  return parts.join(' · ');
}

/** The open row's rows: hairlines only between them; the disclosure itself draws the line under the last. */
function ToolDetailRows(props: Readonly<{ children: React.ReactNode }>) {
  const rows = React.Children.toArray(props.children) as React.ReactElement<{ showDivider?: boolean }>[];
  return <>{rows.map((row, index) => React.cloneElement(row, { showDivider: index < rows.length - 1 }))}</>;
}

export type MachineToolRowProps = Readonly<{
  entry: InstallableRegistryEntry;
  machineId: string;
  serverId: string;
  status: InstallableDepDataLike | null;
  capabilitiesStatus: MachineToolCapabilitiesStatus;
  policy: Readonly<{
    autoInstallWhenNeeded: boolean;
    autoUpdateMode: InstallableAutoUpdateMode;
  }>;
  autoUpdateModeOptions: ReadonlyArray<
    SegmentedChoiceOption<InstallableAutoUpdateMode>
  >;
  onPolicyChange: (
    installableKey: string,
    patch: {
      autoInstallWhenNeeded?: boolean;
      autoUpdateMode?: InstallableAutoUpdateMode;
    },
  ) => void;
  refreshStatus: () => void;
  refreshLatestVersion?: () => void;
  showDivider: boolean;
}>;

/**
 * One tool on one machine (lab setup-over Tools): its mark, name and installed version, one state line, and one
 * action only when there is something to do (Install, Update). The row opens in place into how this tool installs
 * and updates, and the rarer facts (latest version, last install log, reinstall).
 */
export const MachineToolRow = React.memo(function MachineToolRow(
  props: MachineToolRowProps,
) {
  const { theme } = useUnistyles();
  const { entry, status, policy, onPolicyChange } = props;
  const [expanded, setExpanded] = React.useState(false);
  const { isInstalling, run } = useInstallableDepInstall({
    machineId: props.machineId,
    serverId: props.serverId,
    depId: entry.capabilityId,
    depStatus: status,
    refreshStatus: props.refreshStatus,
    refreshLatestVersion: props.refreshLatestVersion,
  });
  const testID = `machine-tool-${entry.key}`;
  const canAct = props.capabilitiesStatus === 'loaded' && !isInstalling;
  const installed = status?.installed === true;
  const updateAvailable = installed && isInstallableDepUpdateAvailable(status);
  const action = !installed
    ? props.capabilitiesStatus === 'loaded' || isInstalling
      ? t('common.install')
      : null
    : updateAvailable
      ? t('common.update')
      : null;
  const latestVersion = readLatestVersion(status);
  const latestCheck = status?.latestVersionCheck;

  const header = (headerProps: Readonly<Record<string, unknown>>) => (
    <Item
      {...headerProps}
      testID={testID}
      icon={
        <Icon
          name={entry.iconName as IconName}
          size={20}
          color={theme.colors.text.secondary}
        />
      }
      title={entry.title}
      titleStyle={status && !installed ? styles.dimTitle : undefined}
      titleAccessory={
        installed && status?.installedVersion ? (
          <Text style={styles.version}>{status.installedVersion}</Text>
        ) : undefined
      }
      subtitle={describeToolState(entry, status, props.capabilitiesStatus)}
      rightElementOutsidePressable
      showChevron={false}
      rightElement={
        <View style={styles.tail}>
          {action ? (
            <RoundButton
              testID={`${testID}.action`}
              size="small"
              display="secondary"
              title={action}
              loading={isInstalling}
              disabled={!canAct}
              onPress={() => {
                void run();
              }}
            />
          ) : null}
          <DisclosureCaret expanded={expanded} size={14} />
        </View>
      }
    />
  );

  return (
    <ExpandableItem
      testID={`${testID}.disclosure`}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={props.showDivider}
      header={({ headerProps }) =>
        header(headerProps as Readonly<Record<string, unknown>>)
      }
    >
      {expanded ? (
        <ToolDetailRows>
          <Item
            testID={`${testID}.autoInstall`}
            title={t('machineDetailPage.toolsPage.autoInstallTitle')}
            subtitle={t('machineDetailPage.toolsPage.autoInstallDescription')}
            rightElement={
              <Switch
                value={policy.autoInstallWhenNeeded}
                onValueChange={(next) =>
                  onPolicyChange(entry.key, { autoInstallWhenNeeded: next })
                }
              />
            }
            showChevron={false}
            onPress={() =>
              onPolicyChange(entry.key, {
                autoInstallWhenNeeded: !policy.autoInstallWhenNeeded,
              })
            }
          />
          <SegmentedChoiceItem<InstallableAutoUpdateMode>
            title={t('machineDetailPage.toolsPage.autoUpdateTitle')}
            options={props.autoUpdateModeOptions}
            value={policy.autoUpdateMode}
            onChange={(next) =>
              onPolicyChange(entry.key, { autoUpdateMode: next })
            }
            testIDPrefix={`machine-installables-auto-update-${entry.key}`}
          />
          {latestVersion && !updateAvailable ? (
            <Item
              title={t('deps.ui.latest')}
              subtitle={t('deps.ui.latestSubtitle', {
                version: latestVersion,
                tag:
                  (latestCheck?.ok ? latestCheck.label : null) ??
                  status?.sourceKind ??
                  '',
              })}
              showChevron={false}
            />
          ) : null}
          {latestCheck && !latestCheck.ok ? (
            <Item
              title={t('deps.ui.registryCheck')}
              subtitle={t('deps.ui.registryCheckFailed', {
                error: latestCheck.errorMessage,
              })}
              showChevron={false}
            />
          ) : null}
          {status?.lastInstallLogPath ? (
            <Item
              title={t('deps.ui.lastInstallLog')}
              subtitle={status.lastInstallLogPath}
              showChevron={false}
              onPress={() =>
                Modal.alert(
                  t('deps.ui.installLogTitle'),
                  status.lastInstallLogPath ?? '',
                )
              }
            />
          ) : null}
          {entry.setupUrl ? (
            <Item
              testID={`${testID}.setupGuide`}
              title={t('machineDetailPage.toolsPage.setupGuide')}
              subtitle={entry.setupUrl}
              onPress={() => void openExternalUrl(entry.setupUrl!)}
            />
          ) : null}
          {installed && !updateAvailable ? (
            <Item
              testID={`${testID}.reinstall`}
              title={entry.installLabels.reinstall}
              disabled={!canAct}
              showChevron={false}
              onPress={() => {
                if (canAct) void run();
              }}
            />
          ) : null}
        </ToolDetailRows>
      ) : null}
    </ExpandableItem>
  );
});

const styles = StyleSheet.create((theme) => ({
  tail: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10 },
  version: {
    ...Typography.mono(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
    marginLeft: theme.space.s6,
  },
  dimTitle: { color: theme.colors.text.secondary },
}));
