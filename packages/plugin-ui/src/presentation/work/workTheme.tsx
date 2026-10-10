import { useMemo, type ComponentType, type ReactNode } from 'react';

import {
  resolveHappierUiPalette,
  useOptionalHappierUiPalette,
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import type { HappierUiPalette, HappierUiTheme } from '../../environment/types.js';
import { HAPPIER_PAGE_TEXT, resolveHappierTextStepStyle, type HappierPageTextStep } from '../layout/pageText.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { softenHappierWorkColor, type HappierWorkStateColors, type HappierWorkStatusColors } from './workStatus.js';

/**
 * What the Work primitives (`HappierWorkSection`, `HappierWorkRowShell`, `HappierWorkSummary`,
 * `HappierWorkMapView`) draw with: one explicit object, so Happier core passes its exact theme and a
 * plugin surface passes the theme it was mounted with.
 *
 * Happier core projects it from its own theme (exact roles: the state tints, the inset ground, the
 * pane hairline). {@link resolveHappierWorkTheme} derives the same roles from the public theme
 * snapshot for a plugin; a component given no theme resolves it from the mounted environment.
 */
export type HappierWorkColors = HappierWorkStatusColors & Readonly<{
  text: string;
  /** Counts, separators, times: the quietest ink. */
  mutedText: string;
  /** A node card's and a status badge's ground. */
  surface: string;
  /** An inset panel (a loop's frame). */
  inset: string;
  /** A node card's edge and every map connector. */
  border: string;
  /** The full-width hairline that opens a configuration section of a Work pane. */
  sectionRule: string;
  /** A row under the pointer, and a node's contact feedback. */
  hover: string;
  /** The open row or node. */
  selected: string;
  /** The keyboard focus ring. */
  focus: string;
}>;

export type HappierWorkTheme = Readonly<{
  /** The semantic snapshot: the section's loading skeleton reads it. */
  base: HappierUiTheme;
  /** Page-anatomy colours: a configuration section lays its rows on a flat page sheet. */
  palette: HappierUiPalette;
  colors: HappierWorkColors;
  spacing: Readonly<{ xsmall: number; small: number }>;
  /** `control`: a heading or lane row; `inset`: a compact frame; `card`: a node card or frame. */
  radii: Readonly<{ control: number; inset: number; card: number }>;
}>;

function snapshotState(color: string, surface: string): HappierWorkStateColors {
  return { foreground: color, border: color, background: softenHappierWorkColor(color, 0.1) ?? surface };
}

/**
 * The Work theme from the public theme snapshot (and the page palette, when the host installed one).
 * The snapshot carries one hue per state, so the state tint is that hue at a tenth.
 */
export function resolveHappierWorkTheme(
  base: HappierUiTheme,
  palette: HappierUiPalette = resolveHappierUiPalette(base),
): HappierWorkTheme {
  const colors = base.colors;
  return {
    base,
    palette,
    colors: {
      text: colors.text,
      secondaryText: colors.secondaryText,
      mutedText: colors.mutedText,
      surface: colors.surface,
      inset: colors.canvas,
      border: colors.divider,
      sectionRule: palette.rowDivider,
      hover: palette.navigationHover,
      selected: palette.navigationSelected,
      focus: colors.focus,
      attention: snapshotState(colors.attention, colors.surface),
      danger: snapshotState(colors.danger, colors.surface),
    },
    spacing: { xsmall: base.spacing.xsmall, small: base.spacing.small },
    radii: { control: base.radii.control, inset: base.radii.control, card: base.radii.panel },
  };
}

/** The explicit theme, or the one the mounted environment supplies. */
export function useHappierWorkTheme(explicit: HappierWorkTheme | undefined): HappierWorkTheme {
  const environmentTheme = useOptionalHappierUiTheme();
  const environmentPalette = useOptionalHappierUiPalette();
  return useMemo(() => {
    if (explicit) return explicit;
    if (!environmentTheme) {
      throw new Error(
        'Happier Work primitives need a theme: pass `theme` (Happier core) or render inside a mounted '
        + 'plugin surface, whose environment supplies one.',
      );
    }
    return resolveHappierWorkTheme(environmentTheme, environmentPalette ?? undefined);
  }, [explicit, environmentTheme, environmentPalette]);
}

/**
 * Geometry of a Work pane's one column, so the live list (Needs you, Working, …) and the
 * configuration sections under it share one left edge.
 */
const contentInsetPx = 8;
const rowRingPx = 1;
const rowPaddingPx = 8;

export const HAPPIER_WORK_PANE_METRICS = Object.freeze({
  /** From the pane's edge to the column its rows sit in. */
  contentInsetPx,
  /** A Work row's transparent ring (its hover and selected fill keep a stable box). */
  rowRingPx,
  /** Inside a Work row's ring, to its mark and text. */
  rowPaddingPx,
  /** From the column's edge to a row's text: every row and sub-heading in the pane starts here. */
  rowInsetPx: rowRingPx + rowPaddingPx,
});

/** The text roles of the Work primitives. */
export type HappierWorkTextRole =
  | 'sectionTitle'
  | 'sectionCount'
  | 'pageSectionTitle'
  | 'pageSectionCount'
  | 'pageSectionDescription'
  | 'rowTitle'
  | 'rowLine'
  | 'rowState'
  | 'rowTime'
  | 'cardTitle'
  | 'cardWord'
  | 'cardMeta'
  | 'cardFact'
  | 'mapLabel'
  | 'mapLabelCompact'
  | 'mapHeading'
  | 'mapHeadingCompact'
  | 'mapDetail'
  | 'mapDetailCompact'
  | 'mapLane';

export type HappierWorkTextStep = HappierPageTextStep & Readonly<{ tabular?: boolean }>;

/** Each role's step at normal text scale; `strong` draws a role in its semi-bold face. */
export const HAPPIER_WORK_TEXT: Readonly<Record<HappierWorkTextRole, HappierWorkTextStep>> = Object.freeze({
  // A live-list group: a compact sentence-case title with a quiet tabular count beside it.
  sectionTitle: { weight: 'semiBold', fontSize: 12.5, lineHeight: 16 },
  sectionCount: { weight: 'regular', fontSize: 12, lineHeight: 16, tabular: true },
  // A configuration section of the pane: the page section title step and its quiet count.
  pageSectionTitle: HAPPIER_PAGE_TEXT.sectionTitle,
  pageSectionCount: { ...HAPPIER_PAGE_TEXT.sectionDescription, tabular: true },
  pageSectionDescription: HAPPIER_PAGE_TEXT.sectionDescription,
  rowTitle: { weight: 'regular', fontSize: 13, lineHeight: 18 },
  rowLine: { weight: 'regular', fontSize: 12, lineHeight: 16 },
  rowState: { weight: 'regular', fontSize: 12, lineHeight: 18 },
  rowTime: { weight: 'regular', fontSize: 11.5, lineHeight: 18, tabular: true },
  // A Work update card (lab `.uws-card`): its head reads as one line — title, state word, kind and age.
  cardTitle: { weight: 'semiBold', fontSize: 13.5, lineHeight: 18 },
  cardWord: { weight: 'regular', fontSize: 12.5, lineHeight: 18 },
  cardMeta: { weight: 'regular', fontSize: 12, lineHeight: 18, tabular: true },
  cardFact: { weight: 'regular', fontSize: 12, lineHeight: 16, tabular: true },
  mapLabel: { weight: 'semiBold', fontSize: 13.5, lineHeight: 18 },
  // A small map's step names read as words, not headings (lab `.wm.sm .wm-c .t`, DESIGN-9 P5).
  mapLabelCompact: { weight: 'medium', fontSize: 12, lineHeight: 16 },
  mapHeading: { weight: 'semiBold', fontSize: 13, lineHeight: 18 },
  mapHeadingCompact: { weight: 'semiBold', fontSize: 12, lineHeight: 16 },
  // A node's quiet fact after its name ("· 2 lanes"), on the name's line (lab `.wm-forkhd .tx`).
  mapDetail: { weight: 'regular', fontSize: 13, lineHeight: 18 },
  mapDetailCompact: { weight: 'regular', fontSize: 12, lineHeight: 16 },
  mapLane: { weight: 'regular', fontSize: 12, lineHeight: 16 },
});

export type HappierWorkTextProps = Readonly<{
  role: HappierWorkTextRole;
  /** The role in its semi-bold face (a word in a state tone, an open lane, a row that needs you). */
  strong?: boolean;
  /** Colour and layout; the role owns size, line height and face. */
  style?: HappierStyleProp;
  numberOfLines?: number;
  accessibilityRole?: 'header';
  testID?: string;
  children?: ReactNode;
}>;

/**
 * The host primitives the Work primitives draw text and live activity with. Happier core passes its
 * own text owner (its font family and the user's font scale) and activity spinner; omitted, a mounted
 * plugin surface draws through `HappierText` and its environment.
 */
export type HappierWorkHost = Readonly<{
  Text: ComponentType<HappierWorkTextProps>;
}>;

/** The step a role draws with, in its strong face when asked. */
export function resolveHappierWorkTextStep(role: HappierWorkTextRole, strong?: boolean): HappierWorkTextStep {
  const step = HAPPIER_WORK_TEXT[role];
  return strong === true && step.weight !== 'semiBold' && step.weight !== 'bold' ? { ...step, weight: 'semiBold' } : step;
}

function EnvironmentWorkText(props: HappierWorkTextProps) {
  const typography = useOptionalHappierUiTypography();
  const step = resolveHappierWorkTextStep(props.role, props.strong);
  return (
    <HappierText
      tabularNumbers={step.tabular === true}
      // In `style` (not `baseStyle`) so the environment's text scale applies to the role's metrics.
      style={[resolveHappierTextStepStyle(step, typography), props.style]}
      {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
      {...(props.accessibilityRole === undefined ? {} : { accessibilityRole: props.accessibilityRole })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </HappierText>
  );
}

const ENVIRONMENT_WORK_HOST: HappierWorkHost = Object.freeze({ Text: EnvironmentWorkText });

/** The explicit host, or the environment-driven one a plugin surface uses. */
export function resolveHappierWorkHost(host: HappierWorkHost | undefined): HappierWorkHost {
  return host ?? ENVIRONMENT_WORK_HOST;
}
