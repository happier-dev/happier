import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  StreamStatusDot,
  resolveStreamStatusDotVariant,
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

/** One status phrase: the stream when it is not live, otherwise who controls the device. */
export function isSimulatorStreamLive(phase: SimulatorPreviewViewModel['stream']['phase']): boolean {
  return phase === 'playing' || phase === 'degraded';
}

/**
 * Who has the live device. Any other stream state is said once, on the stage (opening, connecting,
 * reconnecting over the held frame, failed), so the bar carries no second copy of it.
 */
export function resolveSimulatorStatusLabel(
  viewModel: SimulatorPreviewViewModel,
): string | null {
  if (!viewModel.controls.canWatch || !isSimulatorStreamLive(viewModel.stream.phase))
    return null;
  if (viewModel.controls.canControl)
    return t('streamPlayer.controls.controlling');
  if (viewModel.lease.state === 'held-by-other') {
    return viewModel.lease.holderLabel
      ? t('simulatorPreview.toolbar.heldByOtherWithHolder', {
          holder: viewModel.lease.holderLabel,
        })
      : t('simulatorPreview.toolbar.heldByOther');
  }
  return t('streamPlayer.status.playing');
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
  const statusLabel = resolveSimulatorStatusLabel(viewModel);
  const canTakeControl =
    leaseState === 'available' &&
    viewModel.controls.canWatch &&
    isSimulatorStreamLive(viewModel.stream.phase) &&
    resource.capture.status !== 'unavailable' &&
    resource.capture.inputMode !== 'none';

  const menuItems: DropdownMenuItem[] = [
    ...(viewModel.devices.length > 1
      ? viewModel.devices.map((entry) => ({
          id: `device:${entry.simulatorId}`,
          title: entry.label,
          subtitle: entry.platformLabel,
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

  const statusNode = statusLabel ? (
        <View
          style={simulatorStreamStyles.barStatus}
          testID={`${props.testID}-status`}
        >
          <StreamStatusDot
            variant={resolveStreamStatusDotVariant(
              viewModel.stream.phase,
              viewModel.stream.diagnostic?.reasonCode,
            )}
            testID={`${props.testID}-dot`}
          />
          <Text
            style={simulatorStreamStyles.barMeta}
            numberOfLines={1}
            testID={`${props.testID}-status-label`}
          >
            {statusLabel}
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
              if (id.startsWith('device:'))
                actions.selectDevice?.(id.slice('device:'.length));
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
