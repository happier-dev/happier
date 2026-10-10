import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { createPlanetDots, createPlanetFrame } from '@happier-dev/brand/planet';
import { CompositionStrip, formatHappierDataShare } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsageStatCardModel } from './usageStatCardModel';
import {
  USAGE_STAT_CARD_SIZES,
  USAGE_STAT_CARD_TYPE,
  resolveUsageStatCardPalette,
  type UsageStatCardPalette,
  type UsageStatCardTone,
} from './usageStatCardStyles';

/**
 * The one private stat-card renderer (lab s2card): every style and format draws the same composed
 * facts through the same parts — period line, headline, mix, stats, footer — over that style's art.
 * Brand planet geometry is the Daybreak art; nothing here reads usage or knows a name the composer did
 * not select. It is drawn at its logical size and captured as the image.
 */
export const UsageStatCard = React.memo(
  React.forwardRef<
    View,
    Readonly<{
      model: UsageStatCardModel;
      tone: UsageStatCardTone;
      style?: StyleProp<ViewStyle>;
      testID?: string;
    }>
  >(function UsageStatCard(props, ref) {
    const { model } = props;
    const size = USAGE_STAT_CARD_SIZES[model.format];
    const palette = React.useMemo(
      () => resolveUsageStatCardPalette(model.style, props.tone),
      [model.style, props.tone],
    );
    const wide = model.format === 'link-preview';
    const story = model.format === 'story';
    const pad = wide ? 32 : 40;
    const gradientId = `card-bg-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const statCount = wide ? 3 : story ? 6 : 4;
    return (
      <View
        ref={ref}
        collapsable={false}
        testID={props.testID}
        accessible
        accessibilityRole="image"
        accessibilityLabel={describeCard(model)}
        style={[
          {
            width: size.width,
            height: size.height,
            overflow: 'hidden',
            backgroundColor: palette.background,
          },
          props.style,
        ]}
      >
        <Svg
          width={size.width}
          height={size.height}
          style={{ position: 'absolute', left: 0, top: 0 }}
        >
          {palette.backgroundEnd ? (
            <>
              <Defs>
                <LinearGradient id={gradientId} x1="0" y1="0" x2="0.6" y2="1">
                  <Stop offset="0" stopColor={palette.background} />
                  <Stop offset="1" stopColor={palette.backgroundEnd} />
                </LinearGradient>
              </Defs>
              <Rect
                x={0}
                y={0}
                width={size.width}
                height={size.height}
                fill={`url(#${gradientId})`}
              />
            </>
          ) : null}
          <CardArt
            model={model}
            palette={palette}
            tone={props.tone}
            width={size.width}
            height={size.height}
          />
        </Svg>
        {palette.art === 'terminal' ? (
          <TerminalPlanet
            tone={props.tone}
            palette={palette}
            wide={wide}
            story={story}
          />
        ) : null}
        <View
          style={{
            flex: 1,
            padding: pad,
            justifyContent: story ? 'flex-end' : 'space-between',
            ...(wide ? { width: size.width * 0.62 } : {}),
          }}
        >
          <CardLine palette={palette} text={model.periodLabel} />
          <View
            style={{
              gap: story ? 18 : 14,
              ...(story ? { marginTop: 'auto' } : {}),
            }}
          >
            {model.headline ? (
              <Headline model={model} palette={palette} />
            ) : null}
            {model.mix.length > 0 ? (
              <MixBar model={model} palette={palette} />
            ) : null}
            {model.stats.length > 0 ? (
              <Stats model={model} palette={palette} count={statCount} />
            ) : null}
            <CardFooter model={model} palette={palette} />
          </View>
        </View>
      </View>
    );
  }),
);

