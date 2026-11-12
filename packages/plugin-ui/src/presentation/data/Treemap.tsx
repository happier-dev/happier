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
  Text as SvgText,
  TSpan,
} from 'react-native-svg';

import { HappierDecorativeSvg as Svg } from '../content/DecorativeSvg.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import { fitText, textFits } from './chartText.js';
import {
  createHappierTreemapHitGrid,
  layoutHappierTreemap,
  type HappierTreemapNode,
  type HappierTreemapTile,
} from './treemapLayout.js';

/**
 * One drawable part of a folder level. The chart is a picture of the list the host draws beneath it, so
 * every item carries the words the host already has (`valueLabel`) and the host decides each mark:
 * `accent` (the host's own data), `ink` (stepped by rank, so switching views keeps every colour) or `quiet`
 * (folded small items, hidden space). `hatched` overlays what is collected; it never changes the layout.
 */
export type HappierChartPart = Readonly<{
  key: string;
  label: string;
  value: number;
  valueLabel: string;
  tone: 'ink' | 'accent' | 'quiet';
  hatched?: boolean;
  dotted?: boolean;
  locked?: boolean;
  children?: readonly HappierChartPart[];
}>;

export type HappierTreemapProps = Readonly<{
  theme: HappierUiTheme;
  /** The colour of `accent` parts: the host's data accent (its chart language); defaults to the theme accent. */
  accentColor?: string;
  items: readonly HappierChartPart[];
  width: number;
  height: number;
  /** The smallest tile that is its own labelled node (the host's shared chart geometry). */
  minNodePx: Readonly<{ width: number; height: number }>;
  /** The level's picture, named as the list beneath it. */
  accessibilityLabel: string;
  /** "Smaller items" for a fold of `count` parts. */
  smallerLabel: (count: number) => string;
  /** The pointed-at part; shared with the list beneath (one view model). */
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

const GAP_PX = 2;
const HEADER_PX = 34;
/** Ink steps by rank (the first part is the darkest), the same steps the Rings use. */
const INK_STEPS = [0.17, 0.14, 0.12, 0.1, 0.09, 0.08, 0.07, 0.06] as const;

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

function toNodes(items: readonly HappierChartPart[]): HappierTreemapNode[] {
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

/**
 * A squarified treemap of one folder level (two levels where a tile has room), drawn with
 * `react-native-svg`. Layout is computed here from the served items and the host's pixel geometry;
 * marks are overlays; hit-testing uses a bucket grid; the chart is one tab stop with arrows to move,
 * Enter to open, Space to collect and Backspace or Escape to go up.
 */
export function Treemap(props: HappierTreemapProps) {
  const accessibility = useOptionalHappierUiAccessibility();
  // A host that owns its motion preference (core: OS setting plus the app's visual effects) passes it; plugin
  // surfaces read it from the environment.
  const reducedMotion = props.reducedMotion ?? accessibility?.reducedMotion === true;
  const id = `tm-${useId().replace(/[^a-z0-9]/giu, '')}`;
  const { width, height } = props;
  const nodes = useMemo(() => toNodes(props.items), [props.items]);
  const parts = useMemo(() => indexParts(props.items), [props.items]);
  const { tiles } = useMemo(
    () =>
      layoutHappierTreemap(nodes, {
        width,
        height,
        minNodePx: props.minNodePx,
        gapPx: GAP_PX,
        headerPx: HEADER_PX,
      }),
    [nodes, width, height, props.minNodePx],
  );
  const hit = useMemo(
    () => createHappierTreemapHitGrid(tiles, { width, height }),
    [tiles, width, height],
  );
  const order = useMemo(
    () => tiles.map((tile) => tile.key),
    [tiles],
  );
  const rank = useMemo(
    () =>
      new Map(
        tiles
          .filter((tile) => tile.depth === 0)
          .map((tile, index) => [tile.key, index]),
      ),
    [tiles],
  );
  const [internalPointed, setInternalPointed] = useState<string | null>(null);
  const pointed =
    props.pointedKey === undefined ? internalPointed : props.pointedKey;
  const point = (key: string | null) => {
    if (key === pointed) return;
    setInternalPointed(key);
    props.onPointAt?.(key);
  };

  // A new level cross-fades in; reduced motion swaps at once.
  const fade = useRef(new Animated.Value(1)).current;
  const levelKey = props.items.map((item) => item.key).join('\u0000');
  useEffect(() => {
    if (reducedMotion) {
      fade.setValue(1);
      return;
    }
    fade.setValue(0.35);
    const animation = Animated.timing(fade, {
      toValue: 1,
      duration: HAPPIER_MOTION_V1.baseMs,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [fade, levelKey, reducedMotion]);

  const at = (event: PointerEvent) => {
    const x = event.nativeEvent.offsetX ?? event.nativeEvent.locationX ?? -1;
    const y = event.nativeEvent.offsetY ?? event.nativeEvent.locationY ?? -1;
    return hit(x, y);
  };
  const onKeyDown = (event: KeyEvent) => {
    const key = event.key ?? event.nativeEvent?.key;
    const index = pointed ? order.indexOf(pointed) : -1;
    const move = (step: number) => {
      event.preventDefault?.();
      const next =
        order[
          Math.max(0, Math.min(order.length - 1, index < 0 ? 0 : index + step))
        ];
      if (next) point(next);
    };
    switch (key) {
      case 'ArrowRight':
      case 'ArrowDown':
        move(1);
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        move(-1);
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
    onPointerMove: (event: PointerEvent) => point(at(event)),
    onPointerLeave: () => point(null),
    onKeyDown,
  };

  const ink = props.theme.colors.text;
  const pointedTile = pointed
    ? (tiles.find((tile) => tile.key === pointed) ?? null)
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
        const key = at(event);
        if (key) props.onOpen?.(key);
      }}
      tabIndex={0}
      {...webHandlers}
    >
      <Animated.View style={{ opacity: fade }}>
        <Svg width={width} height={height}>
          <Defs>
            <Pattern
              id={`${id}-hatch`}
              width={6}
              height={6}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <Rect width={1.6} height={6} fill={ink} opacity={0.55} />
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
          {tiles.map((tile) => (
            <TreemapTileShape
              key={tile.key}
              id={id}
              tile={tile}
              part={parts.get(tile.key) ?? null}
              theme={props.theme}
              accentColor={props.accentColor ?? props.theme.colors.accent}
              rank={rank.get(tile.parentKey ?? tile.key) ?? 0}
              pointed={tile.key === pointed}
              smallerLabel={props.smallerLabel}
            />
          ))}
        </Svg>
      </Animated.View>
      {pointedTile && props.renderTooltip ? (
        <View
          pointerEvents="none"
          style={tooltipPosition(pointedTile, width, height)}
        >
          {props.renderTooltip(pointedTile.key)}
        </View>
      ) : null}
    </View>
  );
}

function tooltipPosition(
  tile: HappierTreemapTile,
  width: number,
  height: number,
) {
  const below = tile.rect.y + tile.rect.height + 6;
  const top =
    below + 88 > height
      ? Math.max(0, tile.rect.y + tile.rect.height / 2)
      : below;
  const left = Math.min(Math.max(0, tile.rect.x), Math.max(0, width - 240));
  return { position: 'absolute' as const, top, left, zIndex: 2 };
}

function TreemapTileShape(
  props: Readonly<{
    id: string;
    tile: HappierTreemapTile;
    part: HappierChartPart | null;
    theme: HappierUiTheme;
    accentColor: string;
    rank: number;
    pointed: boolean;
    smallerLabel: (count: number) => string;
  }>,
) {
  const { tile, part, theme } = props;
  const { x, y, width, height } = tile.rect;
  if (width <= 0 || height <= 0) return null;
  const folded = tile.folded !== null;
  const tone = folded ? 'quiet' : (part?.tone ?? 'ink');
  const fill = tone === 'accent' ? props.accentColor : theme.colors.text;
  const step = INK_STEPS[Math.min(props.rank, INK_STEPS.length - 1)]!;
  const opacity =
    tone === 'accent'
      ? tile.depth === 0
        ? 0.24
        : 0.3
      : tone === 'quiet'
        ? 0.05
        : tile.depth === 0
          ? step
          : step * 0.8 + 0.04;
  const label = folded
    ? props.smallerLabel(tile.folded!.length)
    : (part?.label ?? '');
  const valueLabel = folded ? '' : (part?.valueLabel ?? '');
  const radius = tile.depth === 0 ? 5 : 3;
  // Room for words: the tile's width less its padding (and the lock mark when it has one).
  const room = width - 14 - (part?.locked ? 18 : 0);
  // A child names itself in weight and its size quietly after, when both fit (lab MT); else its cut name.
  const kidValue = textFits(`${label}  ${valueLabel}`, room, 11, 'semibold') ? valueLabel : '';
  const kidName = kidValue ? label : fitText(label, room, 11, 'semibold');
  return (
    <G>
      {tile.depth === 1 && tone === 'ink' ? (
        <Rect x={x} y={y} width={width} height={height} rx={radius} fill={theme.colors.surface} opacity={0.5}
          stroke={theme.colors.text} strokeOpacity={0.12} strokeWidth={1} />
      ) : (
        <Rect x={x} y={y} width={width} height={height} rx={radius} fill={fill} opacity={opacity} />
      )}
      {part?.hatched ? (
        <Rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={radius}
          fill={`url(#${props.id}-hatch)`}
        />
      ) : null}
      {folded || part?.dotted ? (
        <Rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={radius}
          fill={`url(#${props.id}-dots)`}
        />
      ) : null}
      {props.pointed ? (
        <Rect
          x={x + 0.75}
          y={y + 0.75}
          width={Math.max(0, width - 1.5)}
          height={Math.max(0, height - 1.5)}
          rx={radius}
          fill="none"
          stroke={theme.colors.text}
          strokeWidth={1.5}
        />
      ) : null}
      {part?.hatched && tile.labeled ? (
        <G>
          <Rect
            x={x + 4}
            y={y + 4}
            width={Math.min(width - 8, label.length * 6.4 + 12)}
            height={18}
            rx={5}
            fill={theme.colors.surface}
            stroke={theme.colors.text}
            strokeWidth={1}
          />
          <SvgText
            x={x + 10}
            y={y + 17}
            fontSize={11}
            fontWeight="600"
            fill={theme.colors.text}
          >
            {fitText(label, room - 8, 11, 'semibold')}
          </SvgText>
        </G>
      ) : tile.labeled ? (
        tile.depth === 0 ? (
          <G>
            <SvgText
              x={x + 8}
              y={y + 15}
              fontSize={12}
              fontWeight="600"
              fill={theme.colors.text}
            >
              {fitText(label, room, 12, 'semibold')}
            </SvgText>
            <SvgText
              x={x + 8}
              y={y + 29}
              fontSize={11}
              fill={theme.colors.secondaryText}
            >
              {fitText(valueLabel, room, 11)}
            </SvgText>
          </G>
        ) : (
          <SvgText x={x + 6} y={y + 14} fontSize={11} fill={theme.colors.text}>
            <TSpan fontWeight="600">{kidName}</TSpan>
            {kidValue ? <TSpan fill={theme.colors.secondaryText}>{`  ${kidValue}`}</TSpan> : null}
          </SvgText>
        )
      ) : null}
      {part?.locked && width >= 18 && height >= 18 ? (
        <Path
          d={lockPath(x + width - 16, y + 6)}
          fill="none"
          stroke={theme.colors.secondaryText}
          strokeWidth={1.2}
        />
      ) : null}
    </G>
  );
}

function lockPath(x: number, y: number) {
  return `M${x + 2},${y + 5}h6v5h-6z M${x + 3.2},${y + 5}v-1.6a1.8,1.8 0 0 1 3.6,0v1.6`;
}

