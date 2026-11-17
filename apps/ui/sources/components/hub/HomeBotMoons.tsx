import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import type { PlanetSceneOptions } from '@happier-dev/brand/planet';

import { createSessionFinishedRippleObserver, type SessionTurnState } from '@/components/atmosphere/sessionFinishedRippleObserver';
import type { HomePlanetPlacement } from '@/components/atmosphere/homePlanetPlacement';
import {
  HomeOrbitMap,
  type HomeOrbitBotsProps,
} from '@/components/atmosphere/orbit/HomeOrbitMap';
import {
  layoutHomeOrbitBots,
  type HomeOrbitBotOptions,
  type HomeOrbitRect,
} from '@/components/atmosphere/orbit/homeOrbitScene';
import type { OrderedBot } from '@/components/sessions/bots/botActivity';
import { orderedBotAccessibilityLabel, orderedBotMoonLabel, useOrderedBotNames, useOrderedBots } from '@/components/sessions/bots/botsSummary';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import {
  useIsNearViewport,
  type NearViewportTracker,
} from '@/components/widgets/nearViewport';
import { useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

export type HomeBotMoonsProps = Readonly<{
  /** Home's planet as HomePlanet draws it: the moons go round its centre. */
  planet: PlanetSceneOptions;
  /** The drawn area, in the pane: the same box HomePlanet draws into. */
  width: number;
  height: number;
  placement: HomePlanetPlacement;
  phone: boolean;
  /** The hero's pressable content in the same coordinates (headline, composer, suggestions); moons rest clear of it. */
  keepOut?: readonly HomeOrbitRect[];
  /** Home is the focused page and its planet is shown (not dissolving, not handed to a picture). */
  shown: boolean;
  /** Home's visible window (no overscan): moons scrolled out of it stop. */
  viewport: Pick<NearViewportTracker, 'subscribe' | 'getWindow'> | null;
}>;

/**
 * Home's Bots as moons around its planet (plan U3, lab R6 "Bots orbit Home"). The roster's order decides
 * who stands nearest; a working Bot orbits, needs-you waits in front, a completion seen while Home is on
 * screen drops one spark. It reads the shared Bot projection here, so Bot changes render this leaf only.
 */
export const HomeBotMoons = React.memo(function HomeBotMoons(
  props: HomeBotMoonsProps,
) {
  const bots = useOrderedBots();
  if (bots.length === 0) return null;
  return <HomeBotMoonsScene {...props} bots={bots} />;
});

function HomeBotMoonsScene(
  props: HomeBotMoonsProps & Readonly<{ bots: readonly OrderedBot[] }>,
) {
  const { bots, planet, width, height, placement, phone } = props;
  const viewed = useHostActivelyViewed();
  const reducedMotion = useReducedMotionPreference();
  const motionMode = useSetting('botMotion');
  const span = React.useMemo(() => ({ top: 0, height }), [height]);
  const onScreen = useIsNearViewport(props.viewport, span);
  const visible = props.shown && viewed && onScreen;
  const eligible = visible && !reducedMotion && motionMode !== 'still';
  const navigateToSession = useNavigateToSession();
  const openBots = useOptionalBotsRosterRuntime()?.open;
  const names = useOrderedBotNames(bots);
  const sparks = useBotSparks(bots, eligible);
  const scene = React.useMemo(
    () =>
      layoutHomeOrbitBots(
        { width, height },
        { px: planet.cx, py: planet.cy, pr: planet.R },
        bots,
        { ...orbitOptions(placement, phone), keepOut: props.keepOut },
      ),
    [bots, height, phone, placement, planet.R, planet.cx, planet.cy, props.keepOut, width],
  );
  const byKey = React.useMemo(
    () => new Map(bots.map((bot) => [bot.key, bot])),
    [bots],
  );
  const botProps = React.useMemo<HomeOrbitBotsProps>(() => {
    const labels: Record<string, string> = {};
    const accessibilityLabels: Record<string, string> = {};
    bots.forEach((bot, index) => {
      const name = names[index] ?? '';
      const label = orderedBotMoonLabel(bot, name);
      if (label) labels[bot.key] = label;
      accessibilityLabels[bot.key] = orderedBotAccessibilityLabel(bot, name);
    });
    return {
      labels,
      accessibilityLabels,
      eligible,
      continuous: motionMode === 'lively',
      sparks,
      renderMark: (key, size, done) => {
        const bot = byKey.get(key);
        return bot ? (
          <SessionBotFace
            facts={bot.face}
            size={size}
            style="planet"
            mood={done ? 'done' : bot.activity}
            visible={visible}
          />
        ) : null;
      },
      onPress: (key) => {
        const bot = byKey.get(key);
        if (bot)
          void navigateToSession(bot.sessionId, { serverId: bot.serverId });
      },
      onMore: openBots,
    };
  }, [bots, byKey, eligible, motionMode, names, navigateToSession, openBots, sparks, visible]);
  return (
    <View pointerEvents="box-none" style={[styles.layer, { width, height }]}>
      <HomeOrbitMap
        scene={scene}
        bots={botProps}
        accessibilityLabel={t('bots.title')}
        testID="home-bot-moons"
      />
    </View>
  );
}

/** Lab R6 lanes suit a planet the moons can circle; Rise's planet stands far below, so its lanes ride over its limb. */
function orbitOptions(
  placement: HomePlanetPlacement,
  phone: boolean,
): HomeOrbitBotOptions {
  const sizes = phone
    ? { moonSize: 24, parkedSize: 34 }
    : { moonSize: 30, parkedSize: 40 };
  if (placement !== 'rise') return sizes;
  return {
    ...sizes,
    lanes: [
      { rx: 1.08, ry: 1.06 },
      { rx: 1.14, ry: 1.11 },
      { rx: 1.2, ry: 1.16 },
    ],
    startAngles: [-1.25, -1.9, -1.55],
    parkAngle: -0.62 * Math.PI,
  };
}

/**
 * Each Bot's completions seen by Home's completion observer while the moons can move. The observer learns
 * what it first sees, so a completion from before this mount never sparks, and one missed while hidden is
 * not replayed.
 */
function useBotSparks(
  bots: readonly OrderedBot[],
  eligible: boolean,
): Readonly<Record<string, number>> {
  const [sparks, setSparks] = React.useState<Readonly<Record<string, number>>>(
    {},
  );
  const previousBots = React.useRef<readonly OrderedBot[]>([]);
  const onFinished = React.useCallback((finished: readonly string[]) => {
    setSparks((current) => {
      const next = { ...current };
      for (const key of finished) next[key] = (next[key] ?? 0) + 1;
      return next;
    });
  }, []);
  const observe = React.useMemo(() => createSessionFinishedRippleObserver(() => {}, onFinished), [onFinished]);
  React.useEffect(() => {
    // The visible Bot projection includes followed recipients without owner-private metadata.
    // Activity admission belongs to Activity; completion has already been decided by face facts.
    const states = new Map<string, SessionTurnState | null>(previousBots.current.map(bot => [bot.key, null]));
    for (const bot of bots) states.set(bot.key, {
      lastTurnCompletedAt: bot.face.completedAt ?? null,
      pendingApproval: bot.activity === 'needsYou',
    });
    previousBots.current = bots;
    observe({ enabled: true, visible: eligible, states });
  }, [bots, eligible, observe]);
  return sparks;
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, top: 0 },
});
