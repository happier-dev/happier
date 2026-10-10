import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE,
  HAPPIER_CONTROL_CAPSULE_METRICS,
  HappierControlCapsule,
  HappierIdentityCapsule,
} from '@happier-dev/plugin-ui/presentation';

import {
  ComputerTargetPickerModal,
  computerTargetPickerProps,
  type ComputerTargetPickerRequest,
} from '@/components/computer/showComputerTargetPicker';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { CORE_CAPSULE_HOST, useCoreCapsuleColors } from '@/components/ui/status/capsuleHost';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';
import { useSessionViewerMachine } from './useSessionViewerMachine';

/** The gap between the frame's floating capsules. */
const ROW_GAP = 6;
/** The anchored source picker's width (lab `b-mac` `.fa-srcpop`), never wider than the window allows. */
const SOURCE_PICKER_WIDTH = 360;

const stylesheet = StyleSheet.create(() => ({
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  identity: {
    flexShrink: 1,
    minWidth: 0,
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
 * `session.presentation.apply`); corners and size are its local geometry controls. Pressing the
 * current Computer source opens its window/display picker anchored to the switch (lab `b-mac` A).
 */
export function SessionViewerControls(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    source: SessionViewerSource;
    frame?: SessionViewerFrameCommands;
    /** The narrowest row these controls fit in (the source switch and the buttons side by side). */
    onMinWidthChange?: (width: number) => void;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const controller = useOptionalSessionViewerController();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [picker, setPicker] =
    React.useState<ComputerTargetPickerRequest | null>(null);
  const sourceAnchorRef = React.useRef<View | null>(null);
  const widthsRef = React.useRef({ source: 0, buttons: 0 });
  const onMinWidthChange = props.onMinWidthChange;
  const measure = React.useCallback(
    (part: 'source' | 'buttons') => (event: LayoutChangeEvent) => {
      widthsRef.current[part] = event.nativeEvent.layout.width;
      const { source, buttons } = widthsRef.current;
      if (source > 0 && buttons > 0)
        onMinWidthChange?.(Math.ceil(source + buttons + ROW_GAP));
    },
    [onMinWidthChange],
  );
  const { name: machineName, online } = useSessionViewerMachine(
    props.sessionId,
    props.serverId,
    props.source,
  );
  const capsuleColors = useCoreCapsuleColors();
  if (!controller) return null;
  const { apply, requestSemantic, canPresentSource } = controller;
  const facts = controller.facts[props.source];
  // A finger gets the platform's touch target height around each drawn button without the capsule
  // or the controls band growing: the press frame overhangs the capsule (its material is a backing,
  // not a clip). Sideways each button takes its full share of the capsule, half of each gap and the
  // capsule's padding at the ends, so the targets tile it edge to edge and never overlap.
  const touchFloor = resolveTouchTargetFloorPx() ?? undefined;
  const { padding: capsuleEnd, gap: capsuleGap } = HAPPIER_CONTROL_CAPSULE_METRICS;
  const buttonTarget = (position: 'first' | 'middle' | 'last') => ({
    size: HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE,
    minimumInteractiveTargetSize: touchFloor,
    interactiveTargetLayout: 'overhang' as const,
    interactiveTargetEdgesPx: {
      leading: position === 'first' ? capsuleEnd : capsuleGap / 2,
      trailing: position === 'last' ? capsuleEnd : capsuleGap / 2,
    },
  });
  const expanded = controller.state.mode === 'expanded';
  const sourceLabel = (source: SessionViewerSource) =>
    t(
      source === 'computer'
        ? 'computerUse.viewer.sourceComputer'
        : 'computerUse.viewer.sourceBrowser',
    );
  const choosePickerTarget = () => {
    // Desktop anchors the picker to the switch; a phone keeps the picker's own bottom sheet.
    const request = controller.phone
      ? null
      : (facts?.resolveTargetPicker?.() ?? null);
    if (request) setPicker(request);
    else facts?.chooseTarget?.();
  };

  const menuItems: DropdownMenuItem[] = [];
  const navigation = facts?.navigation;
  if (navigation?.back)
    menuItems.push({ id: 'back', title: t('browserShell.toolbar.back') });
  if (navigation?.forward)
    menuItems.push({ id: 'forward', title: t('browserShell.toolbar.forward') });
  if (navigation?.reload)
    menuItems.push({ id: 'reload', title: t('browserShell.toolbar.reload') });
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
    if (id === 'back') navigation?.back?.();
    else if (id === 'forward') navigation?.forward?.();
    else if (id === 'reload') navigation?.reload?.();
    else if (id === 'choose') choosePickerTarget();
    else if (id === 'stop') facts?.stopSharing?.();
    else if (id === 'dock') apply({ kind: 'viewer.dock' });
    else if (id === 'larger' || id === 'smaller') props.frame?.resize(id);
    else if (id === 'tl' || id === 'tr' || id === 'bl' || id === 'br')
      props.frame?.moveToCorner(id);
  };

  return (
    <View style={stylesheet.row}>
      <View ref={sourceAnchorRef}>
        <HappierControlCapsule
          host={CORE_CAPSULE_HOST}
          onLayout={measure('source')}
          testID="session-viewer-source-capsule"
        >
          <SegmentedTabBar
            presentation="plain"
            compact
            segmentSizing="content"
            accessibilityLabel={t('computerUse.viewer.sourceA11y')}
            testIDPrefix="session-viewer-source"
            activeTabId={props.source}
            onSelectTab={(source) => {
              if (source === props.source) {
                if (source === 'computer') choosePickerTarget();
                return;
              }
              void requestSemantic({ kind: 'viewer.source.select', source });
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
        </HappierControlCapsule>
      </View>
      {machineName ? (
        <View style={stylesheet.identity} testID="session-viewer-machine">
          <HappierIdentityCapsule
            name={machineName}
            leading={
              <StatusDot
                color={
                  online
                    ? theme.colors.status.connected
                    : theme.colors.status.disconnected
                }
              />
            }
            colors={capsuleColors}
            host={CORE_CAPSULE_HOST}
            testID="session-viewer-machine-capsule"
          />
        </View>
      ) : null}
      <View style={stylesheet.grow} />
      <HappierControlCapsule
        host={CORE_CAPSULE_HOST}
        onLayout={measure('buttons')}
        testID="session-viewer-buttons-capsule"
      >
          <IconButton
            testID="session-viewer-expand"
            variant="plain"
            {...buttonTarget('first')}
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
              void requestSemantic({
                kind: expanded ? 'viewer.restore' : 'viewer.expand',
              });
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
                  {...buttonTarget('middle')}
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
            {...buttonTarget('last')}
            iconName="x"
            accessibilityLabel={t('computerUse.viewer.closeView')}
            accessibilityHint={t('computerUse.viewer.closeHint')}
            tooltip={t('computerUse.viewer.closeView')}
            onPress={() => {
              void requestSemantic({ kind: 'viewer.close' });
            }}
          />
      </HappierControlCapsule>
      {picker ? (
        <Popover
          open
          anchorRef={sourceAnchorRef}
          boundaryRef={null}
          placement="top"
          edgePadding={{ horizontal: 12, vertical: 12 }}
          portal={{
            web: { target: 'body' },
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'start',
          }}
          maxWidthCap={SOURCE_PICKER_WIDTH}
          onRequestClose={() => setPicker(null)}
        >
          {({ maxHeight, maxWidth }) => (
            <FloatingOverlay
              maxHeight={maxHeight}
              edgeFades={{ top: true, bottom: true, size: 18 }}
              edgeIndicators
              surfaceChrome="theme"
              containerStyle={{
                width: Math.min(maxWidth, SOURCE_PICKER_WIDTH),
              }}
            >
              <View testID="session-viewer-source-picker">
                <ComputerTargetPickerModal
                  {...computerTargetPickerProps(picker)}
                  density="switcher"
                  onClose={() => setPicker(null)}
                />
              </View>
            </FloatingOverlay>
          )}
        </Popover>
      ) : null}
    </View>
  );
}
