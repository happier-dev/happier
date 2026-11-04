import * as React from 'react';
import { useDestinationInstanceKey, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import {
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import {
  atmosphereStageStore,
  useAtmosphereStage,
  type AtmosphereStageGeometry,
} from '@/components/atmosphere/atmosphereStage';
import type { HomePlanetHero } from '@/components/atmosphere/HomePlanet';
import {
  HOME_HERO_COMPOSER_GAP_PX,
  HOME_HERO_SIDE_PX,
  HOME_PHONE_HERO_COMPOSER_GAP_PX,
  HOME_PHONE_HERO_SIDE_PX,
  homeAtmosphereSeam,
  homeHeroTop,
  homeHorizonBand,
  type HomePane,
} from '@/components/atmosphere/homePlanetPlacement';
import { PAGE_COLUMN_MAX_WIDTH_PX } from '@/components/ui/layout/contentWidthMode';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { HubComposerSection } from './composer/HubComposerSection';
import { AtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';

type Measured = Readonly<{ y: number; height: number }>;
type Frame = Readonly<{
  rect: AtmosphereStageGeometry['rect'];
  headline: Measured;
  composer: Measured | null;
  suggestions: Measured | null;
  next: Measured | null;
}>;

const bottomOf = (box: Measured) => box.y + box.height;

function measureInWindow(
  node: View | null,
): Promise<Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}> | null> {
  return new Promise((resolve) => {
    if (!node) {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, width, height) =>
      resolve({ x, y, width, height }),
    );
  });
}

/**
 * Home's hero geometry, measured after layout and on every resize (lab `layout()`): where the headline,
 * composer and the first thing below them stand in the page. It is what the planet is placed by and
 * what the shell's picture is cut to; while Home is on screen it holds the atmosphere stage.
 */
export function useHomeHeroFrame(
  input: Readonly<{ active: boolean; focused: boolean; phone: boolean }>,
) {
  const paneRef = React.useRef<View>(null);
  const headlineRef = React.useRef<View>(null);
  const composerRef = React.useRef<View>(null);
  const suggestionsRef = React.useRef<View>(null);
  const nextRef = React.useRef<View>(null);
  const scrollY = React.useRef(0);
  const fallbackHeight = useWindowDimensions().height;
  const [pane, setPane] = React.useState<HomePane>({
    width: 0,
    height: fallbackHeight,
  });
  const [frame, setFrame] = React.useState<Frame | null>(null);
  const generation = React.useRef(0);
  const writing = React.useRef(false);
  const measure = React.useCallback(() => {
    const current = ++generation.current;
    void Promise.all(
      [paneRef, headlineRef, composerRef, suggestionsRef, nextRef].map((ref) =>
        measureInWindow(ref.current),
      ),
    ).then(([paneBox, headline, composer, suggestions, next]) => {
      if (current !== generation.current || !paneBox || !headline) return;
      // Page coordinates: where each thing sits in the scrolled content, independent of the scroll.
      const page = (
        box: { y: number; height: number } | null,
      ): Measured | null =>
        box
          ? { y: box.y - paneBox.y + scrollY.current, height: box.height }
          : null;
      setPane((previous) =>
        previous.width === paneBox.width && previous.height === paneBox.height
          ? previous
          : { width: paneBox.width, height: paneBox.height },
      );
      const next_: Frame = {
        rect: paneBox,
        headline: page(headline)!,
        composer: page(composer),
        suggestions: page(suggestions),
        next: page(next),
      };
      // Composer-derived atmosphere geometry stays still for the entire focus interval, including
      // shrinking a prefilled draft. Content lays out normally; blur or a resized pane takes a new frame.
      setFrame((previous) =>
        previous &&
        writing.current &&
        previous.rect.width === paneBox.width &&
        previous.rect.height === paneBox.height
          ? { ...previous, rect: paneBox }
          : next_,
      );
    });
  }, []);
  const geometry = React.useMemo<AtmosphereStageGeometry | null>(() => {
    if (!frame) return null;
    const band = homeHorizonBand({
      headlineTop: frame.headline.y,
      composerBottom: frame.composer ? frame.composer.y + frame.composer.height : null,
      seam: homeAtmosphereSeam(frame.rect.height, input.phone),
      phone: input.phone,
    });
    const centre = frame.composer ?? frame.headline;
    return {
      rect: frame.rect,
      band: band.band,
      horizonAt: band.horizonAt,
      focus: {
        x: frame.rect.width / 2,
        y: centre.y + centre.height / 2,
      },
    };
  }, [frame, input.phone]);
  const visible = useDestinationVisibility();
  const destinationKey = useDestinationInstanceKey();
  const holdsStage = input.active && (destinationKey !== null ? visible : input.focused);
  const stageId = useAtmosphereStage(holdsStage ? 'home' : null, holdsStage ? geometry : null, input.focused);
  const hero = React.useMemo<HomePlanetHero | null>(
    () =>
      frame
        ? {
            composerTop: frame.composer ? frame.composer.y : null,
            aboveBottom: bottomOf(frame.suggestions ?? frame.composer ?? frame.headline),
            nextTop: frame.next ? frame.next.y : null,
          }
        : null,
    [frame],
  );
  const onScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.current = event.nativeEvent.contentOffset.y;
      if (holdsStage) atmosphereStageStore.setScrollY(stageId, scrollY.current);
    },
    [holdsStage, stageId],
  );
  // The actual AgentInput publishes focus through the shared boundary on web and native.
  const [isWriting, setWriting] = React.useState(false);
  const onComposerFocus = React.useCallback(() => { writing.current = true; setWriting(true); }, []);
  const onComposerBlur = React.useCallback(() => { writing.current = false; setWriting(false); measure(); }, [measure]);
  const onComposerFocusChange = React.useCallback((focused: boolean) => {
    if (focused) onComposerFocus(); else onComposerBlur();
  }, [onComposerBlur, onComposerFocus]);
  return {
    isWriting,
    onComposerFocus,
    onComposerBlur,
    onComposerFocusChange,
    paneRef,
    headlineRef,
    composerRef,
    suggestionsRef,
    nextRef,
    pane,
    hero,
    measure,
    onScroll,
  };
}

