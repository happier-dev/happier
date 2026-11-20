import {
  memo,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { StyleSheet, View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';

export type HappierFactStripFact = Readonly<{
  key: string;
  /** What the fact is ("Health", "Checks"), read first and quietly. */
  label: string;
  /** Its current value, one short phrase ("Passing", "2 failing"). */
  value: string;
  /** Only a value that needs someone speaks in colour: amber needs you, rose failed. */
  tone?: 'attention' | 'danger';
  /** A mark that leads the value on its line (the people a value names); it stands on its own, never on a tile. */
  lead?: ReactNode;
  /** One quiet line under the value that qualifies it ("migrate ran once", "deployed 2 hours ago"). */
  detail?: ReactNode;
  /** In columns, a fact whose value is a sentence (a commit's subject) takes two shares, or a whole phone row. */
  wide?: boolean;
  testID?: string;
}>;

/** How a host draws each line of a fact: its own text owner (font scale, faces) and its inks. */
export type HappierFactStripTextProps = Readonly<{
  /** `label` quiet over the value; `value` (or `headline` at title size); `detail` the quiet line beneath. */
  role: 'label' | 'value' | 'headline' | 'detail';
  tone?: 'attention' | 'danger';
  numberOfLines?: number;
  children: ReactNode;
}>;

export type HappierFactStripProps = Readonly<{
  facts: readonly HappierFactStripFact[];
  Text: ComponentType<HappierFactStripTextProps>;
  /** The hairline that rules divided cells apart, and a headline strip from the page. */
  ruleColor: string;
  /**
   * `wrap` (default) sets facts side by side at their own widths. `columns` shares the width, so a receipt's or a
   * page's headline facts line up as cells; `narrow` (a phone) puts two to a row. `divided` rules the cells apart.
   */
  layout?: 'wrap' | 'columns';
  narrow?: boolean;
  divided?: boolean;
  /**
   * `headline`: a monitor page's few figures (a Check's response and uptime, lab `mfacts`) read at title size, and
   * one hairline above and below the strip rules it from the page instead of rules between its cells.
   */
  scale?: 'headline';
  /**
   * Every fact keeps its quiet line's room, empty while its detail is unknown, so a strip whose values arrive after
   * first paint (a pull request's checks) fills in place and moves nothing below it. Side by side only: two to a row
   * (`narrow`), a fact without a quiet line draws none, so a phone card never ends on an empty band.
   */
  reserveDetail?: boolean;
  testID?: string;
}>;

const S = HAPPIER_SPACE_STEPS;
const NO_BREAK_SPACE = '\u00a0';
const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: S.s32,
    rowGap: S.s12,
  },
  fact: { minWidth: 0, maxWidth: '100%', gap: S.s2 },
  valueLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.s6,
    minWidth: 0,
  },
  // Columns: cells share the row; a phone keeps two to a row and a wide fact takes its own.
  columns: { flexWrap: 'wrap', columnGap: S.s16, rowGap: S.s12 },
  columnsDivided: { columnGap: 0, rowGap: 0 },
  headline: {
    columnGap: S.s24,
    paddingVertical: S.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cell: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  cellWide: { flexGrow: 2, flexShrink: 1, flexBasis: 0 },
  narrowCell: { flexGrow: 1, flexShrink: 1, flexBasis: '40%' },
  narrowWide: { flexBasis: '100%' },
  // Divided cells carry their own inset and a hairline on their leading edge, except a row's first.
  cellDivided: {
    paddingHorizontal: S.s16,
    paddingVertical: S.s12,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  cellLeading: { borderLeftWidth: 0 },
  cellNextRow: { borderTopWidth: StyleSheet.hairlineWidth },
});

/**
 * A thing's few headline facts side by side, a quiet label over each value (lab `fc-facts`, the ruled glance cells
 * of a pull request's header): an Environment's health and rollout, a pull request's status, checks and reviewers.
 * Facts never wrap inside a word; when a column is too narrow for one line they wrap to the next line whole.
 * Happier core and plugin surfaces draw the strip with this one owner; each host supplies its text owner and rule ink.
 */
export const HappierFactStrip = memo(function HappierFactStrip(
  props: HappierFactStripProps,
): ReactElement | null {
  if (props.facts.length === 0) return null;
  const { Text } = props;
  const columns = props.layout === 'columns';
  const headline = props.scale === 'headline';
  const rule = { borderColor: props.ruleColor };
  return (
    <View
      style={[
        styles.strip,
        columns ? styles.columns : null,
        columns && props.divided ? styles.columnsDivided : null,
        headline ? [styles.headline, rule] : null,
      ]}
      testID={props.testID}
    >
      {props.facts.map((fact, index) => (
        <View
          key={fact.key}
          testID={fact.testID}
          style={[
            styles.fact,
            columns
              ? [
                  props.narrow
                    ? fact.wide
                      ? styles.narrowWide
                      : styles.narrowCell
                    : fact.wide
                      ? styles.cellWide
                      : styles.cell,
                  props.divided ? [styles.cellDivided, rule] : null,
                  props.divided &&
                  (props.narrow ? index % 2 === 0 || fact.wide : index === 0)
                    ? styles.cellLeading
                    : null,
                  // Two to a row on a phone: each later row is ruled from the one above.
                  props.divided && props.narrow && index >= 2
                    ? [styles.cellNextRow, rule]
                    : null,
                ]
              : null,
          ]}
        >
          <Text role="label" numberOfLines={1}>
            {fact.label}
          </Text>
          {fact.lead === undefined || fact.lead === null ? (
            <Text
              role={headline ? 'headline' : 'value'}
              {...(fact.tone === undefined ? {} : { tone: fact.tone })}
            >
              {fact.value}
            </Text>
          ) : (
            <View style={styles.valueLine}>
              {fact.lead}
              <Text
                role={headline ? 'headline' : 'value'}
                {...(fact.tone === undefined ? {} : { tone: fact.tone })}
              >
                {fact.value}
              </Text>
            </View>
          )}
          {fact.detail === undefined || fact.detail === null ? (
            props.reserveDetail === true && props.narrow !== true ? <Text role="detail" numberOfLines={1}>{NO_BREAK_SPACE}</Text> : null
          ) : (
            <Text
              role="detail"
              {...(columns && !props.narrow ? { numberOfLines: 1 } : {})}
            >
              {fact.detail}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
});
