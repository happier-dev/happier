import { useThemeSurfaceBinding } from '../themeSurfaceBinding.js';
import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';

import {
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import { HappierText } from '../text/Text.js';
import {
  resolveHappierTypeScale,
  HAPPIER_TYPE_WEIGHT,
} from '../text/typeScale.js';

/**
 * The spacing steps the title band is drawn with. A same-realm host passes its own density-scaled
 * steps (Happier core's `theme.space`); absent, the standard steps apply.
 */
export type HappierModalHeaderSpace = Readonly<{
  s2: number;
  s8: number;
  s10: number;
  s12: number;
  s16: number;
}>;

/** The standard steps and the band's fixed geometry. */
export const HAPPIER_MODAL_HEADER_METRICS = Object.freeze({
  /** The band's least height: one title line beside a close control. */
  minHeightPx: 52,
  /** The top inset when a subtitle (or the stacked phone layout) hangs the text from the top edge. */
  textTopInsetPx: 14,
  space: Object.freeze({
    s2: 2,
    s8: 8,
    s10: 10,
    s12: 12,
    s16: 16,
  }) satisfies HappierModalHeaderSpace,
});

export type HappierModalHeaderLayout = 'row' | 'stacked';

/**
 * The phone rule. A phone card is too narrow to share one row between the title and wide actions (a
 * machine chip squeezed the title into a two-word column), so on a compact card with both a title and
 * actions the title keeps the row with the close control and the subtitle and the actions take the
 * full width beneath it. Everything else stays on one row.
 */
export function resolveHappierModalHeaderLayout(
  input: Readonly<{
    compact: boolean;
    hasTitle: boolean;
    hasActions: boolean;
  }>,
): HappierModalHeaderLayout {
  return input.compact && input.hasTitle && input.hasActions
    ? 'stacked'
    : 'row';
}

export type HappierModalHeaderTextRender = (input: Readonly<{
  role: 'title' | 'subtitle';
  /** A string, or a caller's inline nodes the role's text style applies to. */
  children: ReactNode;
  testID?: string;
}>) => ReactNode;

export type HappierModalHeaderProps = Readonly<{
  /** A leading identity mark before the title. */
  leading?: ReactNode;
  /**
   * `above`: the leading slot is a way back, not a mark. On a compact card it takes its own row with the close
   * control and the title and subtitle stand beneath it on the page gutter; a wide card keeps one row.
   */
  leadingPlacement?: 'above' | null;
  /** Drawn in the heading step through `renderText`. */
  title?: ReactNode;
  /** One line under the title saying what the dialog is for or what it acts on. */
  subtitle?: ReactNode;
  /** Context controls beside the title (a machine chip); they move beneath it on a compact card. */
  actions?: ReactNode;
  /** The close control, already drawn by the adapter. Absent, the band has none. */
  close?: ReactNode;
  /**
   * The card is a phone's (narrow) card. The caller decides it from its own device owner; the header
   * owns what changes ({@link resolveHappierModalHeaderLayout}).
   */
  compact?: boolean;
  space?: HappierModalHeaderSpace;
  /** How the title and subtitle are drawn; absent, the environment theme and typography draw them. */
  renderText?: HappierModalHeaderTextRender;
  testID?: string;
  titleTestID?: string;
  subtitleTestID?: string;
  style?: HappierStyleProp;
}>;

function useDefaultModalHeaderText(): HappierModalHeaderTextRender {
  const theme = useOptionalHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  return (input) => {
    const role = input.role === 'title' ? 'heading' : 'body';
    return (
      <HappierText
        testID={input.testID}
        accessibilityRole={input.role === 'title' ? 'header' : undefined}
        style={[
          theme === null ? resolveUnhostedRoleStyle(role) : resolveHappierTypeRoleStyle(role, theme, typography),
          theme === null ? null : { color: input.role === 'title' ? theme.colors.text : theme.colors.secondaryText },
        ]}
      >
        {input.children}
      </HappierText>
    );
  };
}

/** The heading's line height, so a mark beside a two-line title block centres on the title's own line. */
function useModalHeaderTitleLineHeight(): number | undefined {
  const theme = useOptionalHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const style = theme === null ? resolveUnhostedRoleStyle('heading') : resolveHappierTypeRoleStyle('heading', theme, typography);
  return typeof style.lineHeight === 'number' ? style.lineHeight : undefined;
}

function resolveUnhostedRoleStyle(role: 'heading' | 'body'): HappierPortableStyle {
  const step = resolveHappierTypeScale(role, Platform.OS);
  return { fontSize: step.fontSize, lineHeight: step.lineHeight, letterSpacing: step.letterSpacing, fontWeight: HAPPIER_TYPE_WEIGHT[step.weight] };
}

function renderSlot(
  slot: ReactNode,
  role: 'title' | 'subtitle',
  renderText: HappierModalHeaderTextRender,
  testID: string | undefined,
): ReactNode {
  if (slot === null || slot === undefined || slot === false) return null;
  return renderText({ role, children: slot, testID });
}

/**
 * The task-modal title band shared by Happier's own dialogs and plugin dialogs: a compact row — leading
 * mark, title and subtitle, optional actions, close — with no divider, so the content starts right
 * under it. On a compact (phone) card with actions it recomposes rather than squeezing the title.
 */
export function HappierModalHeader(props: HappierModalHeaderProps) {
  const surfaceBinding = useThemeSurfaceBinding({ surface: 'dialog', part: 'header' });
  const defaultRenderText = useDefaultModalHeaderText();
  const titleLineHeight = useModalHeaderTitleLineHeight();
  const renderText = props.renderText ?? defaultRenderText;
  const space = props.space ?? HAPPIER_MODAL_HEADER_METRICS.space;
  const title = renderSlot(props.title, 'title', renderText, props.titleTestID);
  const subtitle = renderSlot(
    props.subtitle,
    'subtitle',
    renderText,
    props.subtitleTestID,
  );
  const hasTitle = title !== null || subtitle !== null;
  const hasActions =
    props.actions !== null &&
    props.actions !== undefined &&
    props.actions !== false;
  const close = props.close ?? null;

  if (!hasTitle && !props.leading && !hasActions && close === null) return null;

  const testID = props.testID ?? 'modal-card-header';
  if (props.compact === true && props.leadingPlacement === 'above' && props.leading && hasTitle) {
    return (
      <View
        testID={testID}
        {...{ dataSet: surfaceBinding.dataSet }}
        style={[
          {
            paddingHorizontal: space.s16,
            paddingTop: space.s2,
            paddingBottom: space.s10,
            gap: space.s2,
          },
          props.style,
          surfaceBinding.style,
        ]}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.s12,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>{props.leading}</View>
          {hasActions || close !== null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
              {props.actions}
              {close}
            </View>
          ) : null}
        </View>
        <View style={{ gap: space.s2 }}>
          {title}
          {subtitle}
        </View>
      </View>
    );
  }
  const leadingWrap = {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: props.subtitle != null && props.subtitle !== false && props.leadingPlacement !== 'above' ? space.s8 : space.s10,
  } as const;
  const titleWrap = { flex: 1, minWidth: 0, gap: space.s2 } as const;
  // An identity mark sits on the title line; the title and subtitle are one tight pair on the title's text
  // edge beside it (standing decision 5), and the mark and controls centre on the title's own line.
  const markedSubtitle = Boolean(props.leading) && subtitle !== null && props.leadingPlacement !== 'above';
  const titleLine = { minHeight: titleLineHeight, justifyContent: 'center' } as const;

  if (
    resolveHappierModalHeaderLayout({
      compact: props.compact === true,
      hasTitle,
      hasActions,
    }) === 'stacked'
  ) {
    return (
      <View
        testID={testID}
        {...{ dataSet: surfaceBinding.dataSet }}
        style={[
          {
            paddingHorizontal: space.s16,
            paddingTop: HAPPIER_MODAL_HEADER_METRICS.textTopInsetPx,
            paddingBottom: space.s10,
            gap: space.s8,
          },
          props.style,
          surfaceBinding.style,
        ]}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: space.s12,
          }}
        >
          <View style={markedSubtitle ? [leadingWrap, { alignItems: 'flex-start' }] : leadingWrap}>
            {markedSubtitle ? <View style={titleLine}>{props.leading}</View> : props.leading}
            <View style={titleWrap}>
              {title}
              {markedSubtitle ? subtitle : null}
            </View>
          </View>
          {markedSubtitle && close !== null ? <View style={titleLine}>{close}</View> : close}
        </View>
        {markedSubtitle ? null : subtitle}
        <View
          testID={`${testID}-actions-row`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.s10,
            minWidth: 0,
          }}
        >
          {/* One line: a long chip gives way (truncates) rather than pushing a lone icon action onto a row of its own. */}
          {props.actions}
        </View>
      </View>
    );
  }

  if (markedSubtitle) {
    return (
      <View
        testID={testID}
        {...{ dataSet: surfaceBinding.dataSet }}
        style={[
          {
            paddingHorizontal: space.s16,
            paddingTop: HAPPIER_MODAL_HEADER_METRICS.textTopInsetPx,
            paddingBottom: space.s10,
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: space.s12,
          },
          props.style,
          surfaceBinding.style,
        ]}
      >
        <View style={[leadingWrap, { alignItems: 'flex-start' }]}>
          <View style={titleLine}>{props.leading}</View>
          <View style={titleWrap}>
            {title}
            {subtitle}
          </View>
        </View>
        {hasActions || close !== null ? (
          <View style={[titleLine, { flexDirection: 'row', alignItems: 'center', gap: space.s10 }]}>
            {props.actions}
            {close}
          </View>
        ) : null}
      </View>
    );
  }

  // A sentence under the title beside wide actions (a machine chip) was squeezed into a narrow column, so
  // with actions the title line keeps the row and the subtitle spans the card beneath it.
  if (subtitle !== null && hasActions && !props.leading) {
    return (
      <View
        testID={testID}
        {...{ dataSet: surfaceBinding.dataSet }}
        style={[
          {
            paddingHorizontal: space.s16,
            paddingTop: HAPPIER_MODAL_HEADER_METRICS.textTopInsetPx,
            paddingBottom: space.s10,
            gap: space.s2,
          },
          props.style,
          surfaceBinding.style,
        ]}
      >
        {/* The title keeps its one line; a long chip beside it gives way (truncates) instead of wrapping the title. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s12 }}>
          <View style={[{ flexGrow: 1, flexShrink: 0, maxWidth: '100%', gap: space.s2 }, titleLine]}>{title}</View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10, flexShrink: 1, minWidth: 0 }}>
            {props.actions}
            {close}
          </View>
        </View>
        {subtitle}
      </View>
    );
  }

  return (
    <View
      testID={testID}
        {...{ dataSet: surfaceBinding.dataSet }}
      style={[
        {
          minHeight: HAPPIER_MODAL_HEADER_METRICS.minHeightPx,
          paddingHorizontal: space.s16,
          paddingVertical: space.s10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.s12,
        },
        subtitle !== null
          ? {
              alignItems: 'flex-start',
              paddingTop: HAPPIER_MODAL_HEADER_METRICS.textTopInsetPx,
            }
          : null,
        props.style,
        surfaceBinding.style,
      ]}
    >
      <View style={leadingWrap}>
        {props.leading}
        <View style={titleWrap}>
          {title}
          {subtitle}
        </View>
      </View>
      {hasActions || close !== null ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}
        >
          {props.actions}
          {close}
        </View>
      ) : null}
    </View>
  );
}
