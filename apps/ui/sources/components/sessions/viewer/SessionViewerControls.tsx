import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE,
  HAPPIER_CONTROL_CAPSULE_METRICS,
  HAPPIER_FLOATING_FRAME_METRICS,
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
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { CORE_CAPSULE_HOST, useCoreCapsuleColors } from '@/components/ui/status/capsuleHost';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { CompanionNoDragRegion } from '@/components/companion/interaction/CompanionNoDragRegion';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';
import { useSessionViewerMachine } from './useSessionViewerMachine';

/** The gap between the frame's floating capsules. */
const ROW_GAP = 6;
/** The anchored source picker's width (lab `b-mac` `.fa-srcpop`), never wider than the window allows. */
const SOURCE_PICKER_WIDTH = 360;
/** The Machine name is identity, not content: past this width it ellipsizes inside its chip. */
const IDENTITY_MAX_WIDTH = 176;

const stylesheet = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  // The window's own header (lab LV's solid header): one floating paint under the capsules that runs
  // down through the frame's gap to the picture, so the window reads as one solid surface and what lies
  // under a floating frame never shows between its capsules or between the header and the picture.
  header: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: -HAPPIER_FLOATING_FRAME_METRICS.gap,
    borderTopLeftRadius: HAPPIER_CONTROL_CAPSULE_METRICS.height / 2,
    borderTopRightRadius: HAPPIER_CONTROL_CAPSULE_METRICS.height / 2,
    backgroundColor: theme.colors.edge.floatingFill,
  },
  identity: {
    minWidth: 0,
    maxWidth: IDENTITY_MAX_WIDTH,
  },
  identityShrinks: {
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
 * `session.presentation.apply`); corners and size are its local geometry controls. Pressing the
 * current Computer source opens its window/display picker anchored to the switch (lab `b-mac` A).
 */
