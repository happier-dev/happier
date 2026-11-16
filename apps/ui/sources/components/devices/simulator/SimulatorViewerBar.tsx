import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  StreamStatusDot,
  resolveStreamStatusDotVariant,
  type StreamStatusDotVariant,
} from '@/components/stream/StreamStatusDot';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import { t } from '@/text';

import { simulatorStreamStyles } from './styles';
import { resolveSimulatorVideoUnsupportedReason } from './videoSupport';

export function isSimulatorStreamLive(phase: SimulatorPreviewViewModel['stream']['phase']): boolean {
  return phase === 'playing' || phase === 'degraded';
}

export type SimulatorBarStatus = Readonly<{ label: string; variant: StreamStatusDotVariant }>;

/**
 * The bar's one status. A browser that cannot play the video says so as a typed cause; otherwise only
 * a live device has a status here (who has it). Opening, connecting, reconnecting and failures are
 * said once, on the stage, so the bar carries no second copy of them.
 */
export function resolveSimulatorBarStatus(
  viewModel: SimulatorPreviewViewModel,
): SimulatorBarStatus | null {
  if (viewModel.controls.canWatch && resolveSimulatorVideoUnsupportedReason(viewModel.stream)) {
    return { label: t('simulatorPreview.device.videoUnsupported'), variant: 'error' };
  }
  if (!viewModel.controls.canWatch || !isSimulatorStreamLive(viewModel.stream.phase))
    return null;
  const variant = resolveStreamStatusDotVariant(viewModel.stream.phase, viewModel.stream.diagnostic?.reasonCode);
  if (viewModel.controls.canControl)
    return { label: t('streamPlayer.controls.controlling'), variant };
  if (viewModel.lease.state === 'held-by-other') {
    return {
      label: viewModel.lease.holderLabel
        ? t('simulatorPreview.toolbar.heldByOtherWithHolder', { holder: viewModel.lease.holderLabel })
        : t('simulatorPreview.toolbar.heldByOther'),
      variant,
    };
  }
  return { label: t('streamPlayer.status.playing'), variant };
}

/**
 * The viewer bar: the device and its platform first, then its one status, then the one primary action
 * (take or release control) and the on-demand Tools. Switching device and the rare control actions live
 * in the "…" menu.
 */
