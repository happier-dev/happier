import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  HomePlanet,
  useHomePlanetOptions,
} from '@/components/atmosphere/HomePlanet';
import {
  HomeOrbitMap,
  type HomeOrbitBotsProps,
} from '@/components/atmosphere/orbit/HomeOrbitMap';
import {
  layoutHomeOrbitBots,
  type HomeOrbitBotActivity,
} from '@/components/atmosphere/orbit/homeOrbitScene';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';

type MoonFixture = Readonly<{
  key: string;
  name: string;
  activity: HomeOrbitBotActivity;
}>;

/** Lab R6 "Bots orbit Home" (`r6-shell-O`): a working, a needs-you, a quiet and a followed Bot round Home's planet. */
const MOONS: readonly MoonFixture[] = [
  { key: 'release-captain', name: 'Release captain', activity: 'working' },
  { key: 'flake-hunter', name: 'Flake hunter', activity: 'needsYou' },
  { key: 'docs-gardener', name: 'Docs gardener', activity: 'quiet' },
  { key: 'shared-triager', name: 'Issue triager (shared)', activity: 'quiet' },
];

const NOOP = () => {};

/**
 * Dev-only: Home's planet with its Bot moons at lab data, through the real owners (`HomePlanet`,
 * `layoutHomeOrbitBots`, `HomeOrbitMap`, `SessionBotFace`). "Finish a turn" bumps one Bot's completion
 * count, which is exactly what Home's completion observer hands the map, so the spark plays from the
 * owner. Never reads or writes the Account's Bots or Home settings.
 */
export function HomeBotMoonsSpecimen() {
  const { theme } = useUnistyles();
  const window = useWindowDimensions();
  const phone = window.width < 600;
  const pane = React.useMemo(
    () => ({ width: Math.min(window.width, 1180), height: phone ? 520 : 640 }),
    [phone, window.width],
  );
  const look = React.useMemo(
    () => ({
      pane,
      placement: 'corner' as const,
      style: 'balanced' as const,
      digits: false,
      theme: theme.dark ? ('dark' as const) : ('light' as const),
      phone,
      hero: null,
    }),
    [pane, phone, theme.dark],
  );
  const planet = useHomePlanetOptions(look);
  const [sparks, setSparks] = React.useState<Readonly<Record<string, number>>>(
    {},
  );
  const finish = React.useCallback((key: string) => {
    setSparks((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
  }, []);
  const scene = React.useMemo(
    () =>
      planet
        ? layoutHomeOrbitBots(
            pane,
            { px: planet.cx, py: planet.cy, pr: planet.R },
            MOONS,
            phone
              ? { moonSize: 24, parkedSize: 34 }
              : { moonSize: 30, parkedSize: 40 },
          )
        : null,
    [pane, phone, planet],
  );
  const bots = React.useMemo<HomeOrbitBotsProps>(() => {
    const labels: Record<string, string> = {};
    const accessibilityLabels: Record<string, string> = {};
    for (const moon of MOONS) {
      if (moon.activity !== 'quiet') labels[moon.key] = moon.name;
      accessibilityLabels[moon.key] = moon.name;
    }
    return {
      labels,
      accessibilityLabels,
      eligible: true,
      continuous: true,
      sparks,
      renderMark: (key, size, done) => {
        const moon = MOONS.find((item) => item.key === key);
        return moon ? (
          <SessionBotFace
            facts={{ seed: moon.key, face: null }}
            size={size}
            style="planet"
            mood={done ? 'done' : moon.activity}
            visible
          />
        ) : null;
      },
      onPress: NOOP,
    };
  }, [sparks]);
  return (
    <View testID="home-bot-moons-specimen" style={styles.root}>
      <PageHeader
        title="Bots orbit Home"
        description="A working Bot orbits, a needs-you Bot waits in front, and a finished turn drops one spark into the planet."
        actions={
          <>
            <RoundButton display="secondary" title="Docs gardener finishes" onPress={() => finish('docs-gardener')} testID="home-bot-moons-specimen.finish-own" />
            <RoundButton display="secondary" title="Shared Bot finishes" onPress={() => finish('shared-triager')} testID="home-bot-moons-specimen.finish-followed" />
          </>
        }
      />
      <View style={[styles.stage, { width: pane.width, height: pane.height }]}>
        <HomePlanet
          {...look}
          hidden={false}
          leave="fade"
          reducedMotion={false}
          focused
        />
        {scene ? (
          <View
            pointerEvents="box-none"
            style={[styles.layer, { width: pane.width, height: pane.height }]}
          >
            <HomeOrbitMap
              scene={scene}
              bots={bots}
              accessibilityLabel="Bots"
              testID="home-bot-moons"
            />
          </View>
        ) : null}
      </View>
      <Text variant="meta" style={styles.note}>
        Sparks played:{' '}
        {Object.values(sparks).reduce((sum, count) => sum + count, 0)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface.base,
    padding: theme.space.s24,
    gap: theme.space.s16,
  },
  stage: { position: 'relative', overflow: 'hidden', alignSelf: 'center' },
  layer: { position: 'absolute', left: 0, top: 0 },
  note: { color: theme.colors.text.secondary },
}));