export function SessionViewerControls(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    source: SessionViewerSource;
    frame?: SessionViewerFrameCommands;
    /**
     * The frame's width. Below the labelled row's own width (a frame the window narrowed) the controls
     * take the phone's composition: the switch as its glyphs, the Machine chip ellipsizing.
     */
    frameWidth?: number;
    /** The narrowest row these controls fit in with their labels (the source switch and the buttons side by side). */
    onMinWidthChange?: (width: number) => void;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const controller = useOptionalSessionViewerController();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [picker, setPicker] =
    React.useState<ComputerTargetPickerRequest | null>(null);
  const sourceAnchorRef = React.useRef<View | null>(null);
  const widthsRef = React.useRef({ source: 0, identity: 0, buttons: 0 });
  // The labelled row's width, as measured with its labels; the glyph-only form never rewrites it.
  const [labelledWidth, setLabelledWidth] = React.useState(0);
  const narrow =
    props.frameWidth !== undefined && labelledWidth > 0 && props.frameWidth < labelledWidth;
  const compactRef = React.useRef(false);
  const onMinWidthChange = props.onMinWidthChange;
  const measure = React.useCallback(
    (part: 'source' | 'identity' | 'buttons') => (event: Pick<LayoutChangeEvent, 'nativeEvent'>) => {
      // The glyph-only switch and an ellipsized chip measure their own compact output: not the row.
      if (compactRef.current && part !== 'buttons') return;
      widthsRef.current[part] = event.nativeEvent.layout.width;
      const { source, identity, buttons } = widthsRef.current;
      // The Machine chip is part of the row it has to fit in: its name shows whole (up to the chip's
      // own cap) instead of being squeezed to its status dot by the switch and the buttons.
      if (source > 0 && buttons > 0) {
        // The row's gap also stands on each side of the spacer between the left and right capsules.
        const width = Math.ceil(source + buttons + ROW_GAP * 2 + (identity > 0 ? identity + ROW_GAP : 0));
        setLabelledWidth(width);
        onMinWidthChange?.(width);
      }
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
  // A phone frame is as wide as the column; a floating frame the window narrowed below the labelled
  // row recomposes the same way rather than clip its buttons.
  const compact = controller.phone || narrow;
  compactRef.current = narrow;
  const { apply, requestSemantic, canPresentSource } = controller;
  const facts = controller.facts[props.source];
  // Each drawn button's hit area reaches the touch target without the capsule
  // or the controls band growing: the hit area overhangs the capsule (its material is a backing,
  // not a clip). Sideways each button takes its full share of the capsule, half of each gap and the
  // capsule's padding at the ends, so the targets tile it edge to edge and never overlap.
  const { padding: capsuleEnd, gap: capsuleGap } = HAPPIER_CONTROL_CAPSULE_METRICS;
  const buttonTarget = (position: 'first' | 'middle' | 'last') => ({
    size: HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE,
    interactiveTargetEdgesPx: {
      leading: position === 'first' ? capsuleEnd : capsuleGap / 2,
      trailing: position === 'last' ? capsuleEnd : capsuleGap / 2,
    },
  });
  const expanded = controller.state.mode === 'expanded';
  // The switch names the kind of source in a short noun (lab 63s1); the selected window or display
  // is named by the presence footer and the frame's accessible name, so a long window title never
  // widens the controls band (and with it the narrowest frame) past the picture.
  const sourceLabel = (source: SessionViewerSource) =>
    t(source === 'computer' ? 'computerUse.presentation.sourceComputer' : 'computerUse.presentation.sourceBrowser');
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
      { id: 'tl', title: t('presentation.moveTopLeft') },
      { id: 'tr', title: t('presentation.moveTopRight') },
      { id: 'bl', title: t('presentation.moveBottomLeft') },
      { id: 'br', title: t('presentation.moveBottomRight') },
      { id: 'larger', title: t('presentation.larger') },
      { id: 'smaller', title: t('presentation.smaller') },
    );
  }
  if (!controller.phone) {
    menuItems.push({
      id: 'dock',
      title: t('presentation.dockView'),
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
    // Its menus and the source picker open over the viewer's live picture.
    <GlassLivePictureBackdropContext.Provider value>
    <View style={stylesheet.row}>
      <View pointerEvents="none" style={stylesheet.header} />
      <CompanionNoDragRegion>
      <View ref={sourceAnchorRef}>
        <HappierControlCapsule
          host={CORE_CAPSULE_HOST}
          onLayout={measure('source')}
          testID="session-viewer-source-capsule"
        >
          <SegmentedTabBar
            presentation="plain"
            compact
            // A phone frame is as wide as the column, and a narrowed floating frame is narrower than
            // the labelled row: the sources are their glyphs, so the Machine's name has room beside them.
            labels={compact ? 'none' : undefined}
            segmentSizing="content"
            accessibilityLabel={t('computerUse.presentation.sourceA11y')}
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
      </CompanionNoDragRegion>
      {machineName ? (
        <View
          // A floating frame grows to the chip's natural width (measured below); a phone frame is as
          // wide as the column, so there the chip ellipsizes in what is left.
          style={[
            stylesheet.identity,
            compact ? stylesheet.identityShrinks : null,
          ]}
          onLayout={measure('identity')}
          testID="session-viewer-machine"
        >
          <HappierIdentityCapsule
            name={machineName}
            leading={
              online === null ? null : <StatusDot
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
      <CompanionNoDragRegion>
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
                ? 'presentation.restoreView'
                : 'presentation.expandView',
            )}
            tooltip={t(
              expanded
                ? 'presentation.restoreView'
                : 'presentation.expandView',
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
                  accessibilityLabel={t('presentation.viewOptions')}
                  tooltip={t('presentation.viewOptions')}
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
            accessibilityLabel={t('presentation.closeView')}
            accessibilityHint={t('computerUse.presentation.closeHint')}
            tooltip={t('presentation.closeView')}
            onPress={() => {
              void requestSemantic({ kind: 'viewer.close' });
            }}
          />
      </HappierControlCapsule>
      </CompanionNoDragRegion>
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
    </GlassLivePictureBackdropContext.Provider>
  );
}