export function SimulatorViewerBar(
  props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    toolsOpen: boolean;
    onToggleTools: () => void;
    /** Offered on a narrow pane: hand the whole pane to the device screen. */
    onHideControls?: () => void;
    /** A narrow pane: the bar takes two rows so the device name never truncates to a letter. */
    stacked?: boolean;
    /** Boot a stopped device chosen from the switch list. */
    onStartDevice: (simulatorId: string) => void;
    /** Power the open device off (distinct from closing the viewer). */
    onPowerOff: () => void;
    powerOffPending: boolean;
    testID: string;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { viewModel, actions } = props;
  const resource = viewModel.resource;
  if (!resource) return null;
  const device = viewModel.devices.find(
    (entry) => entry.simulatorId === resource.simulatorId,
  );
  const platformLabel = device?.platformLabel;
  const leaseState = viewModel.lease.state;
  const status = resolveSimulatorBarStatus(viewModel);
  const canTakeControl =
    leaseState === 'available' &&
    viewModel.controls.canWatch &&
    isSimulatorStreamLive(viewModel.stream.phase) &&
    !resolveSimulatorVideoUnsupportedReason(viewModel.stream) &&
    resource.capture.status !== 'unavailable' &&
    resource.capture.inputMode !== 'none';

  const menuItems: DropdownMenuItem[] = [
    ...(viewModel.devices.length > 1
      ? viewModel.devices.map((entry) => ({
          id: `device:${entry.simulatorId}`,
          title: entry.label,
          subtitle: entry.state === 'stopped'
            ? `${entry.platformLabel} · ${t('simulatorPreview.device.stopped')}`
            : entry.platformLabel,
          disabled: entry.state === 'stopped' && !entry.canBoot,
          category: t('simulatorPreview.viewer.switchDevice'),
          checked: entry.simulatorId === resource.simulatorId,
          testID: `${props.testID}-device:${entry.simulatorId}`,
        }))
      : []),
    ...(leaseState === 'held-by-me'
      ? [
          {
            id: 'renew',
            title: t('simulatorPreview.toolbar.renewControl'),
            testID: `${props.testID}-renew-lease`,
          },
        ]
      : []),
    ...(viewModel.controls.deviceOperations.includes('power_off')
      ? [
          {
            id: 'power-off',
            title: t('simulatorPreview.device.powerOff'),
            destructive: true,
            loading: props.powerOffPending,
            testID: `${props.testID}-power-off`,
          },
        ]
      : []),
    ...(props.onHideControls
      ? [
          {
            id: 'hide-controls',
            title: t('simulatorPreview.viewer.hideControls'),
            testID: `${props.testID}-hide-controls`,
          },
        ]
      : []),
  ];

  const statusNode = status ? (
    <View style={simulatorStreamStyles.barStatus} testID={`${props.testID}-status`}>
      <StreamStatusDot variant={status.variant} testID={`${props.testID}-dot`} />
      <Text style={simulatorStreamStyles.barMeta} numberOfLines={1} testID={`${props.testID}-status-label`}>
        {status.label}
      </Text>
    </View>
  ) : null;
  const primaryNode = canTakeControl ? (
          <RoundButton
            size="small"
            title={t('simulatorPreview.toolbar.acquireControl')}
            disabled={!viewModel.controls.canWatch}
            onPress={() => {
              void actions.acquireLease?.();
            }}
            testID={`${props.testID}-acquire-lease`}
          />
        ) : leaseState === 'held-by-me' ? (
          <RoundButton
            size="small"
            display="secondary"
            title={t('simulatorPreview.toolbar.releaseControl')}
            onPress={() => {
              void actions.releaseLease?.();
            }}
            testID={`${props.testID}-release-lease`}
          />
        ) : null;
  const identityNode = (
      <View style={simulatorStreamStyles.barIdentity}>
        <Icon
          name="device-mobile"
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
        <Text
          style={simulatorStreamStyles.barTitle}
          numberOfLines={1}
          testID={`${props.testID}-title`}
        >
          {resource.displayName}
        </Text>
        {platformLabel ? (
          <Text style={simulatorStreamStyles.barMeta} numberOfLines={1}>
            {platformLabel}
          </Text>
        ) : null}
      </View>
  );
  const trailingNode = (
    <View style={simulatorStreamStyles.barActions}>
        <IconButton
          testID={`${props.testID}-tools`}
          iconName="wrench"
          variant="plain"
          selected={props.toolsOpen}
          expanded={props.toolsOpen}
          accessibilityLabel={
            props.toolsOpen
              ? t('simulatorPreview.viewer.closeTools')
              : t('simulatorPreview.viewer.tools')
          }
          tooltip={
            props.toolsOpen
              ? t('simulatorPreview.viewer.closeTools')
              : t('simulatorPreview.viewer.tools')
          }
          onPress={props.onToggleTools}
        />
        {menuItems.length > 0 ? (
          <DropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={menuItems}
            showCategoryTitles
            onSelect={(id) => {
              setMenuOpen(false);
              if (id.startsWith('device:')) {
                const simulatorId = id.slice('device:'.length);
                const target = viewModel.devices.find((entry) => entry.simulatorId === simulatorId);
                if (target?.state === 'stopped') props.onStartDevice(simulatorId);
                else actions.selectDevice?.(simulatorId);
              }
              else if (id === 'power-off') props.onPowerOff();
              else if (id === 'renew') void actions.renewLease?.();
              else if (id === 'hide-controls') props.onHideControls?.();
            }}
            matchTriggerWidth={false}
            popoverAnchorAlign="end"
            trigger={({ toggle }) => (
              <IconButton
                testID={`${props.testID}-more`}
                variant="plain"
                iconName="dots-three"
                iconSize={ICON_SIZE.md}
                accessibilityLabel={t('simulatorPreview.viewer.more')}
                onPress={toggle}
              />
            )}
          />
        ) : null}
    </View>
  );

  if (props.stacked) {
    // A phone keeps the device's name whole: state and the primary action move beneath it.
    return (
      <View testID={props.testID} style={simulatorStreamStyles.barStacked}>
        <View style={simulatorStreamStyles.barRow}>
          {identityNode}
          {trailingNode}
        </View>
        {statusNode || primaryNode ? (
          <View style={simulatorStreamStyles.barRow}>
            {statusNode ?? <View />}
            {primaryNode}
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View testID={props.testID} style={simulatorStreamStyles.bar}>
      {identityNode}
      {statusNode}
      <View style={simulatorStreamStyles.barActions}>
        {primaryNode}
        {trailingNode}
      </View>
    </View>
  );
}