/**
 * Home under its atmosphere (lab `horizon()`): the greeting stands alone on berthd's seam, the composer
 * straddles it in the reading column, and the suggestions step back under it. Everything else on Home
 * follows below on the plain page.
 */
export function HomeHero(
  props: Readonly<{
    title: string;
    phone: boolean;
    paneHeight: number;
    /** Rise keeps the widgets clear of the planet's body. */
    rise: boolean;
    suggestions: 'links' | 'pills';
    showComposer: boolean;
    frame: ReturnType<typeof useHomeHeroFrame>;
  }>,
) {
  const top = homeHeroTop({ paneHeight: props.paneHeight, phone: props.phone, composer: props.showComposer });
  const { frame } = props;
  // Padding-only changes do not resize web's observed content box. Measure the committed layout
  // when these choices move the headline or the next section, including entering/leaving Rise.
  React.useLayoutEffect(() => { frame.measure(); }, [frame.measure, props.rise, top]);
  const atmosphereBoundary = React.useMemo(() => ({
    // Home measures its existing composer wrapper; only focus crosses this boundary here.
    ref: undefined,
    onLayout: frame.measure,
    onFocusChange: frame.onComposerFocusChange,
  }), [frame.measure, frame.onComposerFocusChange]);
  const composerHero = React.useMemo(
    () => ({
      composerRef: frame.composerRef,
      suggestionsRef: frame.suggestionsRef,
      onLayout: frame.measure,
    }),
    [frame.composerRef, frame.measure, frame.suggestionsRef],
  );
  return (
    <View
      testID="home-hero"
      style={[styles.hero, { paddingTop: top }, props.rise && styles.riseFoot]}
    >
      <View style={[styles.column, props.phone && styles.phoneColumn]}>
        <View ref={frame.headlineRef} onLayout={frame.measure}>
          <Text accessibilityRole="header" style={styles.headline}>
            {props.title}
          </Text>
        </View>
        {props.showComposer ? (
          <View style={props.phone ? styles.composerPhone : styles.composer}>
            <AtmosphereBandBoundary.Provider value={atmosphereBoundary}>
            <HubComposerSection hero={composerHero} suggestions={props.suggestions} />
            </AtmosphereBandBoundary.Provider>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  hero: { paddingBottom: 52 },
  // Lab Rise: the widgets start 200 px lower, after the planet's ordered foot fade.
  riseFoot: { paddingBottom: 252 },
  // The page's reading column, so a change to it moves the composer with the rest of the app.
  column: {
    width: '100%',
    maxWidth: PAGE_COLUMN_MAX_WIDTH_PX.reading + 2 * HOME_HERO_SIDE_PX,
    paddingHorizontal: HOME_HERO_SIDE_PX,
    alignSelf: 'center',
  },
  phoneColumn: { paddingHorizontal: HOME_PHONE_HERO_SIDE_PX },
  headline: {
    ...Typography.default('bold'),
    ...happierPageTextMetrics('heroTitle'),
    color: theme.colors.text.primary,
    textAlign: 'center',
  },
  composer: { marginTop: HOME_HERO_COMPOSER_GAP_PX },
  composerPhone: { marginTop: HOME_PHONE_HERO_COMPOSER_GAP_PX },
}));
