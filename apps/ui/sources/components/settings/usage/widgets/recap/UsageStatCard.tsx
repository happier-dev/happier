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
import { createPlanetFrame } from '@happier-dev/brand/planet';
import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import { CompositionStrip, formatHappierDataShare } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { UsageAgentMark } from '../usageBodyKit';
import type { UsageStatCardMixGroup, UsageStatCardModel } from './usageStatCardModel';
import {
  USAGE_STAT_CARD_SIZES,
  fitUsageStatFigureSize,
  USAGE_STAT_CARD_TYPE,
  resolveUsageStatCardLayout,
  resolveUsageStatCardPalette,
  type UsageStatCardLayout,
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
    const drawnGroups = React.useMemo(() => drawnMixGroups(model), [model]);
    const factCount = model.stats.filter((stat) => stat.tier === undefined).length;
    const palette = React.useMemo(
      () => resolveUsageStatCardPalette(model.style, props.tone),
      [model.style, props.tone],
    );
    const panel = palette.panel !== undefined;
    const layout = resolveUsageStatCardLayout(model.format, factCount, drawnGroups.length, {
      hasLead: model.stats.some((stat) => stat.tier === 'lead'),
      hasComparisons: model.stats.some((stat) => stat.tier === 'comparison'),
      hasHeadline: model.headline !== null,
      mixRowCount: Math.max(0, ...drawnGroups.map((group) => group.rows.length)),
      panel,
      wrapsLabels: panel || palette.mono,
    });
    const mixGroups = React.useMemo(
      () => drawnGroups.map((group) => foldMixTail(group, layout.mixRows)),
      [drawnGroups, layout.mixRows],
    );
    const size = USAGE_STAT_CARD_SIZES[model.format];
    const wide = model.format === 'link-preview';
    const story = model.format === 'story';
    const pad = wide ? 32 : 40;
    const gradientId = `card-bg-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
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
        <CardPlanetArt model={model} palette={palette} tone={props.tone} width={size.width} height={size.height} />
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
          {/* A story's art fills its top, so its date leads the bottom stack and never sits on the art. */}
          {story ? null : <CardLine palette={palette} text={model.periodLabel} />}
          <View
            style={{
              gap: layout.gap,
              ...(story ? { marginTop: 'auto' } : {}),
            }}
          >
            {story ? <CardLine palette={palette} text={model.periodLabel} /> : null}
            {model.headline ? (
              <Headline model={model} palette={palette} size={layout.headline} />
            ) : null}
            {mixGroups.length > 0 ? (
              <View style={{ gap: layout.gap, flexDirection: layout.mixesInline ? 'row' : 'column' }}>
                {mixGroups.map((group) => (
                  <View key={group.kind} style={{ flex: 1 }}>
                    <MixBar group={group} palette={palette} />
                  </View>
                ))}
              </View>
            ) : null}
            {model.stats.length > 0 ? (
              <Stats model={model} palette={palette} layout={layout}
                width={(wide ? size.width * 0.62 : size.width) - pad * 2} />
            ) : null}
            <CardFooter model={model} palette={palette} />
          </View>
        </View>
      </View>
    );
  }),
);

/** Selected populations that have something to draw; each keeps its own caption and denominator. */
function drawnMixGroups(model: UsageStatCardModel): readonly UsageStatCardMixGroup[] {
  return model.mixGroups.filter((group) => group.rows.length > 0);
}

/**
 * A fixed-size image keeps the largest shares and folds the rest into one "+N more" share, so the legend
 * fits its canvas and every token is still counted.
 */
function foldMixTail(group: UsageStatCardMixGroup, limit: number | null): UsageStatCardMixGroup {
  if (limit === null || group.rows.length <= limit) return group;
  const kept = group.rows.slice(0, limit - 1);
  const tail = group.rows.slice(limit - 1);
  return {
    ...group,
    rows: [...kept, {
      id: `${group.kind}-more`,
      share: tail.reduce((sum, row) => sum + row.share, 0),
      label: t('usage.board.recap.mixMore', { count: tail.length }),
    }],
  };
}

function mixCaption(group: UsageStatCardMixGroup): string {
  const name = t(group.kind === 'agentMix' ? 'usage.board.recap.field_agentMix' : 'usage.board.recap.field_modelMix');
  return group.totalTokens === null ? name : [name, `${formatTokenCount(group.totalTokens)} ${t('usage.board.recap.tokensUnit')}`,
    group.tokensFromParts ? t('usage.board.page.tokensFromParts') : null].filter(Boolean).join(' · ');
}

function describeCard(model: UsageStatCardModel): string {
  return [
    model.periodLabel,
    model.headline ? `${model.headline.value} ${model.headline.unit}` : null,
    ...drawnMixGroups(model).flatMap((group) => [
      mixCaption(group),
      ...group.rows.map((row) => [row.label, formatHappierDataShare(row.share)].filter(Boolean).join(' ')),
    ]),
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
  props: Readonly<{ model: UsageStatCardModel; palette: UsageStatCardPalette; size: number }>,
) {
  const { model, palette, size } = props;
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
  props: Readonly<{ group: UsageStatCardMixGroup; palette: UsageStatCardPalette }>,
) {
  const { group, palette } = props;
  const { theme: appTheme } = useUnistyles();
  const theme = usePluginUiTheme(appTheme);
  const caption = mixCaption(group);
  return (
    <View style={{ gap: 6 }}>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={{
          ...font(palette, 'regular'),
          fontSize: USAGE_STAT_CARD_TYPE.legend,
          color: palette.inkSecondary,
        }}
      >
        {caption}
      </Text>
      <CompositionStrip theme={{ ...theme, colors: { ...theme.colors,
        text: palette.ink, mutedText: palette.inkSecondary, controlDisabled: palette.rule } }}
        label={caption}
        total={1} valueKind="share" segments={group.rows.map((row, index) => ({ id: row.id, label: row.label ?? '', value: row.share,
          color: palette.series[index % palette.series.length],
          ...(row.agentId ? { mark: <UsageAgentMark agentId={row.agentId} serverId={null} size={USAGE_STAT_CARD_TYPE.legend} color={palette.inkSecondary} /> } : {}) }))}
        appearance={{ legend: 'compact', height: 6, allowFontScaling: false,
          textStyle: { ...font(palette, 'regular'), fontSize: USAGE_STAT_CARD_TYPE.legend, color: palette.inkSecondary } }}
        shareFormatter={share => `${Math.round(share * 100)}%`} />
    </View>
  );
}

function Stats(
  props: Readonly<{
    model: UsageStatCardModel;
    palette: UsageStatCardPalette;
    layout: UsageStatCardLayout;
    /** The stats block's own width; each figure fits its cell from it. */
    width: number;
  }>,
) {
  const { palette, model, layout: grid } = props;
  const panel = palette.panel;
  const inner = props.width - (panel ? 2 * 4 + 2 : 0);
  // The selected total leads and its comparisons sit quieter beneath it; with no selected total the
  // comparisons lead at full ink. Every other fact keeps the grid.
  const lead = model.stats.filter((stat) => stat.tier === 'lead');
  const comparisons = model.stats.filter((stat) => stat.tier === 'comparison');
  const facts = model.stats.filter((stat) => stat.tier === undefined);
  const comparisonColumns = Math.max(1, Math.min(comparisons.length, 3));
  return (
    <View
      style={[
        {
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
      {lead.map((stat, index) => (
        <View key={`lead-${index}`} style={{ paddingVertical: grid.cellPadding, paddingHorizontal: panel ? 8 : 0 }}>
          <StatFigure stat={stat} palette={palette} value={Math.round(grid.value * 1.5)} label={grid.label} width={inner - (panel ? 16 : 0)} />
        </View>
      ))}
      {comparisons.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingBottom: grid.cellPadding, paddingHorizontal: panel ? 8 : 0 }}>
          {comparisons.map((stat, index) => (
            <View
              key={`comparison-${index}`}
              style={{ width: `${100 / comparisonColumns}%`, paddingRight: 10, paddingTop: grid.cellPadding }}
            >
              <StatFigure
                stat={stat}
                palette={palette}
                value={lead.length > 0 ? Math.max(12, Math.round(grid.value * 0.75)) : grid.value}
                label={grid.label}
                quiet={lead.length > 0}
                width={(inner - (panel ? 16 : 0)) / comparisonColumns - 10}
              />
            </View>
          ))}
        </View>
      ) : null}
      {facts.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            ...(lead.length > 0 ? { borderTopWidth: 1, borderTopColor: palette.rule } : {}),
          }}
        >
          {facts.map((stat, index) => {
            const first = index % grid.columns === 0;
            return (
              <View
                key={`${stat.id}-${index}`}
                style={{
                  width: `${100 / grid.columns}%`,
                  paddingVertical: grid.cellPadding,
                  // Five across the short link-preview column leave a figure just enough room to stay on one line.
                  paddingRight: grid.columns >= 5 ? 4 : 10,
                  borderLeftWidth: first || panel ? 0 : 1,
                  borderLeftColor: palette.rule,
                  paddingLeft: first && !panel ? 0 : grid.columns >= 5 ? 6 : 12,
                }}
              >
                <StatFigure stat={stat} palette={palette} value={grid.value} label={grid.label}
                  width={inner / grid.columns - (grid.columns >= 5 ? 4 : 10) - (first && !panel ? 0 : grid.columns >= 5 ? 7 : 13)} />
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** One value over its label; a quiet figure (a comparison) takes the secondary ink. */
function StatFigure(
  props: Readonly<{
    stat: UsageStatCardModel['stats'][number];
    palette: UsageStatCardPalette;
    value: number;
    label: number;
    quiet?: boolean;
    /** The cell's width: the figure steps down to stay on one line rather than wrap its unit. */
    width: number;
  }>,
) {
  const { palette, stat } = props;
  const value = fitUsageStatFigureSize(stat.value, props.value, props.width);
  return (
    <>
      <Text
        allowFontScaling={false}
        style={{
          ...font(palette, 'semiBold'),
          fontSize: value,
          lineHeight: value * 1.15,
          letterSpacing: palette.mono ? 0 : -value * 0.027,
          color: props.quiet ? palette.inkSecondary : palette.ink,
          fontVariant: ['tabular-nums'],
        }}
      >
        {stat.value}
      </Text>
      <Text
        allowFontScaling={false}
        style={{
          ...font(palette, 'regular'),
          fontSize: props.label,
          color: palette.inkSecondary,
        }}
      >
        {stat.label}
      </Text>
    </>
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
      return null;
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

/** Existing stat-card calibration, projected through the canonical drawing layer. */
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
  const mark = React.useMemo(
    () => ({
        size: props.size,
        rows: props.rows,
        theme: props.tone,
        halo: props.halo ?? 1,
        warmth: props.warmth ?? 0,
        radiusScale: 1.3,
      }),
    [props.size, props.rows, props.tone, props.halo, props.warmth],
  );
  return (
    <PlanetCanvas width={props.size} height={props.size} mark={mark} style={{ position: 'absolute', left: props.x, top: props.y }} />
  );
}

function CardPlanetArt(props: ArtProps) {
  const wide = props.model.format === 'link-preview';
  switch (props.palette.art) {
    case 'planet': return <DaybreakArt {...props} />;
    case 'sigil': {
      const { radius, cx, cy } = sigilArtLayout(props);
      return <PlanetDots x={cx - radius * 0.42} y={cy - radius * 0.42} size={radius * 0.84} rows={18} tone={props.tone} />;
    }
    case 'rules': return <PlanetDots x={props.width - 120} y={52} size={72} rows={14} tone={props.tone} />;
    case 'holo': return <PlanetDots x={props.width - (wide ? 230 : 210)} y={36} size={170} rows={30} tone="dark" warmth={0.2} />;
    default: return null;
  }
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

function sigilArtLayout(props: ArtProps) {
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
  return { radius, cx, cy };
}

function SigilArt(props: ArtProps) {
  const { radius, cx, cy } = sigilArtLayout(props);
  const rows = drawnMixGroups(props.model).flatMap((group) => group.rows);
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
