import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, View, type GestureResponderEvent } from 'react-native';
import {
  Circle,
  Defs,
  G,
  Path,
  Pattern,
  Rect,
  Svg,
  Text as SvgText,
  TextPath,
  TSpan,
} from 'react-native-svg';

import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import {
  layoutHappierSunburst,
  type HappierSunburstArc,
  type HappierSunburstNode,
  type HappierSunburstRing,
} from './sunburstLayout.js';
import { fitText } from './chartText.js';
import type { HappierChartPart } from './Treemap.js';

export type HappierSunburstProps = Readonly<{
  theme: HappierUiTheme;
  /** The colour of `accent` parts: the host's data accent (its chart language); defaults to the theme accent. */
  accentColor?: string;
  items: readonly HappierChartPart[];
  width: number;
  height: number;
  /** Arcs narrower than this (at the outer ring) fold into one smaller-items arc (the host's shared geometry). */
  minArcDegrees: number;
  /** The open folder, in the centre. */
  centerLabel: string;
  centerValue: string;
  /** The way up ("↑ Users"); absent at the top of a disk. */
  upLabel?: string;
  /** Reserved at the end of the circle for what is not counted here (another disk mounted inside), with its label. */
  gapDegrees?: number;
  gapLabel?: Readonly<{ name: string; note: string }>;
  accessibilityLabel: string;
  smallerLabel: (count: number) => string;
  pointedKey?: string | null;
  onPointAt?: (key: string | null) => void;
  onOpen?: (key: string) => void;
  onCollect?: (key: string) => void;
  onUp?: () => void;
  renderTooltip?: (key: string) => ReactNode;
  /** The host's reduced-motion preference; the environment's when omitted. */
  reducedMotion?: boolean;
  testID?: string;
}>;

const INK_STEPS = [0.17, 0.14, 0.12, 0.1, 0.09, 0.08, 0.07, 0.06] as const;
/** The lab's rings at its 408 px chart (56–104, 107–140, 143–160), scaled to the drawn height. */
const RING_PROPORTIONS = [
  [56, 104],
  [107, 140],
  [143, 160],
] as const;
const PAD_RADIANS = 0.006;
/** Lab MU motion: the drill morph (360 ms, strong ease-out); reduced motion cross-fades the two levels (160 ms). */
const MORPH_MS = 360;
const REDUCED_FADE_MS = 160;
const LEADER_GAP_PX = 18;
const LABEL_SPACING_PX = 17;

type KeyEvent = Readonly<{
  key?: string;
  nativeEvent?: { key?: string };
  preventDefault?: () => void;
}>;
type PointerEvent = Readonly<{
  nativeEvent: {
    offsetX?: number;
    offsetY?: number;
    locationX?: number;
    locationY?: number;
  };
}>;
/** Where an arc is drawn: angles and the radii of its ring. Interpolated by key, so a drill retargets mid-way. */
type Geometry = Readonly<{
  a0: number;
  a1: number;
  r0: number;
  r1: number;
  opacity: number;
}>;
type OutsideLabel = Readonly<{
  key: string;
  a: number;
  ro: number;
  name: string;
  value: string;
  quiet: boolean;
}>;
export type HappierSunburstLeader = Readonly<{
  key: string;
  sx: number;
  sy: number;
  x: number;
  y: number;
  right: boolean;
  name: string;
  value: string;
  quiet: boolean;
}>;

