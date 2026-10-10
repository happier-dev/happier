import * as React from 'react';
import { BackHandler, Platform, View, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  FloatingFrame,
  HAPPIER_FLOATING_FRAME_METRICS,
  resolveFloatingFrameBodyRect,
  resolveFloatingFrameChromeHeight,
  resolveFloatingFrameCornerRect,
  resolveFloatingFrameHeight,
  resolveFloatingFrameRect,
  resolveFloatingFrameSettleTransition,
  type CompanionReleaseMotion,
  type FloatingFrameMode,
  type FloatingFrameRectChange,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { COMPANION_WEB_POINTER_BINDING } from '@/components/companion/interaction/useCompanionPointerDragSession';
import { NativeFloatingFrame } from '@/components/companion/interaction/NativeFloatingFrame';
import { SessionComputerScreenPane } from '@/components/computer/SessionComputerScreenPane';
import { SessionRightPanelBrowserView } from '@/components/sessions/panes/browser/SessionRightPanelBrowserView';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { layout } from '@/components/ui/layout/layout';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { VOICE_MOTION } from '@/components/voice/light/voiceLightTokens';
import {
  useReportSessionCockpitViewerRect,
  useSessionCockpitComposerChromeHeight,
  useSessionCockpitPetRect,
  useSessionCockpitVoicePresenceRect,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { t } from '@/text';

import {
  useOptionalSessionViewerController,
  useSessionViewerHasPresence,
  type SessionViewerController,
} from './SessionViewerController';
import { SessionViewerControls, type SessionViewerFrameCommands } from './SessionViewerControls';
import { SessionViewerPresenceFooter } from './SessionViewerPresenceFooter';
import type { SessionViewerSource } from './sessionViewerPresentation';
import {
  resolveSessionViewerWatchingLabel,
  useSessionViewerMachine,
} from './useSessionViewerMachine';
import {
  DEFAULT_WIDTH_SHARE,
  SESSION_VIEWER_DEFAULT_ASPECT,
  SESSION_VIEWER_EDGE,
  resolveSessionViewerReadingInset,
} from './sessionViewerGeometry';




/**
 * A released viewer aims where the throw points (the same projection the floating presences use)
 * and travels there for the travel spring's duration on the frame's critically damped settle curve.
 * The frame reads only the duration and the projection; the retained body, drawn in its own layer,
 * takes the same settle transition from the frame's owner.
 */
const SESSION_VIEWER_RELEASE_MOTION: CompanionReleaseMotion = Object.freeze({
  durationMs: motionTokens.spring.travel.durationMs,
  dampingRatio: motionTokens.spring.travel.dampingRatio,
  overshootClamping: false,
  carryVelocity: false,
  projectionSeconds: VOICE_MOTION.throwProjectionSeconds,
});
const SESSION_VIEWER_SETTLE = resolveFloatingFrameSettleTransition(
  SESSION_VIEWER_RELEASE_MOTION,
);
/** The viewer floats over the transcript and under the session's popovers and sheets. */
const SESSION_VIEWER_LAYER = 20;

type Size = Readonly<{ width: number; height: number }>;
type Point = Readonly<{ x: number; y: number }>;

function offsetRect(rect: FrameRect, origin: Point): FrameRect {
  return {
    x: rect.x + origin.x,
    y: rect.y + origin.y,
    width: rect.width,
    height: rect.height,
  };
}


/**
 * The Session's floating viewer on desktop, and its expanded overlay on every device: one
 * `FloatingFrame` around the retained Computer or Browser body, beside the reading column and clear
 * of the composer and the floating Voice/pet presences. Phone docking is the transcript's sticky slot.
 */
export function SessionViewerHost(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    pluginProjection?: PluginUiProjectionCurrentness;
  }>,
): React.ReactElement | null {
  const controller = useOptionalSessionViewerController();
  const state = controller?.state;
  const source = state?.source ?? null;
  const shown = Boolean(
    controller &&
    source &&
    (state?.mode === 'expanded' ||
      (!controller.phone && state?.mode === 'floating')),
  );
  if (!controller || !source || !shown) return null;
  return (
    <MountedSessionViewerHost
      {...props}
      controller={controller}
      source={source}
    />
  );
}

function MountedSessionViewerHost(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    pluginProjection?: PluginUiProjectionCurrentness;
    controller: SessionViewerController;
    source: SessionViewerSource;
  }>,
): React.ReactElement {
  const { controller, source } = props;
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const containerRef = React.useRef<View | null>(null);
  const [size, setSize] = React.useState<Size | null>(null);
  const [origin, setOrigin] = React.useState<Point>({ x: 0, y: 0 });
  const [liveRect, setLiveRect] = React.useState<FrameRect | null>(null);
  const composerHeight = useSessionCockpitComposerChromeHeight();
  const presenceRect = useSessionCockpitVoicePresenceRect();
  const petRect = useSessionCockpitPetRect();
  const mode: FloatingFrameMode = controller.state.mode;
  const floating = mode === 'floating' && !controller.phone;

  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
    containerRef.current?.measureInWindow?.((x, y) => {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        setOrigin((current) =>
          current.x === x && current.y === y ? current : { x, y },
        );
      }
    });
  }, []);

  const availableRect = React.useMemo<FrameRect | null>(() => {
    if (!size) return null;
    return {
      x: SESSION_VIEWER_EDGE,
      y: SESSION_VIEWER_EDGE,
      width: Math.max(0, size.width - SESSION_VIEWER_EDGE * 2),
      height: Math.max(
        0,
        size.height - composerHeight - SESSION_VIEWER_EDGE * 2,
      ),
    };
  }, [composerHeight, size]);
  // The floating presences report window-space rects; the frame works in this area's space.
  const avoidRects = React.useMemo(
    () =>
      [presenceRect, petRect]
        .filter((rect): rect is FrameRect => rect !== null)
        .map((rect) => offsetRect(rect, { x: -origin.x, y: -origin.y })),
    [origin.x, origin.y, petRect, presenceRect],
  );

  const committedRect = controller.state.rect;
  const { setRect, apply, requestSemantic, setReadingInset } = controller;
  const facts = controller.facts[source];
  // The picture's own shape once its source reports it; the lab's 16:10 until then.
  const aspectRatio = facts?.aspectRatio ?? SESSION_VIEWER_DEFAULT_ASPECT;
  const watching = facts?.watching === true;
  const footer = useSessionViewerHasPresence(source);
  const chromeHeight = resolveFloatingFrameChromeHeight({ footer });
  // The narrowest frame whose controls still fit across, as the controls measured themselves.
  const [minWidth, setMinWidth] = React.useState(0);
  // Open, viewport, obstacle, aspect and footer changes revalidate the settled placement at the one
  // geometry owner; the height always follows the width through the picture's aspect.
  React.useEffect(() => {
    if (
      !floating ||
      !availableRect ||
      availableRect.width <= 0 ||
      availableRect.height <= 0
    )
      return;
    const width =
      committedRect?.width ??
      Math.round(availableRect.width * DEFAULT_WIDTH_SHARE);
    const sized = {
      width,
      height: resolveFloatingFrameHeight(width, aspectRatio, { footer }),
    };
    const desired = committedRect
      ? { ...committedRect, ...sized }
      : resolveFloatingFrameCornerRect('br', sized, availableRect);
    const placement = resolveFloatingFrameRect({
      rect: desired,
      availableRect,
      avoidRects,
      aspectRatio,
      chromeHeight,
      minWidth,
    });
    if (!placement.fits) {
      apply({ kind: 'viewer.dock' });
      return;
    }
    const next = placement.rect;
    if (
      !committedRect ||
      next.x !== committedRect.x ||
      next.y !== committedRect.y ||
      next.width !== committedRect.width ||
      next.height !== committedRect.height
    )
      setRect(next);
  }, [apply, aspectRatio, availableRect, avoidRects, chromeHeight, committedRect, floating, footer, minWidth, setRect]);

  const rect = liveRect ?? committedRect;
  // The resting rect: a drag in flight neither reflows the reading column nor moves the obstacle the
  // floating presences avoid; both follow the frame where it settles.
  const settledFloatingRect = floating ? committedRect : null;
  const reportViewerRect = useReportSessionCockpitViewerRect(
    { sessionId: props.sessionId, serverId: props.serverId },
    floating,
  );
  React.useEffect(() => {
    reportViewerRect(
      settledFloatingRect ? offsetRect(settledFloatingRect, origin) : null,
    );
  }, [origin, reportViewerRect, settledFloatingRect]);
  React.useEffect(() => {
    setReadingInset(
      settledFloatingRect && size
        ? resolveSessionViewerReadingInset({
            areaWidth: size.width,
            columnMaxWidth: layout.maxWidth,
            columnMinWidth: PANE_SIZING_DEFAULTS.mainMinPx,
            rect: settledFloatingRect,
          })
        : { left: 0, right: 0 },
    );
  }, [setReadingInset, settledFloatingRect, size]);

  const onRectChange = React.useCallback(
    (next: FrameRect, change: FloatingFrameRectChange) => {
      if (change.kind === 'move') {
        setLiveRect(next);
        return;
      }
      setLiveRect(null);
      setRect(next);
    },
    [setRect],
  );
  // Menu geometry goes through the mounted owner's local validator, then the one placement owner.
  const geometryRef = React.useRef({ rect: committedRect, availableRect, avoidRects, aspectRatio, chromeHeight, footer, minWidth });
  geometryRef.current = { rect: committedRect, availableRect, avoidRects, aspectRatio, chromeHeight, footer, minWidth };
  const frameCommands = React.useMemo<SessionViewerFrameCommands>(() => {
    const place = (next: FrameRect) => {
      const { availableRect: available, avoidRects: avoid, aspectRatio: aspect, chromeHeight: chrome, minWidth: min } = geometryRef.current;
      if (!available) return;
      const placement = resolveFloatingFrameRect({
        rect: next, availableRect: available, avoidRects: avoid, aspectRatio: aspect, chromeHeight: chrome, minWidth: min,
      });
      if (placement.fits) setRect(placement.rect);
      else apply({ kind: 'viewer.dock' });
    };
    return {
      moveToCorner: (corner) => {
        const { rect: current, availableRect: available } = geometryRef.current;
        if (!current || !available) return;
        if (apply({ kind: 'viewer.corner.set', corner }).status === 'unavailable') return;
        place(resolveFloatingFrameCornerRect(corner, current, available));
      },
      resize: (direction) => {
        const { rect: current, availableRect: available, aspectRatio: aspect, footer: withFooter } = geometryRef.current;
        if (!current || !available) return;
        const step = 1 + HAPPIER_FLOATING_FRAME_METRICS.resizeStep;
        const width = Math.min(available.width, current.width * (direction === 'larger' ? step : 1 / step));
        if (apply({ kind: 'viewer.size.set', width }).status !== 'applied') return;
        const right = current.x + current.width;
        place({ x: right - width, y: current.y, width, height: resolveFloatingFrameHeight(width, aspect, { footer: withFooter }) });
      },
    };
  }, [apply, setRect]);
  const onModeChange = React.useCallback(
    (next: FloatingFrameMode) => {
      if (next === 'docked') apply({ kind: 'viewer.dock' });
      else if (next === 'expanded') void requestSemantic({ kind: 'viewer.expand' });
      else if (next === 'floating') void requestSemantic({ kind: 'viewer.restore' });
      else void requestSemantic({ kind: 'viewer.close' });
    },
    [apply, requestSemantic],
  );

  // Back on a phone or Android leaves the deliberate expanded overlay for where the viewer was.
  const expanded = mode === 'expanded';
  React.useEffect(() => {
    if (!expanded) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void requestSemantic({ kind: 'viewer.restore' });
      return true;
    });
    return () => subscription.remove();
  }, [expanded, requestSemantic]);

  const frameRect = mode === 'expanded' ? availableRect : rect;
  const bodyRect = frameRect ? resolveFloatingFrameBodyRect(frameRect, { footer }) : null;
  const windowGeometry = bodyRect && size ? offsetRect(bodyRect, origin) : null;
  const transition = liveRect || reducedMotion ? null : SESSION_VIEWER_SETTLE;
  const machine = useSessionViewerMachine(props.sessionId, props.serverId, source);

  return (
    <View
      ref={containerRef}
      onLayout={onLayout}
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: SESSION_VIEWER_LAYER,
      }}
      testID="session-viewer-host"
    >
      {availableRect && frameRect ? (
        <FloatingFrame
          testID="session-viewer-frame"
          mode={mode === 'expanded' ? 'expanded' : 'floating'}
          rect={frameRect}
          availableRect={availableRect}
          avoidRects={avoidRects}
          aspectRatio={aspectRatio}
          minWidth={minWidth}
          // The retained body paints in the route-stable portal above this frame. While it is only
          // watched it lets the pointer through, so the picture moves (and double-click expands)
          // the frame; while the person drives it, the picture's input is the content's own.
          moveInput={watching ? 'surface' : 'chrome'}
          onRectChange={onRectChange}
          onModeChange={onModeChange}
          accessibilityLabel={resolveSessionViewerWatchingLabel(source, machine.name)}
          resizeLabel={t('computerUse.viewer.resizeView')}
          pointer={
            Platform.OS === 'web' ? COMPANION_WEB_POINTER_BINDING : undefined
          }
          nativeBinding={NativeFloatingFrame}
          releaseMotion={SESSION_VIEWER_RELEASE_MOTION}
          reducedMotion={reducedMotion}
          // Hover reaches the frame only through a watched picture; a driven picture keeps them shown.
          // (A pointer that cannot hover keeps them shown at the frame's own reveal rule.)
          controlsAlwaysVisible={controller.phone || !watching}
          colors={{
            grip: theme.colors.text.tertiary,
            focusRing: theme.colors.border.focus,
          }}
          controls={
            <SessionViewerControls
              sessionId={props.sessionId}
              serverId={props.serverId}
              source={source}
              frame={frameCommands}
              onMinWidthChange={setMinWidth}
            />
          }
          footer={
            footer ? (
              <SessionViewerPresenceFooter
                sessionId={props.sessionId}
                serverId={props.serverId}
                source={source}
                compact={controller.phone}
              />
            ) : undefined
          }
        >
          <SessionViewerBody
            sessionId={props.sessionId}
            serverId={props.serverId}
            source={source}
            pluginProjection={props.pluginProjection}
            windowGeometry={windowGeometry}
            transition={transition}
            inputPassthrough={watching}
          />
        </FloatingFrame>
      ) : null}
    </View>
  );
}

