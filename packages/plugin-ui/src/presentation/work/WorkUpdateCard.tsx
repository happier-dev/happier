import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';
import {
  resolveHappierWorkStatusSurfaceStyle,
  resolveHappierWorkStatusWordColor,
  softenHappierWorkColor,
  type HappierWorkStatusTone,
} from './workStatus.js';
import {
  resolveHappierWorkHost,
  useHappierWorkTheme,
  type HappierWorkHost,
  type HappierWorkTextRole,
  type HappierWorkTheme,
} from './workTheme.js';

/**
 * A Work update card: what came back from one unit of agent work, as a transcript or a feed states
 * it (unified-work lab `cards-T1`/`T2`). One anatomy for every kind of work:
 *
 * - head: the work's mark · its title · the owner's state word · a quiet kind and age;
 * - body: the result, in the caller's own content;
 * - footer: a quiet leading action (peek, ask a follow-up), facts as chips, then the actions — at
 *   most one of them primary, and only on work that needs the person.
 *
 * Healthy work stays neutral. Work that needs the person or failed carries the one status
 * treatment: a soft full ring, a faint tint and its state word in the tone, never a coloured edge.
 *
 * The card is presentational: it takes strings, nodes and a tone. A host maps its own facts onto
 * them (Happier core maps its worker updates; a plugin maps the work it started).
 *
 * Extracted from Happier core's `WorkerUpdateCard`, which now binds this frame to the app's card
 * material, text owner, Agent marks and buttons.
 */

/** The size a head mark is drawn at. */
export const HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX = 15;

/** The size a footer fact's icon is drawn at. */
export const HAPPIER_WORK_UPDATE_CARD_FACT_ICON_SIZE_PX = 13;

export type HappierWorkUpdateCardFact = Readonly<{
  /** Stable within the card: its key and the end of its test id. */
  id: string;
  /** A 13pt glyph before the label, in the quietest ink. */
  icon?: ReactNode;
  /** A string is drawn in the card's fact text; a node is the caller's own text. */
  label: ReactNode;
}>;

export type HappierWorkUpdateCardProps = Readonly<{
  testID: string;
  /** Prefix of the slot test ids (`-title`, `-state`, `-kind`, `-footer`, `-fact:<id>`); defaults to `testID`. */
  slotTestIDPrefix?: string;
  /** `attention` and `danger` ring and tint the card; `neutral` keeps it quiet. */
  tone: HappierWorkStatusTone;
  /** The work's mark (an Agent mark, a kind glyph), drawn at 15pt. */
  mark: ReactNode;
  /** A string is drawn in the card's own text; a node is the caller's own text (a find-aware host). */
  title: ReactNode;
  /** The owner's own state word ("finished its turn", "needs you"). */
  state?: ReactNode;
  /** The kind and age at the trailing edge ("Background run · 41s"). */
  meta?: ReactNode;
  /** The result. */
  children?: ReactNode;
  facts?: readonly HappierWorkUpdateCardFact[];
  /** One quiet action that opens the footer (peek, ask a follow-up). */
  leadingAction?: ReactNode;
  /** The actions that close the footer; at most one primary. */
  actions?: ReactNode;
  /** Omitted inside a mounted plugin surface: the environment's theme. */
  theme?: HappierWorkTheme;
  /** Omitted inside a mounted plugin surface: the environment's text. */
  host?: HappierWorkHost;
  /**
   * The card the update stands on. Happier core passes its own card material; omitted, the card is a
   * plain bordered surface in the theme.
   */
  renderSurface?: (surface: HappierWorkUpdateCardSurface) => ReactNode;
}>;

/** What a host's card receives from a Work update card. */
export type HappierWorkUpdateCardSurface = Readonly<{
  testID: string;
  /** The tone's ring and tint (`resolveHappierWorkStatusSurfaceStyle`); `null` while the work is healthy. */
  toneStyle: HappierPortableStyle | null;
  children: ReactNode;
}>;

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingTop: 11,
  },
  headAlone: { paddingBottom: 11 },
  mark: { flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  // The title keeps its words; the state word and the kind give way first.
  title: { flexShrink: 1, minWidth: 0, maxWidth: '62%' },
  word: { flexShrink: 2, minWidth: 0 },
  grow: { flexGrow: 1 },
  kind: { flexShrink: 3, minWidth: 0 },
  body: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 13 },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 6,
    rowGap: 6,
    minWidth: 0,
    paddingLeft: 14,
    paddingRight: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 5, marginRight: 8, minWidth: 0, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 6 },
});

export const HappierWorkUpdateCard = memo(function HappierWorkUpdateCard(props: HappierWorkUpdateCardProps) {
  const theme = useHappierWorkTheme(props.theme);
  const host = resolveHappierWorkHost(props.host);
  const { Text } = host;
  const prefix = props.slotTestIDPrefix ?? props.testID;
  const facts = props.facts ?? [];
  const hasBody = props.children !== undefined && props.children !== null && props.children !== false;
  const hasFooter = facts.length > 0 || Boolean(props.leadingAction) || Boolean(props.actions);
  const toneStyle = resolveHappierWorkStatusSurfaceStyle(props.tone, theme.colors);
  const wordColor = resolveHappierWorkStatusWordColor(props.tone, theme.colors);

  const slot = (value: ReactNode, role: HappierWorkTextRole, color: string, testID: string, strong = false) => (
    typeof value === 'string'
      ? <Text role={role} strong={strong} numberOfLines={1} testID={testID} style={{ color }}>{value}</Text>
      : value
  );

  const content = (
    <>
      <View style={[styles.head, hasBody ? null : styles.headAlone]}>
        <View style={styles.mark}>{props.mark}</View>
        <View style={styles.title}>{slot(props.title, 'cardTitle', theme.colors.text, `${prefix}-title`)}</View>
        {props.state === undefined || props.state === null ? null : (
          <View style={styles.word}>
            {slot(props.state, 'cardWord', wordColor ?? theme.colors.secondaryText, `${prefix}-state`, wordColor !== null)}
          </View>
        )}
        <View style={styles.grow} />
        {props.meta === undefined || props.meta === null ? null : (
          <View style={styles.kind}>{slot(props.meta, 'cardMeta', theme.colors.mutedText, `${prefix}-kind`)}</View>
        )}
      </View>
      {hasBody ? <View style={styles.body}>{props.children}</View> : null}
      {hasFooter ? (
        <View
          testID={`${prefix}-footer`}
          style={[
            styles.footer,
            // On a tinted card the hairline is ink at a whisper, so it never fights the ring's hue.
            { borderTopColor: toneStyle ? softenHappierWorkColor(theme.colors.text, 0.07) ?? theme.colors.border : theme.colors.border },
          ]}
        >
          {props.leadingAction ?? null}
          {facts.map((fact) => (
            <View key={fact.id} style={styles.fact}>
              {fact.icon ?? null}
              {slot(fact.label, 'cardFact', theme.colors.secondaryText, `${prefix}-fact:${fact.id}`)}
            </View>
          ))}
          <View style={styles.grow} />
          {props.actions ? <View style={styles.actions}>{props.actions}</View> : null}
        </View>
      ) : null}
    </>
  );

  if (props.renderSurface) return props.renderSurface({ testID: props.testID, toneStyle, children: content });
  const plain: HappierPortableStyle = {
    minWidth: 0,
    borderRadius: theme.radii.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
  };
  return <View testID={props.testID} style={[plain, toneStyle]}>{content}</View>;
});
