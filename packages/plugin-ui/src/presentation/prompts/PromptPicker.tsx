import { Fragment, type ComponentType, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type {
  HappierTypeEmphasis,
  HappierTypeRole,
} from '../text/typeScale.js';

/**
 * The prompt picker's rows and preview (Prompts lab `fprompts` R1): one searchable list of saved prompts
 * and things you sent, with the highlighted row's full text beside it. This owns the composition only;
 * the list, its keys, the data, the reading of a prompt and the state lines belong to the embedding
 * surface (the state lines are the shared `SurfaceState` line).
 */

/** One part of a row's meta line: "Library", "/e2e" (a `token`, set in mono), "12m ago" (`fixed`). */
export type HappierPromptPickerMetaPart = Readonly<{
  text: string;
  token?: boolean;
  /** A part that never gives way to a long neighbour on a one-line row (a time). */
  fixed?: boolean;
}>;

/** What the embedding runtime supplies, so the picker keeps its typography and font scaling. */
export type HappierPromptPickerHost = Readonly<{
  Text: ComponentType<
    Readonly<{
      children: ReactNode;
      variant: HappierTypeRole;
      emphasis?: HappierTypeEmphasis;
      color?: string;
      numberOfLines?: number;
      /** The runtime's monospace face (a `/command` token). */
      mono?: boolean;
      /** Tabular figures (times and counts in the preview's header). */
      tabularNumbers?: boolean;
      testID?: string;
    }>
  >;
}>;

export type HappierPromptPickerColors = Readonly<{
  text: string;
  secondaryText: string;
  tertiaryText: string;
  /** The hairline between the list and the preview. */
  divider: string;
}>;

export const HAPPIER_PROMPT_PICKER_METRICS = Object.freeze({
  rowMinHeightPx: 48,
  rowPaddingLeftPx: 14,
  rowPaddingRightPx: 10,
  rowPaddingVerticalPx: 6,
  rowGapPx: 10,
  leadColumnPx: 20,
  glyphPx: 16,
  previewWidthPx: 440,
  previewPaddingHorizontalPx: 14,
  previewPaddingVerticalPx: 12,
  previewGapPx: 8,
});

/** "Library · /e2e · Testing": on one line the flowing parts give way so a fixed one (a time) always shows. */
export function HappierPromptPickerMetaLine(
  props: Readonly<{
    parts: readonly HappierPromptPickerMetaPart[];
    /** A last part after the parts ("Inserts", "You sent"). */
    trailing?: string;
    /** Where the line may wrap (the preview header), every part stays in reading order. */
    lines?: number;
    variant: HappierTypeRole;
    color: string;
    tabularNumbers?: boolean;
    host: HappierPromptPickerHost;
  }>,
) {
  const { Text } = props.host;
  const text = {
    variant: props.variant,
    emphasis: 'regular' as const,
    color: props.color,
    tabularNumbers: props.tabularNumbers,
  };
  const joined = (parts: readonly HappierPromptPickerMetaPart[]) =>
    parts.map((part, index) => (
      <Fragment key={index}>
        {index ? ' · ' : ''}
        {part.token ? (
          <Text {...text} mono>
            {part.text}
          </Text>
        ) : (
          part.text
        )}
      </Fragment>
    ));
  const fixed = props.parts.filter((part) => part.fixed);
  if (!fixed.length || props.lines) {
    return (
      <Text {...text} numberOfLines={props.lines ?? 1}>
        {joined(props.parts)}
        {props.trailing ? ` · ${props.trailing}` : ''}
      </Text>
    );
  }
  const flowing = props.parts.filter((part) => !part.fixed);
  return (
    <View style={styles.metaRow}>
      {flowing.length ? (
        <View style={styles.metaLead}>
          <Text {...text} numberOfLines={1}>
            {joined(flowing)}
          </Text>
        </View>
      ) : null}
      <Text {...text} numberOfLines={1}>
        {/* A line-leading space collapses in a no-wrap line; the separator keeps its own. */}
        {flowing.length ? '\u00a0· ' : ''}
        {fixed.map((part) => part.text).join(' · ')}
      </Text>
    </View>
  );
}

/** One prompt or sent message in the list: its glyph, its title (with the query marked) and where it came from. */
export function HappierPromptPickerRow(
  props: Readonly<{
    /** The kind's glyph (a saved prompt, or something you sent), themed by the runtime. */
    glyph: ReactNode;
    /** The title; the surface marks the query in it (`HappierFindHighlightedText`). */
    title: ReactNode;
    meta: readonly HappierPromptPickerMetaPart[];
    /** The row's one trailing control (the favourite star). */
    accessory?: ReactNode;
    colors: HappierPromptPickerColors;
    host: HappierPromptPickerHost;
    testID?: string;
  }>,
) {
  const { Text } = props.host;
  return (
    <View style={styles.row} testID={props.testID}>
      <View style={styles.lead}>{props.glyph}</View>
      <View style={styles.body}>
        <Text
          variant="label"
          emphasis="regular"
          color={props.colors.text}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        <HappierPromptPickerMetaLine
          parts={props.meta}
          variant="meta"
          color={props.colors.secondaryText}
          host={props.host}
        />
      </View>
      {props.accessory ?? null}
    </View>
  );
}

/** The highlighted row in full: where it came from and what ↵ does, its text, and when it was made. */
export function HappierPromptPickerPreview(
  props: Readonly<{
    meta: readonly HappierPromptPickerMetaPart[];
    /** What choosing it does ("Inserts") or what it was ("You sent"). */
    action: string;
    /** The prompt's text, its loading line or its failure, drawn by the surface. */
    children: ReactNode;
    /** "Edited 3d ago" or the session it was sent in. */
    origin?: string | null;
    colors: HappierPromptPickerColors;
    host: HappierPromptPickerHost;
    testID?: string;
  }>,
) {
  const { Text } = props.host;
  return (
    <View
      style={[styles.preview, { borderLeftColor: props.colors.divider }]}
      testID={props.testID}
    >
      <HappierPromptPickerMetaLine
        parts={props.meta}
        trailing={props.action}
        lines={2}
        variant="micro"
        tabularNumbers
        color={props.colors.tertiaryText}
        host={props.host}
      />
      <ScrollView
        style={styles.previewScroll}
        contentContainerStyle={styles.previewScrollContent}
      >
        {props.children}
      </ScrollView>
      {props.origin ? (
        <Text
          variant="micro"
          emphasis="regular"
          tabularNumbers
          color={props.colors.tertiaryText}
          numberOfLines={1}
        >
          {props.origin}
        </Text>
      ) : null}
    </View>
  );
}

const metrics = HAPPIER_PROMPT_PICKER_METRICS;
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: metrics.rowGapPx,
    paddingLeft: metrics.rowPaddingLeftPx,
    paddingRight: metrics.rowPaddingRightPx,
    paddingVertical: metrics.rowPaddingVerticalPx,
    minHeight: metrics.rowMinHeightPx,
  },
  lead: {
    width: metrics.leadColumnPx,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, minWidth: 0, gap: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'baseline', minWidth: 0 },
  metaLead: { flexShrink: 1, minWidth: 0 },
  preview: {
    width: metrics.previewWidthPx,
    flexShrink: 0,
    minHeight: 0,
    gap: metrics.previewGapPx,
    paddingHorizontal: metrics.previewPaddingHorizontalPx,
    paddingVertical: metrics.previewPaddingVerticalPx,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  previewScroll: { flex: 1, minHeight: 0 },
  previewScrollContent: { paddingBottom: 4 },
});