function toNodes(items: readonly HappierChartPart[]): HappierSunburstNode[] {
  return items.map((item) => ({
    key: item.key,
    value: Math.max(0, item.value),
    ...(item.children?.length ? { children: toNodes(item.children) } : {}),
  }));
}
function indexParts(
  items: readonly HappierChartPart[],
  into = new Map<string, HappierChartPart>(),
) {
  for (const item of items) {
    into.set(item.key, item);
    if (item.children) indexParts(item.children, into);
  }
  return into;
}
function point(cx: number, cy: number, r: number, a: number) {
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
}
function arcPath(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = point(cx, cy, r0, a0);
  const [x1, y1] = point(cx, cy, r1, a0);
  const [x2, y2] = point(cx, cy, r1, a1);
  const [x3, y3] = point(cx, cy, r0, a1);
  return `M${x0},${y0}L${x1},${y1}A${r1},${r1} 0 ${large} 1 ${x2},${y2}L${x3},${y3}A${r0},${r0} 0 ${large} 0 ${x0},${y0}Z`;
}
function labelPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const mid = (a0 + a1) / 2;
  const flip = mid > Math.PI / 2 && mid < Math.PI * 1.5;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [sx, sy] = point(cx, cy, r, flip ? a1 : a0);
  const [ex, ey] = point(cx, cy, r, flip ? a0 : a1);
  return `M${sx},${sy}A${r},${r} 0 ${large} ${flip ? 0 : 1} ${ex},${ey}`;
}
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Rings (a sunburst) of one folder: the centre is the folder and the way up, each ring out is one level
 * deeper, arc length is size on disk. Layout comes from the served items and the host's geometry; marks
 * (the pile's hatch, Happier's accent, folded dots, a lock) are overlays; hit-testing is a polar lookup.
 * One tab stop: Left/Right move along a ring, Up/Down between rings, Enter opens, Space collects,
 * Backspace or Escape goes up. Drilling morphs each arc by its key from where it is drawn to where it
 * goes — the opened arc widens to the whole first ring, its children fan out, the rest fade — and a
 * second drill retargets from the current angles; going up plays the same path back. Short top-level
 * arcs carry their name outside, on a leader.
 */
