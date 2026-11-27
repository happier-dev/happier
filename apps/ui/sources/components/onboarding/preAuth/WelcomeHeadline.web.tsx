import * as React from 'react';
import {
  View,
  type LayoutChangeEvent,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { useLaunchCurtainState } from '@/boot/launchCurtain';
import {
  FirstOpenOwnsWelcomePaint,
  FirstOpenWelcomeEpoch,
} from '@/components/onboarding/firstOpen/FirstOpenWelcomeModelContext';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewedEffect } from '@/utils/runtime/useHostActivelyViewed';

import { joinWelcomeHeadlinePhrase } from './welcomeHeadline';
import {
  WELCOME_HEADLINE_MOVE_CSS,
  WELCOME_HEADLINE_SWAP_INTERVAL_MS,
  WELCOME_HEADLINE_SWAP_MS,
  nextWelcomeHeadlineIndex,
  placeWelcomeHeadlinePhrase,
  scrambleWelcomeHeadlineText,
  type WelcomeHeadlineProps,
} from './welcomeHeadlineMotion';

/** Room around a part's line box for ascenders, descenders and overhang, which its clip must not cut. */
const PART_PAD_EM = 0.25;

type PartWidths = Readonly<{ lead: number; gap: number; vary: number }>;
type Fit = Readonly<{
  /** The one size the headline takes, fitted so its widest phrase fits the column (1 = the art-directed size). */
  scale: number;
  /** Each phrase's lead, gap and words widths at that size, in px. */
  widths: readonly PartWidths[];
  /** The widest lead and the widest words: each part's box is that wide, clipped to its own phrase. */
  leadBox: number;
  varyBox: number;
  fontPx: number;
}>;

const canvas =
  typeof document === 'undefined' ? null : document.createElement('canvas');

function measureWith(node: HTMLElement): (text: string) => number {
  const style = getComputedStyle(node);
  const context = canvas?.getContext('2d');
  if (!context) return () => 0;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const spacing = parseFloat(style.letterSpacing) || 0;
  return (text) => context.measureText(text).width + spacing * [...text].length;
}

/** The part's own text node, which a swap writes frame by frame without a render. */
function textNodeOf(node: HTMLElement | null): ChildNode | null {
  const first = node?.firstChild ?? null;
  return first && first.nodeType === 3 ? first : null;
}

/**
 * The first Welcome's headline on the web and in the desktop window (website lab r10 `home.js`): the first line's lead
 * and words are placed by transform alone inside a line of fixed height, and each part's clip eases to its phrase, so a
 * swap lays nothing out; the letters resolve left to right in the headline's own face. One size for the whole headline,
 * fitted from the widest phrase in this language. The second line never changes. It rotates only on the live Welcome
 * once the opening has handed off, while the window can be seen, and never under reduced motion: the opening's
 * replica, a held headline and reduced motion all show the visit's first phrase, still. Seen, not focused: macOS
 * orders a main window revealed during launch activation on screen without making it key, so focus would hold the
 * line still until the person clicks (owner, 2026-11-27).
 */