/**
 * The retained source body for the viewer's presentation. Geometry flows to the slot binder; the
 * source body element itself is created once per source/identity so a moving frame never
 * re-renders the stream or control owners.
 */
export function SessionViewerBody(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    source: SessionViewerSource;
    machineId?: string | null;
    pluginProjection?: PluginUiProjectionCurrentness;
    windowGeometry?: FrameRect | null;
    transition?: Readonly<{ durationMs: number; easingCss: string }> | null;
    /** The watched picture lets the pointer reach the frame beneath it. */
    inputPassthrough?: boolean;
  }>,
): React.ReactElement | null {
  // Computer use targets the Session's own machine (the same rule the Watch opener applies).
  const sessionMachineId =
    useSessionMachineTarget(props.sessionId, props.serverId)?.machineId ?? null;
  const machineId = props.machineId ?? sessionMachineId;
  if (props.source === 'computer') {
    if (!machineId) return null;
    return (
      <SessionComputerScreenPane
        sessionId={props.sessionId}
        serverId={props.serverId}
        machineId={machineId}
        presentation="viewer"
        windowGeometry={props.windowGeometry}
        transition={props.transition}
        inputPassthrough={props.inputPassthrough}
        testID="session-viewer-computer"
      />
    );
  }
  return (
    <SessionRightPanelBrowserView
      sessionId={props.sessionId}
      pluginProjection={props.pluginProjection}
      presentation="viewer"
      windowGeometry={props.windowGeometry}
      transition={props.transition}
      inputPassthrough={props.inputPassthrough}
    />
  );
}