export function Sunburst(props: HappierSunburstProps) {
  const accessibility = useOptionalHappierUiAccessibility();
  // A host that owns its motion preference (core: OS setting plus the app's visual effects) passes it; plugin
  // surfaces read it from the environment.
  const reducedMotion = props.reducedMotion ?? accessibility?.reducedMotion === true;
  const id = `sb-${useId().replace(/[^a-z0-9]/giu, '')}`;
  const { width, height, theme } = props;
  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.min(width, height) / 408;
  const rings = useMemo(
    (): HappierSunburstRing[] =>
      RING_PROPORTIONS.map(([inner, outer]) => ({
        inner: inner * scale,
        outer: outer * scale,
      })),
    [scale],
  );
  const outer = rings[rings.length - 1]!;
  const minArcPx =
    ((props.minArcDegrees * Math.PI) / 180) * ((outer.inner + outer.outer) / 2);
  const nodes = useMemo(() => toNodes(props.items), [props.items]);
  const parts = useMemo(() => indexParts(props.items), [props.items]);
  const gapRadians = ((props.gapDegrees ?? 0) * Math.PI) / 180;
  const { arcs } = useMemo(
    () => layoutHappierSunburst(nodes, { rings, minArcPx, gapRadians }),
    [nodes, rings, minArcPx, gapRadians],
  );
  const byKey = useMemo(
    () => new Map(arcs.map((arc) => [arc.key, arc])),
    [arcs],
  );
  const rank = useMemo(
    () =>
      new Map(
        arcs
          .filter((arc) => arc.depth === 0)
          .map((arc, index) => [arc.key, index]),
      ),
    [arcs],
  );
  const rootOf = useMemo(() => {
    const parent = new Map(arcs.map((arc) => [arc.key, arc.parentKey]));
    return (key: string) => {
      let current = key;
      while (parent.get(current)) current = parent.get(current)!;
      return current;
    };
  }, [arcs]);
  const [internalPointed, setInternalPointed] = useState<string | null>(null);
  const [pointer, setPointer] = useState<Readonly<{
    x: number;
    y: number;
  }> | null>(null);
  const pointed =
    props.pointedKey === undefined ? internalPointed : props.pointedKey;
  const pointAt = (key: string | null) => {
    if (key === pointed) return;
    setInternalPointed(key);
    props.onPointAt?.(key);
  };

  // ── The drill morph, keyed by arc ────────────────────────────────────────────────────────────────
  const target = useMemo(() => {
    const out = new Map<string, Geometry>();
    for (const arc of arcs) {
      const ring = rings[arc.depth]!;
      out.set(arc.key, {
        a0: arc.a0,
        a1: arc.a1,
        r0: ring.inner,
        r1: ring.outer,
        opacity: 1,
      });
    }
    return out;
  }, [arcs, rings]);
  const drawn = useRef<ReadonlyMap<string, Geometry>>(target);
  const from = useRef<ReadonlyMap<string, Geometry>>(target);
  const [progress, setProgress] = useState(1);
  const fade = useRef(new Animated.Value(1)).current;
  const levelKey = `${props.centerLabel}\u0000${props.items.map((item) => item.key).join('\u0000')}`;
  const lastLevel = useRef(levelKey);
  useEffect(() => {
    if (lastLevel.current === levelKey) {
      if (reducedMotion) setProgress(1);
      fade.setValue(1);
      return;
    }
    lastLevel.current = levelKey;
    if (reducedMotion) {
      setProgress(1);
      fade.setValue(0.2);
      const animation = Animated.timing(fade, {
        toValue: 1,
        duration: REDUCED_FADE_MS,
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }
    // Start from what is on screen now (a second drill retargets mid-way).
    from.current = drawn.current;
    let frame = 0;
    let start = 0;
    let cancelled = false;
    const step = (time: number) => {
      if (cancelled) return;
      if (!start) start = time;
      const t = Math.min(1, (time - start) / MORPH_MS);
      setProgress(t);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    setProgress(0);
    frame = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [fade, levelKey, reducedMotion]);
  // The render that receives a new level (before its effect starts the morph) already draws its first frame.
  const starting = lastLevel.current !== levelKey && !reducedMotion;
  const geometry = useMemo(() => {
    const current = starting ? 0 : progress;
    if (current >= 1) return target;
    const t = easeOut(current);
    const now = new Map<string, Geometry>();
    const previous = starting ? drawn.current : from.current;
    for (const arc of arcs) {
      const to = target.get(arc.key)!;
      // A part already drawn moves from where it is; a new one fans out from its parent's place (or opens from its start).
      const parent = arc.parentKey ? previous.get(arc.parentKey) : undefined;
      const was =
        previous.get(arc.key) ??
        (parent ? { ...parent, opacity: 0 } : { ...to, a1: to.a0, opacity: 0 });
      now.set(arc.key, {
        a0: lerp(was.a0, to.a0, t),
        a1: lerp(was.a1, to.a1, t),
        r0: lerp(was.r0, to.r0, t),
        r1: lerp(was.r1, to.r1, t),
        opacity: lerp(was.opacity, 1, t),
      });
    }
    // Parts leaving fade where they are, gone by mid-morph, so the old and new rings never stack into a muddy
    // double image while the new level fans out.
    for (const [key, was] of previous)
      if (!target.has(key))
        now.set(key, { ...was, opacity: was.opacity * Math.max(0, 1 - 2 * t) });
    return now;
  }, [arcs, progress, starting, target]);
  useEffect(() => {
    drawn.current = geometry;
  }, [geometry]);
  const settled = progress >= 1 && !starting;

  const locate = (event: PointerEvent) => ({
    x: event.nativeEvent.offsetX ?? event.nativeEvent.locationX ?? -1,
    y: event.nativeEvent.offsetY ?? event.nativeEvent.locationY ?? -1,
  });
  const inHole = (x: number, y: number) =>
    Math.hypot(x - cx, y - cy) < rings[0]!.inner;
  const hit = (x: number, y: number) => {
    const radius = Math.hypot(x - cx, y - cy);
    const angle = (Math.atan2(x - cx, cy - y) + Math.PI * 2) % (Math.PI * 2);
    let key: string | null = null;
    // Match the visible paths, including their padding/fade. Later shapes paint over earlier ones.
    for (const [candidate, g] of geometry) {
      if (g.opacity <= 0.01 || radius < g.r0 || radius > g.r1) continue;
      if (angle >= g.a0 + PAD_RADIANS && angle < g.a1 - PAD_RADIANS) key = candidate;
    }
    return key;
  };
  const onKeyDown = (event: KeyEvent) => {
    const key = event.key ?? event.nativeEvent?.key;
    const current = pointed ? byKey.get(pointed) : undefined;
    const sameRing = (depth: number, parentKey: string | null) =>
      arcs.filter(
        (arc) =>
          arc.depth === depth && (depth === 0 || arc.parentKey === parentKey),
      );
    const choose = (next: HappierSunburstArc | undefined) => {
      event.preventDefault?.();
      if (next) pointAt(next.key);
    };
    switch (key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        if (!current) {
          choose(arcs[0]);
          return;
        }
        const ring = sameRing(current.depth, current.parentKey);
        const index = ring.indexOf(current) + (key === 'ArrowRight' ? 1 : -1);
        choose(ring[(index + ring.length) % ring.length]);
        return;
      }
      case 'ArrowUp':
        if (current) choose(arcs.find((arc) => arc.parentKey === current.key));
        else choose(arcs[0]);
        return;
      case 'ArrowDown':
        if (current?.parentKey) choose(byKey.get(current.parentKey));
        return;
      case 'Enter':
        if (pointed) {
          event.preventDefault?.();
          props.onOpen?.(pointed);
        }
        return;
      case ' ':
        if (pointed) {
          event.preventDefault?.();
          props.onCollect?.(pointed);
        }
        return;
      case 'Backspace':
      case 'Escape':
        event.preventDefault?.();
        props.onUp?.();
        return;
    }
  };
  const webHandlers = {
    onPointerMove: (event: PointerEvent) => {
      const at = locate(event);
      setPointer(at);
      pointAt(hit(at.x, at.y));
    },
    onPointerLeave: () => {
      setPointer(null);
      pointAt(null);
    },
    onKeyDown,
  };

  const ink = theme.colors.text;
  const labels: ReactNode[] = [];
  const outside: OutsideLabel[] = [];
  const shapes: ReactNode[] = [];
  const marks: ReactNode[] = [];
  for (const [key, g] of geometry) {
    const arc = byKey.get(key) ?? null;
    const part = parts.get(key) ?? null;
    const folded = arc ? arc.folded !== null : false;
    const depth = arc?.depth ?? 0;
    const tone = folded ? 'quiet' : (part?.tone ?? 'ink');
    const step =
      INK_STEPS[
        Math.min(rank.get(arc ? rootOf(key) : key) ?? 0, INK_STEPS.length - 1)
      ]!;
    const fill =
      tone === 'accent'
        ? 0.3 - depth * 0.04
        : tone === 'quiet'
          ? 0.06
          : step + 0.06 - depth * 0.03;
    const a0 = g.a0 + PAD_RADIANS;
    const a1 = Math.max(a0, g.a1 - PAD_RADIANS);
    if (a1 - a0 <= 0 || g.opacity <= 0.01) continue;
    const d = arcPath(cx, cy, g.r0, g.r1, a0, a1);
    shapes.push(
      <G key={key} opacity={g.opacity}>
        <Path
          d={d}
          fill={tone === 'accent' ? (props.accentColor ?? theme.colors.accent) : ink}
          opacity={fill}
        />
        {part?.hatched ? <Path d={d} fill={`url(#${id}-hatch)`} /> : null}
        {folded || part?.dotted ? (
          <Path d={d} fill={`url(#${id}-dots)`} />
        ) : null}
        {key === pointed && settled ? (
          <Path d={d} fill="none" stroke={ink} strokeWidth={1.5} />
        ) : null}
      </G>,
    );
    if (!settled || !arc) continue;
    const midAngle = (a0 + a1) / 2;
    const [mx, my] = point(cx, cy, (g.r0 + g.r1) / 2, midAngle);
    // A protected part carries a lock; a collected part a chip with its name (lab MU), both at the arc's middle.
    if (part?.locked && g.r1 - g.r0 >= 14) {
      marks.push(<Path key={`${key}-lock`} d={`M${mx - 3},${my - 1}h6v5h-6z M${mx - 1.8},${my - 1}v-1.6a1.8,1.8 0 0 1 3.6,0v1.6`}
        fill="none" stroke={theme.colors.secondaryText} strokeWidth={1.2} />);
    }
    if (part?.hatched && depth > 0) {
      const chipWidth = (part.label.length * 6.3) + 12;
      marks.push(
        <G key={`${key}-chip`}>
          <Rect x={mx - chipWidth / 2} y={my - 9} width={chipWidth} height={18} rx={5} fill={theme.colors.surface} stroke={theme.colors.text} strokeWidth={1} />
          <SvgText x={mx} y={my + 4} fontSize={11} fontWeight="600" textAnchor="middle" fill={theme.colors.text}>{part.label}</SvgText>
        </G>,
      );
      continue;
    }
    const mid = (g.r0 + g.r1) / 2;
    const name =
      folded && arc.folded
        ? props.smallerLabel(arc.folded.length)
        : (part?.label ?? '');
    const value = folded ? '' : (part?.valueLabel ?? '');
    const room = mid * (a1 - a0) - 14;
    if (!folded && room >= name.length * 6.6 && g.r1 - g.r0 >= 16) {
      const pathId = `${id}-l${labels.length}`;
      const withValue = room >= (name.length + value.length) * 6.4 + 10;
      labels.push(
        <G key={pathId}>
          <Defs>
            <Path id={pathId} d={labelPath(cx, cy, mid, a0, a1)} />
          </Defs>
          <SvgText
            fontSize={depth === 0 ? 12 : 11}
            fontWeight={depth === 0 ? '600' : '400'}
            fill={theme.colors.text}
            dy={4}
          >
            <TextPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
              {withValue ? `${name}  ${value}` : name}
            </TextPath>
          </SvgText>
        </G>,
      );
    } else if (depth === 0) {
      // Too short for its name: it goes outside on a leader, from the outermost ring its branch reaches.
      const reach = Math.max(
        ...arcs
          .filter((entry) => rootOf(entry.key) === key)
          .map((entry) => rings[entry.depth]!.outer),
      );
      outside.push({
        key,
        a: (a0 + a1) / 2,
        ro: reach,
        name,
        value,
        quiet: folded,
      });
    }
  }
  if (settled && props.gapLabel && gapRadians > 0) {
    outside.push({
      key: '\u0000gap',
      a: Math.PI * 2 - gapRadians / 2,
      ro: outer.outer,
      name: props.gapLabel.name,
      value: props.gapLabel.note,
      quiet: true,
    });
  }
  const leaders = placeHappierSunburstLeaders(outside, {
    cx,
    cy,
    radius: outer.outer + LEADER_GAP_PX,
    height,
  });
  const tooltipAt =
    pointed && pointer && props.renderTooltip
      ? {
          left: Math.min(Math.max(0, pointer.x + 14), Math.max(0, width - 240)),
          top: Math.min(Math.max(0, pointer.y + 14), Math.max(0, height - 96)),
        }
      : null;
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={props.accessibilityLabel}
      // Above what follows the chart (its key, the list), so a tooltip near the bottom edge is never covered.
      style={{ width, height, position: 'relative', zIndex: 1 }}
      onStartShouldSetResponder={() => true}
      onResponderRelease={(event: GestureResponderEvent) => {
        const at = locate(event);
        if (inHole(at.x, at.y)) {
          props.onUp?.();
          return;
        }
        const key = hit(at.x, at.y);
        if (key) props.onOpen?.(key);
      }}
      tabIndex={0}
      {...webHandlers}
    >
      <Animated.View style={{ opacity: fade }}>
        <Svg accessible={false} aria-hidden width={width} height={height}>
          <Defs>
            <Pattern
              id={`${id}-hatch`}
              width={5}
              height={5}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <Rect width={1.6} height={5} fill={ink} opacity={0.55} />
            </Pattern>
            <Pattern
              id={`${id}-dots`}
              width={5}
              height={5}
              patternUnits="userSpaceOnUse"
            >
              <Circle cx={1.5} cy={1.5} r={0.9} fill={ink} opacity={0.42} />
            </Pattern>
          </Defs>
          <Circle
            cx={cx}
            cy={cy}
            r={rings[0]!.inner - 4}
            fill={theme.colors.surface}
          />
          {shapes}
          {labels}
          {marks}
          {leaders.map((leader) => (
            <G key={leader.key}>
              <Path
                d={`M${leader.sx},${leader.sy}L${leader.x},${leader.y}h${leader.right ? 8 : -8}`}
                fill="none"
                stroke={theme.colors.mutedText}
                strokeWidth={1}
              />
              <SvgText
                x={leader.x + (leader.right ? 12 : -12)}
                y={leader.y + 4}
                fontSize={11}
                textAnchor={leader.right ? 'start' : 'end'}
                fill={
                  leader.quiet ? theme.colors.secondaryText : theme.colors.text
                }
              >
                <TSpan fontWeight={leader.quiet ? '400' : '600'}>{leader.name}</TSpan>
                {leader.value ? <TSpan fontWeight="400" fill={theme.colors.secondaryText}>{`  ${leader.value}`}</TSpan> : null}
              </SvgText>
            </G>
          ))}
          {props.upLabel ? (
            <SvgText
              x={cx}
              y={cy - 22 * scale}
              fontSize={11}
              fill={theme.colors.secondaryText}
              textAnchor="middle"
            >{`↑ ${props.upLabel}`}</SvgText>
          ) : null}
          <SvgText
            x={cx}
            y={cy + (props.upLabel ? 0 : -4)}
            fontSize={13}
            fontWeight="600"
            fill={theme.colors.text}
            textAnchor="middle"
          >
            {fitText(props.centerLabel, (rings[0]!.inner - 4) * 2 - 12, 13, 'semibold')}
          </SvgText>
          <SvgText
            x={cx}
            y={cy + (props.upLabel ? 22 : 18) * Math.max(0.8, scale)}
            fontSize={18}
            fontWeight="600"
            fill={theme.colors.text}
            textAnchor="middle"
          >
            {props.centerValue}
          </SvgText>
        </Svg>
      </Animated.View>
      {tooltipAt && pointed ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', zIndex: 2, ...tooltipAt }}
        >
          {props.renderTooltip!(pointed)}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Outside labels on each side of the circle, kept apart (lab MU): each starts at its arc's angle just
 * outside its branch, runs to a column at `radius`, and labels on one side never overlap.
 */
export function placeHappierSunburstLeaders(
  labels: readonly OutsideLabel[],
  frame: Readonly<{ cx: number; cy: number; radius: number; height: number }>,
): readonly HappierSunburstLeader[] {
  const out: HappierSunburstLeader[] = [];
  for (const right of [true, false]) {
    const side = labels
      .filter((label) => Math.sin(label.a) >= 0 === right)
      .map((label) => {
        const [x, y] = point(frame.cx, frame.cy, frame.radius, label.a);
        const [sx, sy] = point(frame.cx, frame.cy, label.ro + 3, label.a);
        return {
          key: label.key,
          name: label.name,
          value: label.value,
          quiet: label.quiet,
          x,
          y,
          sx,
          sy,
          right,
        };
      })
      .sort((a, b) => a.y - b.y);
    for (let index = 1; index < side.length; index++) {
      if (side[index]!.y - side[index - 1]!.y < LABEL_SPACING_PX)
        side[index]!.y = side[index - 1]!.y + LABEL_SPACING_PX;
    }
    // Pushed past the bottom: settle back up from the last one.
    for (let index = side.length - 1; index >= 0; index--) {
      const limit =
        index === side.length - 1
          ? frame.height - 6
          : side[index + 1]!.y - LABEL_SPACING_PX;
      if (side[index]!.y > limit) side[index]!.y = limit;
    }
    out.push(...side);
  }
  return out;
}