function describeCard(model: UsageStatCardModel): string {
  return [
    model.periodLabel,
    model.headline ? `${model.headline.value} ${model.headline.unit}` : null,
    ...model.mix.map(row => [row.label, formatHappierDataShare(row.share)].filter(Boolean).join(' ')),
    ...model.stats.map((stat) => `${stat.value} ${stat.label}`),
  ]
    .filter(Boolean)
    .join(', ');
}

function font(palette: UsageStatCardPalette, weight: 'regular' | 'semiBold') {
  return palette.mono ? Typography.mono(weight) : Typography.default(weight);
}

function CardLine(
  props: Readonly<{ palette: UsageStatCardPalette; text: string }>,
) {
  return (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      style={{
        ...font(props.palette, 'regular'),
        fontSize: USAGE_STAT_CARD_TYPE.caption,
        lineHeight: USAGE_STAT_CARD_TYPE.caption * 1.4,
        color: props.palette.inkSecondary,
      }}
    >
      {props.palette.mono
        ? `› ${props.text}`
        : props.text}
    </Text>
  );
}

function Headline(
  props: Readonly<{ model: UsageStatCardModel; palette: UsageStatCardPalette }>,
) {
  const { model, palette } = props;
  const size = USAGE_STAT_CARD_TYPE.headline[model.format];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        columnGap: 10,
      }}
    >
      <Text
        allowFontScaling={false}
        style={{
          ...font(palette, palette.headlineWeight),
          fontSize: size,
          lineHeight: size * 1.02,
          letterSpacing: palette.mono ? 0 : -size * 0.045,
          color: palette.ink,
          fontVariant: ['tabular-nums'],
        }}
      >
        {model.headline!.value}
      </Text>
      <Text
        allowFontScaling={false}
        style={{
          ...font(palette, 'semiBold'),
          fontSize: USAGE_STAT_CARD_TYPE.unit,
          lineHeight: USAGE_STAT_CARD_TYPE.unit * 1.3,
          color: palette.inkSecondary,
        }}
      >
        {model.headline!.unit}
      </Text>
    </View>
  );
}

function MixBar(
  props: Readonly<{ model: UsageStatCardModel; palette: UsageStatCardPalette }>,
) {
  const { model, palette } = props;
  const { theme: appTheme } = useUnistyles();
  const theme = React.useMemo(() => projectPluginUiTheme(appTheme), [appTheme]);
  return <CompositionStrip theme={{ ...theme, colors: { ...theme.colors,
    text: palette.ink, mutedText: palette.inkSecondary, controlDisabled: palette.rule } }}
    label={t(model.manifest.includes('agentMix') ? 'usage.board.recap.field_agentMix' : 'usage.board.recap.field_modelMix')}
    total={1} segments={model.mix.map((row, index) => ({ id: row.id, label: row.label ?? '', value: row.share,
      color: palette.series[index % palette.series.length] }))}
    appearance={{ legend: 'compact', height: 6, allowFontScaling: false,
      textStyle: { ...font(palette, 'regular'), fontSize: USAGE_STAT_CARD_TYPE.legend, color: palette.inkSecondary } }}
    shareFormatter={share => `${Math.round(share * 100)}%`} />;
}

