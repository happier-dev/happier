import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  FloatingFrame,
  HAPPIER_MOTION_V1,
  resolveFloatingFrameBodyRect,
  resolveFloatingFrameCornerRect,
  resolveFloatingFrameHeight,
  resolveFloatingFrameRect,
  type CompanionReleaseMotion,
  type FloatingFrameMode,
  type FloatingFrameRectChange,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { COMPANION_WEB_POINTER_BINDING } from '@/components/companion/interaction/useCompanionPointerDragSession';
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
  type SessionViewerController,
} from './SessionViewerController';
import { SessionViewerControls, type SessionViewerFrameCommands } from './SessionViewerControls';
import type { SessionViewerSource } from './sessionViewerPresentation';
import {
  DEFAULT_WIDTH_SHARE,
  SESSION_VIEWER_DEFAULT_ASPECT,
  SESSION_VIEWER_EDGE,
  resolveSessionViewerReadingInset,
} from './sessionViewerGeometry';




/**
 * A thrown viewer comes to rest on the shared travel spring (critically damped), aiming where the
 * throw points with the same projection the floating presences use; the frame's companion release
 * owner applies it.
 */
const SESSION_VIEWER_RELEASE_MOTION: CompanionReleaseMotion = Object.freeze({
  durationMs: motionTokens.spring.travel.durationMs,
  dampingRatio: motionTokens.spring.travel.dampingRatio,
  overshootClamping: false,
  carryVelocity: true,
  projectionSeconds: VOICE_MOTION.throwProjectionSeconds,
});

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
  const { setRect, apply, setReadingInset } = controller;
  // Open, viewport and obstacle changes revalidate the settled placement at the one geometry owner.
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
      height: resolveFloatingFrameHeight(width, SESSION_VIEWER_DEFAULT_ASPECT),
    };
    const desired =
      committedRect ??
      resolveFloatingFrameCornerRect('br', sized, availableRect);
    const placement = resolveFloatingFrameRect({
      rect: desired,
      availableRect,
      avoidRects,
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
  }, [apply, availableRect, avoidRects, committedRect, floating, setRect]);

  const rect = liveRect ?? committedRect;
  const settledFloatingRect = floating && !liveRect ? committedRect : null;
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
  const geometryRef = React.useRef({ rect: committedRect, availableRect, avoidRects });
  geometryRef.current = { rect: committedRect, availableRect, avoidRects };
  const frameCommands = React.useMemo<SessionViewerFrameCommands>(() => {
    const place = (next: FrameRect) => {
      const { availableRect: available, avoidRects: avoid } = geometryRef.current;
      if (!available) return;
      const placement = resolveFloatingFrameRect({ rect: next, availableRect: available, avoidRects: avoid });
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
        const { rect: current, availableRect: available } = geometryRef.current;
        if (!current || !available) return;
        const width = Math.min(available.width, current.width * (direction === 'larger' ? 1.1 : 1 / 1.1));
        if (apply({ kind: 'viewer.size.set', width }).status !== 'applied') return;
        const right = current.x + current.width;
        place({ x: right - width, y: current.y, width, height: resolveFloatingFrameHeight(width, SESSION_VIEWER_DEFAULT_ASPECT) });
      },
    };
  }, [apply, setRect]);
  const onModeChange = React.useCallback(
    (next: FloatingFrameMode) => {
      if (next === 'docked') apply({ kind: 'viewer.dock' });
      else if (next === 'expanded') apply({ kind: 'viewer.expand' });
      else if (next === 'floating') apply({ kind: 'viewer.restore' });
      else apply({ kind: 'viewer.close' });
    },
    [apply],
  );

  const frameRect = mode === 'expanded' ? availableRect : rect;
  const bodyRect = frameRect ? resolveFloatingFrameBodyRect(frameRect) : null;
  const windowGeometry = bodyRect && size ? offsetRect(bodyRect, origin) : null;
  const transition =
    liveRect || reducedMotion
      ? null
      : {
          durationMs: SESSION_VIEWER_RELEASE_MOTION.durationMs,
          easingCss: HAPPIER_MOTION_V1.standardEasingCss,
        };
  const facts = controller.facts[source];
  const machineLabel = facts?.machineName ?? '';

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
        zIndex: 20,
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
          aspectRatio={SESSION_VIEWER_DEFAULT_ASPECT}
          // The retained body renders in the route-stable portal, above this frame: watching
          // moves by the floating controls and the grip; the picture keeps its own input.
          moveInput="chrome"
          onRectChange={onRectChange}
          onModeChange={onModeChange}
          accessibilityLabel={t('computerUse.viewer.watchingA11y', {
            source: t(
              source === 'computer'
                ? 'computerUse.viewer.sourceComputer'
                : 'computerUse.viewer.sourceBrowser',
            ),
            machine: machineLabel,
          })}
          resizeLabel={t('computerUse.viewer.resizeView')}
          pointer={
            Platform.OS === 'web' ? COMPANION_WEB_POINTER_BINDING : undefined
          }
          releaseMotion={SESSION_VIEWER_RELEASE_MOTION}
          reducedMotion={reducedMotion}
          controlsAlwaysVisible={controller.phone}
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
            />
          }
        >
          <SessionViewerBody
            sessionId={props.sessionId}
            serverId={props.serverId}
            source={source}
            pluginProjection={props.pluginProjection}
            windowGeometry={windowGeometry}
            transition={transition}
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
    />
  );
}