export const WelcomeHeadline = React.memo(function WelcomeHeadline({
  headline,
  interactive,
  lineStyle,
  line2Style,
}: WelcomeHeadlineProps) {
  // A recomposed Welcome model carries equal phrases in new objects; the headline keeps the ones it measured.
  const key = JSON.stringify(headline);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { phrases, joiner, line2 } = React.useMemo(() => headline, [key]);
  const [index, setIndex] = React.useState(0);
  const [fit, setFit] = React.useState<Fit | null>(null);
  // Only a swap glides its parts to their new places; a fit (first placement, a face arriving, a resized column) puts
  // them there in one step, so a still headline never shows its words in transit.
  const [glide, setGlide] = React.useState(false);
  const lineRef = React.useRef<View | null>(null);
  const leadRef = React.useRef<HTMLElement | null>(null);
  const varyRef = React.useRef<HTMLElement | null>(null);
  const widthRef = React.useRef(0);
  const shown = React.useRef(0);
  const held = React.useRef(false);
  const swapping = React.useRef(0);
  const frames = React.useRef<number[]>([]);

  const openingPlays = React.useContext(FirstOpenWelcomeEpoch) !== null;
  const openingPaints = React.useContext(FirstOpenOwnsWelcomePaint) !== null;
  const curtain = useLaunchCurtainState();
  const reducedMotion = useReducedMotionPreference();
  const rotates =
    interactive &&
    !openingPlays &&
    !openingPaints &&
    curtain === 'gone' &&
    !reducedMotion &&
    phrases.length > 1 &&
    // A line not yet fitted (no column yet) has no places to move its parts to.
    fit !== null;
  const phrase = phrases[index] ?? phrases[0]!;

  // Fits the size and measures every phrase in the headline's face, before paint and again when the column or the
  // phrases change. The scale settles in one step: widths are linear in the size.
  const refit = React.useCallback(() => {
    const lead = leadRef.current;
    if (!lead || widthRef.current <= 0) return;
    const measure = measureWith(lead);
    const fontPx = parseFloat(getComputedStyle(lead).fontSize) || 0;
    setGlide(false);
    setFit((current) => {
      const scale = current?.scale ?? 1;
      const widest = Math.max(
        measure(line2),
        ...phrases.map((p) => measure(joinWelcomeHeadlinePhrase(p, joiner))),
      );
      const next =
        widest > 0 ? Math.min(1, (scale * (widthRef.current - 4)) / widest) : 1;
      const ratio = next / scale;
      const widths = phrases.map((p) => {
        const leadPx = measure(p.lead);
        return {
          lead: leadPx * ratio,
          gap: (measure(p.lead + joiner) - leadPx) * ratio,
          vary: measure(p.vary) * ratio,
        };
      });
      return {
        scale: next,
        widths,
        leadBox: Math.max(...widths.map((w) => w.lead)),
        varyBox: Math.max(...widths.map((w) => w.vary)),
        fontPx: fontPx * ratio,
      };
    });
  }, [joiner, line2, phrases]);

  const onLineLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      const width = event.nativeEvent.layout.width;
      if (Math.abs(width - widthRef.current) < 0.5) return;
      widthRef.current = width;
      refit();
    },
    [refit],
  );

  React.useLayoutEffect(() => {
    const node = lineRef.current as unknown as HTMLElement | null;
    widthRef.current = node?.getBoundingClientRect?.().width ?? 0;
    refit();
    // A face still loading measures in its fallback; measure again once it has arrived.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) refit();
    });
    return () => {
      live = false;
    };
  }, [refit]);

  // A swap: the parts move to the new phrase's places (one render) while their letters resolve, written straight into
  // their text nodes frame by frame (no render per frame).
  React.useLayoutEffect(() => {
    const from = phrases[shown.current];
    shown.current = index;
    if (!from || from === phrase) return;
    const parts = [
      [leadRef.current, from.lead, phrase.lead, 0.8],
      [varyRef.current, from.vary, phrase.vary, 1],
    ] as const;
    for (const [node, before, after, share] of parts) {
      const text = textNodeOf(node);
      if (!text || before === after) continue;
      text.nodeValue = before;
      const started = performance.now();
      const duration = WELCOME_HEADLINE_SWAP_MS * share;
      swapping.current += 1;
      const tick = (now: number) => {
        const progress = Math.min(1, (now - started) / duration);
        text.nodeValue = scrambleWelcomeHeadlineText(
          before,
          after,
          progress,
          Math.random,
        );
        if (progress < 1) frames.current.push(requestAnimationFrame(tick));
        else swapping.current -= 1;
      };
      frames.current.push(requestAnimationFrame(tick));
    }
  }, [index, phrase, phrases]);

  React.useEffect(
    () => () => {
      for (const frame of frames.current) cancelAnimationFrame(frame);
    },
    [],
  );

  useHostActivelyViewedEffect(
    (viewed) => {
      if (!rotates || !viewed) return;
      const timer = setInterval(() => {
        if (held.current || swapping.current > 0) return;
        frames.current = [];
        setGlide(true);
        setIndex((current) =>
          nextWelcomeHeadlineIndex(current, phrases.length),
        );
      }, WELCOME_HEADLINE_SWAP_INTERVAL_MS);
      return () => clearInterval(timer);
    },
    [phrases.length, rotates],
  );

  const fontPx = fit?.fontPx ?? 0;
  const sized: TextStyle | null =
    fit && fit.scale < 1 ? { fontSize: fontPx, lineHeight: fontPx } : null;
  const widths = fit?.widths[index];
  const place = widths ? placeWelcomeHeadlinePhrase(widths) : null;
  const pad = fontPx * PART_PAD_EM;
  const part = (x: number, box: number, own: number): ViewStyle => ({
    position: 'absolute',
    top: -pad,
    left: '50%',
    padding: pad,
    width: box + 2 * pad,
    ...({
      transform: `translate3d(${(x - pad).toFixed(2)}px, 0, 0)`,
      clipPath: `inset(0 ${Math.max(0, box - own - 2).toFixed(2)}px 0 0)`,
      ...(glide
        ? {
            transitionProperty: 'transform, clip-path',
            transitionDuration: WELCOME_HEADLINE_MOVE_CSS.duration,
            transitionTimingFunction: WELCOME_HEADLINE_MOVE_CSS.easing,
          }
        : null),
      willChange: 'transform, clip-path',
      whiteSpace: 'pre',
      textAlign: 'left',
    } as unknown as ViewStyle),
  });
  return (
    <View
      style={{ alignSelf: 'stretch', alignItems: 'center' }}
      onPointerEnter={() => {
        held.current = true;
      }}
      onPointerLeave={() => {
        held.current = false;
      }}
    >
      <View
        ref={lineRef}
        onLayout={onLineLayout}
        accessibilityRole="header"
        testID="welcome-headline-line1"
        accessibilityLabel={joinWelcomeHeadlinePhrase(phrase, joiner)}
        style={{
          alignSelf: 'stretch',
          position: 'relative',
          ...(place ? { height: fontPx } : null),
        }}
      >
        {/* Until the first fit (before paint) the phrase stands whole in ordinary centred flow. */}
        <Text
          ref={leadRef as never}
          aria-hidden
          testID="welcome-headline-lead"
          style={[
            lineStyle,
            sized,
            place && fit && widths
              ? part(place.leadX, fit.leadBox, widths.lead)
              : null,
          ]}
        >
          {place ? phrase.lead : joinWelcomeHeadlinePhrase(phrase, joiner)}
        </Text>
        {place && fit && widths ? (
          <Text
            ref={varyRef as never}
            aria-hidden
            testID="welcome-headline-vary"
            style={[
              lineStyle,
              sized,
              part(place.varyX, fit.varyBox, widths.vary),
            ]}
          >
            {phrase.vary}
          </Text>
        ) : null}
      </View>
      <Text
        accessibilityRole="header"
        testID="welcome-headline-line2"
        style={[line2Style, sized]}
      >
        {line2}
      </Text>
    </View>
  );
});