function Stats(
  props: Readonly<{
    model: UsageStatCardModel;
    palette: UsageStatCardPalette;
    count: number;
  }>,
) {
  const { palette } = props;
  const stats = props.model.stats.slice(0, props.count);
  const perRow = props.model.format === 'story' ? 2 : stats.length;
  const panel = palette.panel;
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          borderTopWidth: panel ? 0 : 1,
          borderTopColor: palette.rule,
        },
        panel
          ? {
              backgroundColor: panel.fill,
              borderColor: panel.border,
              borderWidth: 1,
              borderRadius: 14,
              padding: 4,
            }
          : null,
      ]}
    >
      {stats.map((stat, index) => (
        <View
          key={`${stat.id}-${index}`}
          style={{
            width: `${100 / perRow}%`,
            paddingVertical: 12,
            paddingHorizontal: panel ? 12 : 0,
            paddingRight: 10,
            borderLeftWidth: index % perRow === 0 || panel ? 0 : 1,
            borderLeftColor: palette.rule,
            paddingLeft: index % perRow === 0 && !panel ? 0 : 12,
          }}
        >
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={{
              ...font(palette, 'semiBold'),
              fontSize: USAGE_STAT_CARD_TYPE.stat,
              lineHeight: USAGE_STAT_CARD_TYPE.stat * 1.15,
              letterSpacing: palette.mono ? 0 : -0.8,
              color: palette.ink,
              fontVariant: ['tabular-nums'],
            }}
          >
            {stat.value}
          </Text>
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={{
              ...font(palette, 'regular'),
              fontSize: USAGE_STAT_CARD_TYPE.statLabel,
              color: palette.inkSecondary,
            }}
          >
            {stat.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function CardFooter(
  props: Readonly<{ model: UsageStatCardModel; palette: UsageStatCardPalette }>,
) {
  const { palette } = props;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <Text
        allowFontScaling={false}
        style={{
          ...font(palette, 'regular'),
          fontSize: USAGE_STAT_CARD_TYPE.footer,
          color: palette.inkFaint,
        }}
      >
        {t('usage.board.recap.cardFooter')}
      </Text>
      {props.model.unavailable.length > 0 ? (
        <Text
          allowFontScaling={false}
          style={{
            ...font(palette, 'regular'),
            fontSize: USAGE_STAT_CARD_TYPE.footer,
            color: palette.inkFaint,
          }}
        >
          {t('usage.board.recap.incompleteBadge')}
        </Text>
      ) : null}
    </View>
  );
}

type ArtProps = Readonly<{
  model: UsageStatCardModel;
  palette: UsageStatCardPalette;
  tone: UsageStatCardTone;
  width: number;
  height: number;
}>;

function CardArt(props: ArtProps) {
  switch (props.palette.art) {
    case 'planet':
      return <DaybreakArt {...props} />;
    case 'sigil':
      return <SigilArt {...props} />;
    case 'rules':
      return <EditorialArt {...props} />;
    case 'glass':
      return <GlassArt {...props} />;
    case 'holo':
      return <HoloArt {...props} />;
    case 'skyline':
      return <SkylineArt {...props} />;
    case 'terminal':
      return null;
  }
}

/** Brand planet dots in a box (the one planet source); `rows` sets the lattice fineness. */
function PlanetDots(
  props: Readonly<{
    x: number;
    y: number;
    size: number;
    rows: number;
    tone: UsageStatCardTone;
    warmth?: number;
    halo?: number;
  }>,
) {
  const dots = React.useMemo(
    () =>
      createPlanetDots({
        size: props.size,
        rows: props.rows,
        theme: props.tone,
        halo: props.halo ?? 1,
        warmth: props.warmth ?? 0,
      }).filter((dot) => dot.opacity > 0),
    [props.size, props.rows, props.tone, props.halo, props.warmth],
  );
  return (
    <G x={props.x} y={props.y}>
      {dots.map((dot) => (
        <Circle
          key={dot.id}
          cx={dot.x}
          cy={dot.y}
          r={dot.radius * 1.3}
          fill={`rgb(${dot.rgb[0]},${dot.rgb[1]},${dot.rgb[2]})`}
          opacity={dot.opacity}
        />
      ))}
    </G>
  );
}

function DaybreakArt(props: ArtProps) {
  const story = props.model.format === 'story';
  const wide = props.model.format === 'link-preview';
  const size = story
    ? props.width * 1.3
    : wide
      ? props.height * 1.5
      : props.width * 0.95;
  const x = story
    ? (props.width - size) / 2
    : props.width - size * (wide ? 0.62 : 0.6);
  const y = story ? -size * 0.42 : -size * (wide ? 0.22 : 0.36);
  return (
    <PlanetDots
      x={x}
      y={y}
      size={size}
      rows={story ? 64 : 52}
      tone={props.tone}
      warmth={0.12}
    />
  );
}

function SigilArt(props: ArtProps) {
  const wide = props.model.format === 'link-preview';
  const story = props.model.format === 'story';
  const radius = wide
    ? props.height * 0.38
    : story
      ? props.width * 0.36
      : props.width * 0.24;
  const cx = wide
    ? props.width * 0.8
    : story
      ? props.width / 2
      : props.width - radius - 40;
  const cy = wide ? props.height / 2 : story ? props.height * 0.3 : radius + 40;
  const rows = props.model.mix;
  const ringGap = Math.min(9, radius / (rows.length + 2));
  return (
    <G>
      {(rows.length ? rows : [{ id: 'none', share: 1, label: null }]).map(
        (row, index) => {
          const r = radius - index * ringGap;
          const circumference = 2 * Math.PI * r;
          return (
            <G key={row.id}>
              <Circle
                cx={cx}
                cy={cy}
                r={r}
                stroke={props.palette.rule}
                strokeWidth={3}
                fill="none"
              />
              <Circle
                cx={cx}
                cy={cy}
                r={r}
                stroke={props.palette.series[index % props.palette.series.length]}
                strokeWidth={3}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${circumference * row.share} ${circumference}`}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            </G>
          );
        },
      )}
      <PlanetDots
        x={cx - radius * 0.42}
        y={cy - radius * 0.42}
        size={radius * 0.84}
        rows={18}
        tone={props.tone}
      />
    </G>
  );
}

function EditorialArt(props: ArtProps) {
  return (
    <G>
      <Rect
        x={40}
        y={34}
        width={props.width - 80}
        height={2}
        fill={props.palette.ink}
      />
      <Rect
        x={40}
        y={40}
        width={props.width - 80}
        height={0.75}
        fill={props.palette.ink}
      />
      <PlanetDots
        x={props.width - 120}
        y={52}
        size={72}
        rows={14}
        tone={props.tone}
      />
    </G>
  );
}

function GlassArt(props: ArtProps) {
  const id = `glass-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const s = props.palette.series;
  const blobs = [
    {
      cx: props.width * 0.85,
      cy: props.height * 0.12,
      r: props.width * 0.5,
      color: s[0]!,
    },
    {
      cx: props.width * 0.1,
      cy: props.height * 0.45,
      r: props.width * 0.42,
      color: s[1]!,
    },
    {
      cx: props.width * 0.7,
      cy: props.height * 0.95,
      r: props.width * 0.5,
      color: s[3]!,
    },
  ];
  return (
    <G>
      <Defs>
        {blobs.map((blob, index) => (
          <RadialGradient
            key={index}
            id={`${id}-${index}`}
            cx="50%"
            cy="50%"
            r="50%"
          >
            <Stop offset="0" stopColor={blob.color} stopOpacity={0.85} />
            <Stop offset="1" stopColor={blob.color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {blobs.map((blob, index) => (
        <Circle
          key={index}
          cx={blob.cx}
          cy={blob.cy}
          r={blob.r}
          fill={`url(#${id}-${index})`}
        />
      ))}
    </G>
  );
}

function HoloArt(props: ArtProps) {
  const id = `holo-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const s = props.palette.series;
  const inset = 18;
  return (
    <G>
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          {s.map((color, index) => (
            <Stop
              key={color}
              offset={index / (s.length - 1)}
              stopColor={color}
            />
          ))}
        </LinearGradient>
      </Defs>
      <Rect
        x={inset}
        y={inset}
        width={props.width - inset * 2}
        height={props.height - inset * 2}
        rx={22}
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth={2}
      />
      <Polygon
        points={`${props.width * 0.15},${inset} ${props.width * 0.45},${inset} ${props.width * 0.05},${props.height - inset} ${inset},${props.height - inset}`}
        fill={`url(#${id})`}
        opacity={0.08}
      />
      <PlanetDots
        x={props.width - (props.model.format === 'link-preview' ? 230 : 210)}
        y={36}
        size={170}
        rows={30}
        tone="dark"
        warmth={0.2}
      />
    </G>
  );
}

/** The period's days as an isometric city (lab Skyline): taller towers, busier days; counts only. */
function SkylineArt(props: ArtProps) {
  const days = props.model.days.slice(-84);
  const columns = 12;
  const cells = Array.from(
    { length: columns * 7 },
    (_, index) => days[days.length - columns * 7 + index] ?? 0,
  );
  const max = Math.max(1, ...cells);
  const tile =
    props.model.format === 'link-preview'
      ? 13
      : props.model.format === 'story'
        ? 15
        : 17;
  const originX =
    props.model.format === 'link-preview'
      ? props.width * 0.78
      : props.width / 2 + (props.model.format === 'story' ? 0 : 90);
  const originY =
    props.model.format === 'story'
      ? props.height * 0.16
      : props.model.format === 'link-preview'
        ? 40
        : 70;
  const s = props.palette.series;
  const towers = cells.map((value, index) => {
    const col = Math.floor(index / 7);
    const row = index % 7;
    const height = value > 0 ? 6 + (value / max) * tile * 5 : 1.5;
    const x = originX + (col - row) * tile;
    const y = originY + (col + row) * tile * 0.5;
    const color =
      s[
        Math.min(s.length - 1, Math.floor((1 - value / max) * (s.length - 1)))
      ]!;
    return { key: index, x, y, height, color, faded: value === 0 };
  });
  return (
    <G>
      {towers.map((tower) => {
        const { x, y, height } = tower;
        const top = `${x},${y - height} ${x + tile},${y - height + tile * 0.5} ${x},${y - height + tile} ${x - tile},${y - height + tile * 0.5}`;
        const left = `${x - tile},${y - height + tile * 0.5} ${x},${y - height + tile} ${x},${y + tile} ${x - tile},${y + tile * 0.5}`;
        const right = `${x + tile},${y - height + tile * 0.5} ${x},${y - height + tile} ${x},${y + tile} ${x + tile},${y + tile * 0.5}`;
        return (
          <G key={tower.key} opacity={tower.faded ? 0.25 : 1}>
            <Polygon points={left} fill={tower.color} opacity={0.72} />
            <Polygon points={right} fill={tower.color} opacity={0.88} />
            <Polygon
              points={top}
              fill={tower.faded ? props.palette.rule : tower.color}
            />
          </G>
        );
      })}
    </G>
  );
}

/** The Brand planet's own terminal frame (braille cells), as the Terminal style's art. */
function TerminalPlanet(
  props: Readonly<{
    tone: UsageStatCardTone;
    palette: UsageStatCardPalette;
    wide: boolean;
    story: boolean;
  }>,
) {
  const frame = React.useMemo(
    () =>
      createPlanetFrame({
        columns: props.story ? 40 : 30,
        theme: props.tone,
        seconds: 4,
      }),
    [props.story, props.tone],
  );
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        right: props.story ? undefined : 32,
        top: 34,
        ...(props.story
          ? { left: 0, right: 0, alignItems: 'center' as const }
          : {}),
      }}
    >
      {frame.map((row, rowIndex) => (
        <Text
          key={rowIndex}
          allowFontScaling={false}
          style={{
            ...Typography.mono('regular'),
            fontSize: 11,
            lineHeight: 12,
          }}
        >
          {row.map((cell, column) =>
            cell ? (
              <Text
                key={column}
                style={{
                  color: `rgb(${cell.rgb[0]},${cell.rgb[1]},${cell.rgb[2]})`,
                }}
              >
                {cell.ch}
              </Text>
            ) : (
              ' '
            ),
          )}
        </Text>
      ))}
    </View>
  );
}
