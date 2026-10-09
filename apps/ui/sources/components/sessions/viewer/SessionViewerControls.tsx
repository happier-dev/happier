import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';

/** The floating capsules' height and inner padding (the frame's controls band). */
const CAPSULE_HEIGHT = 32;
const CAPSULE_RADIUS = CAPSULE_HEIGHT / 2;
const CAPSULE_PADDING = 3;
const GLASS_BUTTON = CAPSULE_HEIGHT - CAPSULE_PADDING * 2;

const stylesheet = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  capsule: {
    height: CAPSULE_HEIGHT,
    padding: CAPSULE_PADDING,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  identity: {
    height: CAPSULE_HEIGHT,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  identityText: {
    ...Typography.rowMeta(),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
}));

export type SessionViewerFrameCommands = Readonly<{
  moveToCorner: (corner: 'tl' | 'tr' | 'bl' | 'br') => void;
  resize: (direction: 'larger' | 'smaller') => void;
}>;

/**
 * The viewer's floating controls (lab `b-watch`): the source switch and the actual Machine on the
 * left, Expand/Restore, Close and the view menu on the right, each a capsule on the floating glass
 * material. Semantic choices go through the Session's viewer owner (the same front door as
 * `session.presentation.apply`); corners and size are its local geometry controls.
 */
export function SessionViewerControls(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    source: SessionViewerSource;
    frame?: SessionViewerFrameCommands;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const controller = useOptionalSessionViewerController();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const machineId =
    useSessionMachineTarget(props.sessionId, props.serverId)?.machineId ?? null;
  const machine = useMachine(machineId ?? '', machineId !== null);
  if (!controller) return null;
  const { apply, canPresentSource } = controller;
  const facts = controller.facts[props.source];
  const machineName =
    facts?.machineName ?? getMachineDisplayName(machine) ?? machineId ?? '';
  const online = machine ? isMachineOnline(machine) : false;
  const expanded = controller.state.mode === 'expanded';
  const sourceLabel = (source: SessionViewerSource) =>
    t(
      source === 'computer'
        ? 'computerUse.viewer.sourceComputer'
        : 'computerUse.viewer.sourceBrowser',
    );

  const menuItems: DropdownMenuItem[] = [];
  if (props.source === 'computer' && facts?.chooseTarget) {
    menuItems.push({
      id: 'choose',
      title: t('computerUse.request.change'),
      testID: 'session-viewer-menu-choose',
    });
  }
  if (!controller.phone && !expanded && props.frame) {
    menuItems.push(
      { id: 'tl', title: t('computerUse.viewer.moveTopLeft') },
      { id: 'tr', title: t('computerUse.viewer.moveTopRight') },
      { id: 'bl', title: t('computerUse.viewer.moveBottomLeft') },
      { id: 'br', title: t('computerUse.viewer.moveBottomRight') },
      { id: 'larger', title: t('computerUse.viewer.larger') },
      { id: 'smaller', title: t('computerUse.viewer.smaller') },
    );
  }
  if (!controller.phone) {
    menuItems.push({
      id: 'dock',
      title: t('computerUse.viewer.dockView'),
      testID: 'session-viewer-menu-dock',
    });
  }
  if (props.source === 'computer' && facts?.stopSharing) {
    menuItems.push({
      id: 'stop',
      title: t('computerUse.picker.stopSharing'),
      destructive: true,
      testID: 'session-viewer-menu-stop',
    });
  }
  const onSelect = (id: string) => {
    setMenuOpen(false);
    if (id === 'choose') facts?.chooseTarget?.();
    else if (id === 'stop') facts?.stopSharing?.();
    else if (id === 'dock') apply({ kind: 'viewer.dock' });
    else if (id === 'larger' || id === 'smaller') props.frame?.resize(id);
    else if (id === 'tl' || id === 'tr' || id === 'bl' || id === 'br')
      props.frame?.moveToCorner(id);
  };

  return (
    <View style={stylesheet.row}>
      <GlassPanel
        radius={CAPSULE_RADIUS}
        shadowLevel={2}
        innerShadow={false}
        style={stylesheet.capsule}
      >
        <SegmentedTabBar
          presentation="plain"
          compact
          segmentSizing="content"
          accessibilityLabel={t('computerUse.viewer.sourceA11y')}
          testIDPrefix="session-viewer-source"
          activeTabId={props.source}
          onSelectTab={(source) => {
            apply({ kind: 'viewer.source.select', source });
          }}
          tabs={(['computer', 'browser'] as const).map((source) => ({
            id: source,
            label: sourceLabel(source),
            icon: (
              <Icon
                name={source === 'computer' ? 'desktop' : 'globe'}
                size={ICON_SIZE.sm}
                color={theme.colors.text.secondary}
              />
            ),
            disabled: !canPresentSource(source),
          }))}
        />
      </GlassPanel>
      {machineName ? (
        <GlassPanel
          radius={CAPSULE_RADIUS}
          shadowLevel={2}
          innerShadow={false}
          style={stylesheet.identity}
          frameStyle={{ flexShrink: 1, minWidth: 0 }}
          testID="session-viewer-machine"
        >
          <StatusDot
            size={7}
            color={
              online
                ? theme.colors.status.connected
                : theme.colors.status.disconnected
            }
          />
          <Text style={stylesheet.identityText} numberOfLines={1}>
            {machineName}
          </Text>
        </GlassPanel>
      ) : null}
      <View style={stylesheet.grow} />
      <GlassPanel
        radius={CAPSULE_RADIUS}
        shadowLevel={2}
        innerShadow={false}
        style={stylesheet.capsule}
      >
        <IconButton
          testID="session-viewer-expand"
          variant="plain"
          size={GLASS_BUTTON}
          iconName={expanded ? 'arrows-in' : 'arrows-out'}
          accessibilityLabel={t(
            expanded
              ? 'computerUse.viewer.restoreView'
              : 'computerUse.viewer.expandView',
          )}
          tooltip={t(
            expanded
              ? 'computerUse.viewer.restoreView'
              : 'computerUse.viewer.expandView',
          )}
          onPress={() => {
            apply({ kind: expanded ? 'viewer.restore' : 'viewer.expand' });
          }}
        />
        {menuItems.length > 0 ? (
          <DropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={menuItems}
            onSelect={onSelect}
            matchTriggerWidth={false}
            popoverAnchorAlign="end"
            trigger={({ toggle }) => (
              <IconButton
                testID="session-viewer-more"
                variant="plain"
                size={GLASS_BUTTON}
                iconName="dots-three"
                accessibilityLabel={t('computerUse.viewer.viewOptions')}
                tooltip={t('computerUse.viewer.viewOptions')}
                onPress={toggle}
              />
            )}
          />
        ) : null}
        <IconButton
          testID="session-viewer-close"
          variant="plain"
          size={GLASS_BUTTON}
          iconName="x"
          accessibilityLabel={t('computerUse.viewer.closeView')}
          accessibilityHint={t('computerUse.viewer.closeHint')}
          tooltip={t('computerUse.viewer.closeView')}
          onPress={() => {
            apply({ kind: 'viewer.close' });
          }}
        />
      </GlassPanel>
    </View>
  );
}
