import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import {
  useOptionalHappierUiPalette,
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import type { HappierUiTypography } from '../../environment/types.js';
import { happierPageTextMetrics } from '../layout/pageText.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';

/** One labelled leaf of a structured value; a group heading has no value and indents what follows it by `depth`. */
export type HappierApprovalFieldEntry<TSource = never> = Readonly<{
  label: string;
  value: string | null;
  depth: number;
  /** What the host reads to name the value (an id it knows by name); see `Resolve`. */
  source?: TSource;
}>;

/**
 * One argument of a request, already readable: a value, a structured value's entries, questions and the answers
 * given, or a notice that the value cannot be shown here.
 */
export type HappierApprovalFieldRow<TSource = never> =
  | Readonly<{
      kind: 'value';
      key: string;
      label: string;
      value: string;
      source?: TSource;
    }>
  | Readonly<{
      kind: 'entries';
      key: string;
      label: string;
      entries: readonly HappierApprovalFieldEntry<TSource>[];
    }>
  | Readonly<{
      kind: 'answers';
      key: string;
      label: string;
      answers: readonly Readonly<{
        question: string;
        values: readonly string[];
      }>[];
    }>
  | Readonly<{
      kind: 'notice';
      key: string;
      label: string;
      title: string;
      body: string;
      testID?: string;
    }>;

export type HappierApprovalFieldsTextRole =
  | 'tableLabel'
  | 'label'
  | 'value'
  | 'entryGroup'
  | 'entryLabel'
  | 'entryValue'
  | 'question'
  | 'noticeTitle'
  | 'noticeBody';

export type HappierApprovalFieldsTextRender = (
  input: Readonly<{
    role: HappierApprovalFieldsTextRole;
    text: string;
    style: HappierPortableStyle;
  }>,
) => ReactNode;

/**
 * A same-realm host that knows some values by name (a Session, a Home) reads each sourced value through this
 * slot and hands back the words to show; without it a value reads as given.
 */
export type HappierApprovalFieldResolve<TSource> = ComponentType<
  Readonly<{
    source: TSource;
    label: string;
    value: string;
    children: (
      resolved: Readonly<{ label: string; value: string }>,
    ) => ReactNode;
  }>
>;

export type HappierApprovalFieldsColors = Readonly<{
  /** Values and questions. */
  text: string;
  /** Labels and group headings. */
  secondaryText: string;
  /** A structured value's keys on a page, a step quieter than their values. */
  mutedText: string;
  /** The notice that a value cannot be shown. */
  danger: string;
  /** The table's quiet inset fill, a step in from the card it sits in. */
  inset: string;
}>;

export type HappierApprovalFieldsSpace = Readonly<{
  s2: number;
  s4: number;
  s6: number;
  s8: number;
  s10: number;
  s12: number;
}>;

export const HAPPIER_APPROVAL_FIELDS_METRICS = Object.freeze({
  /** The table's key column: wide enough for the common argument names, so the values share one edge. */
  tableLabelWidthPx: 96,
  /** A page facts list's key column: its labels are short single words (Where, Path, As). */
  pageLabelWidthPx: 56,
  /** How far a structured value's nested entries step in per level. */
  entryIndentPx: 12,
  space: Object.freeze({
    s2: 2,
    s4: 4,
    s6: 6,
    s8: 8,
    s10: 10,
    s12: 12,
  }) satisfies HappierApprovalFieldsSpace,
  radiusPx: 8,
});

/** What every part of the fields shares: the host's inks, steps, faces and text owner. */
export type HappierApprovalFieldsLook<TSource = never> = Readonly<{
  Resolve?: HappierApprovalFieldResolve<TSource>;
  colors?: HappierApprovalFieldsColors;
  space?: HappierApprovalFieldsSpace;
  /** The host's type faces; omitted, the mounted environment's (a numeric weight without either). */
  typography?: HappierUiTypography | null;
  renderText?: HappierApprovalFieldsTextRender;
}>;

export type HappierApprovalFieldEntriesProps<TSource = never> =
  HappierApprovalFieldsLook<TSource> &
    Readonly<{
      entries: readonly HappierApprovalFieldEntry<TSource>[];
      /**
       * `card` (default): the card's own value type. `page`: a page row's description size, the keys a step quieter
       * than their values.
       */
      density?: 'card' | 'page';
    }>;

export type HappierApprovalFieldsProps<TSource = never> =
  HappierApprovalFieldsLook<TSource> &
    Readonly<{
      rows: readonly HappierApprovalFieldRow<TSource>[];
      /**
       * `table` (default): an open card's arguments as one inset table, label beside value — the card already says
       * what is asked, so the table carries no heading or border of its own. `stack`: each label over its value,
       * for a body that already sits behind a "Details" line.
       */
      anatomy?: 'table' | 'stack';
      /**
       * `card` (default): the open card's inset table. `page`: the page's facts beneath the thing asked, each value
       * row read as an Item like the page's Status row: its name as the title, its value as the detail on the right.
       */
      density?: 'card' | 'page';
      /** The last line of the fields (a Technical details disclosure). */
      footer?: ReactNode;
      radius?: number;
      testID?: string;
    }>;

const renderDefaultText: HappierApprovalFieldsTextRender = (input) => (
  <HappierText style={input.style}>{input.text}</HappierText>
);

type ApprovalFieldsStyleKey =
  | HappierApprovalFieldsTextRole
  | 'pageEntryGroup'
  | 'pageEntryLabel'
  | 'pageEntryValue'
  | 'pageItemTitle'
  | 'pageItemDetail';

function useApprovalFieldsLook<TSource>(
  props: HappierApprovalFieldsLook<TSource>,
) {
  const theme = useOptionalHappierUiTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const environmentTypography = useOptionalHappierUiTypography();
  const typography =
    props.typography === undefined ? environmentTypography : props.typography;
  const colors: HappierApprovalFieldsColors | null =
    props.colors ??
    (theme
      ? {
          text: theme.colors.text,
          secondaryText: theme.colors.secondaryText,
          mutedText: theme.colors.mutedText,
          danger: theme.colors.danger,
          inset: palette?.inset ?? theme.colors.control,
        }
      : null);
  const role = (
    name: Parameters<typeof resolveHappierTypeRoleStyle>[0],
    emphasis?: Parameters<typeof resolveHappierTypeRoleStyle>[3],
  ) => resolveHappierTypeRoleStyle(name, theme, typography, emphasis);
  const ink = (color: keyof HappierApprovalFieldsColors) =>
    colors ? { color: colors[color] } : {};
  const value = { ...role('label', 'regular'), ...ink('text') };
  const description = happierPageTextMetrics('rowDescription');
  const styles: Readonly<Record<ApprovalFieldsStyleKey, HappierPortableStyle>> =
    {
      // The key reads in the value's own size and line, regular and quieter, so a table row is one line.
      tableLabel: { ...value, ...ink('secondaryText') },
      label: { ...role('meta', 'semiBold'), ...ink('secondaryText') },
      value,
      entryGroup: { ...role('body', 'semiBold'), ...ink('secondaryText') },
      entryLabel: {
        ...role('body'),
        lineHeight: value.lineHeight,
        ...ink('secondaryText'),
      },
      entryValue: value,
      question: { ...role('label', 'semiBold'), ...ink('text') },
      noticeTitle: { ...role('label', 'semiBold'), ...ink('danger') },
      noticeBody: { ...value, ...ink('secondaryText') },
      pageEntryGroup: {
        ...description,
        fontWeight: '500',
        ...ink('secondaryText'),
      },
      pageEntryLabel: { ...description, ...ink('mutedText') },
      pageEntryValue: { ...description, ...ink('secondaryText') },
      // A page's value row reads as an Item: its name as the row title, its value as the detail on the right.
      pageItemTitle: { ...value, ...ink('text') },
      pageItemDetail: { ...value, ...ink('secondaryText'), textAlign: 'right' },
    };
  const renderText = props.renderText ?? renderDefaultText;
  return {
    colors,
    styles,
    space: props.space ?? HAPPIER_APPROVAL_FIELDS_METRICS.space,
    text: (
      textRole: HappierApprovalFieldsTextRole,
      text: string,
      style: HappierPortableStyle = styles[textRole],
    ) => renderText({ role: textRole, text, style }),
  };
}

/** Reads a sourced value through the host's `Resolve`, or as given. */
function ResolvedText<TSource>(
  props: Readonly<{
    Resolve?: HappierApprovalFieldResolve<TSource>;
    source?: TSource;
    label: string;
    value: string;
    children: (
      resolved: Readonly<{ label: string; value: string }>,
    ) => ReactNode;
  }>,
) {
  const { Resolve } = props;
  if (!Resolve || props.source === undefined)
    return <>{props.children({ label: props.label, value: props.value })}</>;
  return (
    <Resolve source={props.source} label={props.label} value={props.value}>
      {props.children}
    </Resolve>
  );
}

/** A structured value as one labelled line per leaf, groups indented beneath their key. */
export function HappierApprovalFieldEntries<TSource = never>(
  props: HappierApprovalFieldEntriesProps<TSource>,
) {
  const { styles, space, text } = useApprovalFieldsLook(props);
  const page = props.density === 'page';
  if (props.entries.length === 0) return null;
  return (
    <View style={{ gap: space.s4 }}>
      {props.entries.map((entry, index) => (
        <View
          key={`${index}:${entry.label}`}
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            gap: space.s8,
            paddingLeft:
              entry.depth * HAPPIER_APPROVAL_FIELDS_METRICS.entryIndentPx,
          }}
        >
          {entry.value === null ? (
            text(
              'entryGroup',
              entry.label,
              page ? styles.pageEntryGroup : styles.entryGroup,
            )
          ) : (
            <ResolvedText
              Resolve={props.Resolve}
              source={entry.source}
              label={entry.label}
              value={entry.value}
            >
              {(resolved) => (
                <>
                  {text(
                    'entryLabel',
                    resolved.label,
                    page ? styles.pageEntryLabel : styles.entryLabel,
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    {text(
                      'entryValue',
                      resolved.value,
                      page ? styles.pageEntryValue : styles.entryValue,
                    )}
                  </View>
                </>
              )}
            </ResolvedText>
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * The arguments an approval would run with, in one anatomy for every surface that asks: Happier's own approval
 * cards and the approvals a plugin's Actions request. The caller supplies readable rows; deciding, waiting and
 * settling stay with the request's owner.
 */
export function HappierApprovalFields<TSource = never>(
  props: HappierApprovalFieldsProps<TSource>,
) {
  const { colors, space, styles, text } = useApprovalFieldsLook(props);
  const page = props.density === 'page';
  const keyText = (label: string) =>
    page ? text('tableLabel', label, styles.pageEntryLabel) : text('tableLabel', label);
  const valueText = (value: string) =>
    page ? text('value', value, styles.pageEntryValue) : text('value', value);
  const look: HappierApprovalFieldsLook<TSource> = {
    Resolve: props.Resolve,
    colors: props.colors,
    space: props.space,
    typography: props.typography,
    renderText: props.renderText,
  };

  const content = (row: HappierApprovalFieldRow<TSource>) => {
    if (row.kind === 'entries')
      return (
        <HappierApprovalFieldEntries<TSource>
          {...look}
          entries={row.entries}
          density={page ? 'page' : 'card'}
        />
      );
    if (row.kind === 'answers') {
      return (
        <View style={{ gap: space.s10 }}>
          {row.answers.map((answer, index) => (
            <View key={`${answer.question}:${index}`} style={{ gap: space.s2 }}>
              {text('question', answer.question)}
              {answer.values.map((value, valueIndex) => (
                <View key={`${value}:${valueIndex}`}>
                  {text('value', value)}
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    }
    if (row.kind === 'notice') {
      return (
        <View testID={row.testID} style={{ gap: space.s2 }}>
          {text('noticeTitle', row.title)}
          {text('noticeBody', row.body)}
        </View>
      );
    }
    return text('value', row.value);
  };

  const rowTestID = (row: HappierApprovalFieldRow<TSource>) =>
    props.testID ? `${props.testID}.row:${row.key}` : undefined;

  if (props.anatomy === 'stack') {
    return (
      <View testID={props.testID} style={{ gap: space.s12 }}>
        <View style={{ gap: space.s10 }}>
          {props.rows.map((row) => (
            <View
              key={row.key}
              testID={rowTestID(row)}
              style={{ gap: space.s4 }}
            >
              {row.kind === 'value' ? (
                <ResolvedText
                  Resolve={props.Resolve}
                  source={row.source}
                  label={row.label}
                  value={row.value}
                >
                  {(resolved) => (
                    <>
                      {text('label', resolved.label)}
                      {text('value', resolved.value)}
                    </>
                  )}
                </ResolvedText>
              ) : (
                <>
                  {text('label', row.label)}
                  {content(row)}
                </>
              )}
            </View>
          ))}
        </View>
        {props.footer}
      </View>
    );
  }

  const labelColumn: HappierPortableStyle = {
    width: page
      ? HAPPIER_APPROVAL_FIELDS_METRICS.pageLabelWidthPx
      : HAPPIER_APPROVAL_FIELDS_METRICS.tableLabelWidthPx,
    flexShrink: 0,
  };
  return (
    <View
      testID={props.testID}
      style={
        page
          ? { gap: space.s4 }
          : {
              borderRadius:
                props.radius ?? HAPPIER_APPROVAL_FIELDS_METRICS.radiusPx,
              ...(colors ? { backgroundColor: colors.inset } : null),
              paddingHorizontal: space.s12,
              paddingVertical: space.s8,
              gap: space.s6,
            }
      }
    >
      {props.rows.map((row) =>
        row.kind === 'value' || row.kind === 'entries' ? (
          <View
            key={row.key}
            testID={rowTestID(row)}
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              gap: space.s12,
            }}
          >
            {row.kind === 'value' ? (
              <ResolvedText
                Resolve={props.Resolve}
                source={row.source}
                label={row.label}
                value={row.value}
              >
                {(resolved) => page ? (
                  <>
                    <View style={{ flexShrink: 1, minWidth: 0 }}>
                      {text('tableLabel', resolved.label, styles.pageItemTitle)}
                    </View>
                    <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-end' }}>
                      {text('value', resolved.value, styles.pageItemDetail)}
                    </View>
                  </>
                ) : (
                  <>
                    <View style={labelColumn}>{keyText(resolved.label)}</View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      {valueText(resolved.value)}
                    </View>
                  </>
                )}
              </ResolvedText>
            ) : (
              <>
                <View style={labelColumn}>{keyText(row.label)}</View>
                <View style={{ flex: 1, minWidth: 0 }}>{content(row)}</View>
              </>
            )}
          </View>
        ) : (
          // Questions and answers, or the notice that a value cannot be shown, are content rather than one
          // value: they sit beneath the argument's name.
          <View key={row.key} testID={rowTestID(row)} style={{ gap: space.s4 }}>
            {text('label', row.label)}
            {content(row)}
          </View>
        ),
      )}
      {props.footer}
    </View>
  );
}
