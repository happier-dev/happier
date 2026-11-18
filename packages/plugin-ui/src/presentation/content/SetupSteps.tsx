import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierSpinner, iconMatchedSpinnerSize } from '../feedback/Spinner.js';
import type { HappierFontWeight } from '../portableTypes.js';
import type { HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';
import {
  HAPPIER_STEP_PROGRESS_GLYPH_TONE,
  HappierStep,
  HappierStepCancelledMark,
  type HappierStepProgress,
} from './Step.js';

/**
 * Where one step of an ordered setup or progress list stands. Setup flows use `done`, `current` and
 * `upcoming`; progress the system reports adds `running`, `waiting` (it needs the reader), `failed`
 * and `cancelled`.
 */
export type HappierSetupStepState = HappierStepProgress;

/**
 * How the steps paint. `numbered`: a rail of numbered steps for a setup the reader walks through.
 * `compact`: one quiet line per step with ink marks, for a popover or a card's
 * corner beside other content. `strip`: the steps of a flow the reader walks through, on one line joined by
 * hairlines (a sheet's Kind · Set up · Preset), the step being worked on in ink.
 */
export type HappierSetupStepsVariant = 'numbered' | 'compact' | 'strip';

/** The states whose mark is a glyph from the adapter's icon owner. */
export type HappierSetupStepGlyphState =
  keyof typeof HAPPIER_STEP_PROGRESS_GLYPH_TONE;

export type HappierSetupStep = Readonly<{
  key: string;
  state?: HappierSetupStepState;
  title: ReactNode;
  /** What the step asks for or reports, beneath its title. The compact line leaves it out. */
  detail?: string;
  /** A short settled fact at the row's end (how long the step took). */
  meta?: string;
  /** What the step asks the reader to do (numbered setup steps only): content beneath its words. */
  body?: ReactNode;
  /**
   * The one operation the step asks for, as a small button (numbered setup steps only). It sits at
   * the end of the step beside its words and moves beneath them on a narrow row.
   */
  action?: ReactNode;
  testID?: string;
}>;

/** How a step's title is painted; the shared owner decides it so adapters bind only their text host. */
export type HappierSetupStepTitlePresentation = Readonly<{
  plain: boolean;
  variant: HappierSetupStepsVariant;
  color: string;
  weight: 'regular' | 'medium' | 'semiBold';
}>;

export type HappierSetupStepsProps = Readonly<{
  steps: readonly HappierSetupStep[];
  /** A numbered list of instructions: sentences, no step titles. */
  plain?: boolean;
  variant?: HappierSetupStepsVariant;
  testID?: string;
  theme: HappierUiTheme;
  /** Draws a settled state's glyph (done: check, failed: close, waiting: waiting) in the given tone and size. */
  renderStateGlyph?: (
    glyph: Readonly<{
      state: HappierSetupStepGlyphState;
      tone: HappierTone;
      size: number;
    }>,
  ) => ReactNode;
  /** Adapters bind their text host, not another step layout or marker. */
  renderTitle?: (
    step: HappierSetupStep,
    title: HappierSetupStepTitlePresentation,
  ) => ReactNode;
  renderDetail?: (detail: string) => ReactNode;
  renderMeta?: (meta: string) => ReactNode;
}>;

/** Per paint: each settled state's glyph tone, the glyph size, and the ring an unsettled step draws. */
const GLYPH_PAINT = {
  numbered: { tone: HAPPIER_STEP_PROGRESS_GLYPH_TONE, size: 12, ring: 0 },
  // The marks stay ink, so the step being worked on reads by weight; only a failure takes colour.
  compact: {
    tone: { done: 'muted', failed: 'danger', waiting: 'neutral' },
    size: 14,
    ring: 10,
  },
  strip: {
    tone: { done: 'muted', failed: 'danger', waiting: 'neutral' },
    size: 14,
    ring: 10,
  },
} as const satisfies Record<
  HappierSetupStepsVariant,
  Readonly<{
    tone: Readonly<Record<HappierSetupStepGlyphState, HappierTone>>;
    size: number;
    ring: number;
  }>
>;

const FONT_WEIGHT = {
  regular: '400',
  medium: '500',
  semiBold: '600',
} as const satisfies Record<
  HappierSetupStepTitlePresentation['weight'],
  HappierFontWeight
>;

function isGlyphState(
  state: HappierSetupStepState,
): state is HappierSetupStepGlyphState {
  return state in HAPPIER_STEP_PROGRESS_GLYPH_TONE;
}

function resolveTitlePresentation(
  state: HappierSetupStepState,
  plain: boolean,
  variant: HappierSetupStepsVariant,
  theme: HappierUiTheme,
): HappierSetupStepTitlePresentation {
  const { colors } = theme;
  const title = (
    color: string,
    weight: HappierSetupStepTitlePresentation['weight'],
  ) => ({ plain, variant, color, weight });
  const working =
    state === 'running' || state === 'current' || state === 'waiting';
  if (variant === 'numbered') {
    if (plain) return title(colors.text, 'regular');
    if (state === 'done') return title(colors.secondaryText, 'medium');
    if (state === 'cancelled') return title(colors.mutedText, 'medium');
    return title(colors.text, 'semiBold');
  }
  if (working) return title(colors.text, 'medium');
  if (state === 'upcoming' || state === 'cancelled')
    return title(colors.mutedText, 'regular');
  return title(
    state === 'failed' ? theme.statusText?.danger ?? colors.danger : colors.secondaryText,
    'regular',
  );
}

/**
 * The ordered setup and flow composition; numbering and settled/current/working markers belong to
 * HappierStep. Settled glyphs come from the adapter's icon owner in the tone this owner chooses.
 */
export function HappierSetupSteps(props: HappierSetupStepsProps) {
  const theme = props.theme;
  const plain = props.plain === true;
  const variant = props.variant ?? 'numbered';
  const paint = GLYPH_PAINT[variant];
  const bodyStyle = useHappierTypeRoleStyle('meta', theme);
  const captionStyle = useHappierTypeRoleStyle('micro', theme);

  const renderTitle = (
    step: HappierSetupStep,
    state: HappierSetupStepState,
  ) => {
    const title = resolveTitlePresentation(state, plain, variant, theme);
    const adapted = props.renderTitle?.(step, title);
    if (adapted !== undefined) return adapted;
    // A heading stays the default for an author's ordinary setup step; settled and progress titles are quieter text.
    if (variant === 'numbered' && !plain && title.weight === 'semiBold')
      return undefined;
    return (
      <HappierText
        style={[
          bodyStyle,
          { color: title.color, fontWeight: FONT_WEIGHT[title.weight] },
        ]}
      >
        {step.title}
      </HappierText>
    );
  };
  const renderDetail = (detail: string) =>
    props.renderDetail?.(detail) ?? (
      <HappierText
        style={[bodyStyle, { marginTop: 2, color: theme.colors.secondaryText }]}
      >
        {detail}
      </HappierText>
    );
  const renderMeta = (meta: string) =>
    props.renderMeta?.(meta) ?? (
      <HappierText
        tabularNumbers
        style={[captionStyle, { color: theme.colors.mutedText }]}
      >
        {meta}
      </HappierText>
    );
  const renderGlyph = (state: HappierSetupStepGlyphState) =>
    props.renderStateGlyph?.({
      state,
      tone: paint.tone[state],
      size: paint.size,
    });
  const renderMark = (state: HappierSetupStepState) => {
    if (isGlyphState(state)) return renderGlyph(state);
    if (state === 'running')
      return (
        <HappierSpinner
          size={iconMatchedSpinnerSize(paint.size)}
          color={theme.colors.text}
        />
      );
    if (state === 'cancelled')
      return <HappierStepCancelledMark color={theme.colors.mutedText} />;
    return (
      <View
        style={{
          width: paint.ring,
          height: paint.ring,
          borderRadius: paint.ring / 2,
          borderWidth: 1.5,
          borderColor:
            state === 'current' ? theme.colors.text : theme.colors.mutedText,
        }}
      />
    );
  };

  if (variant === 'strip') {
    return (
      <View
        testID={props.testID}
        style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.small }}
        accessibilityRole="list"
      >
        {props.steps.map((step, index) => {
          const state = step.state ?? 'upcoming';
          return (
            <View
              key={step.key}
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.small, flexShrink: 1, minWidth: 0 }}
            >
              {index > 0 ? (
                <View
                  aria-hidden
                  style={{ width: HAPPIER_SPACE_STEPS.s48, flexShrink: 1, minWidth: HAPPIER_SPACE_STEPS.s12, height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }}
                />
              ) : null}
              <View
                testID={step.testID}
                {...(state === 'current' ? { 'aria-current': 'step' } : {})}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}
              >
                <View
                  aria-hidden
                  style={{ width: paint.size, height: paint.size, alignItems: 'center', justifyContent: 'center' }}
                >
                  {renderMark(state)}
                </View>
                {renderTitle(step, state)}
              </View>
            </View>
          );
        })}
      </View>
    );
  }

  if (variant !== 'numbered') {
    return (
      <View
        testID={props.testID}
        style={{ gap: 6 }}
        accessibilityRole="list"
      >
        {props.steps.map((step) => {
          const state = step.state ?? 'upcoming';
          return (
            <View
              key={step.key}
              testID={step.testID}
              {...(state === 'running' ? { 'aria-busy': true } : {})}
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.small }}
            >
              <View
                aria-hidden
                style={{
                  width: Math.max(paint.size, 16),
                  height: Math.max(paint.size, 16),
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {renderMark(state)}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                {renderTitle(step, state)}
              </View>
              {step.meta ? renderMeta(step.meta) : null}
            </View>
          );
        })}
      </View>
    );
  }

  return (
    <View
      testID={props.testID}
      style={{ gap: plain ? 9 : 14 }}
      accessibilityRole="list"
    >
      {props.steps.map((step, index) => {
        const state = step.state ?? 'upcoming';
        return (
          <HappierStep
            key={step.key}
            testID={step.testID}
            marker={{ kind: 'number', value: index + 1 }}
            numberState={state}
            theme={theme}
            title={step.title}
            stateGlyph={isGlyphState(state) ? renderGlyph(state) : undefined}
            trailing={step.meta ? renderMeta(step.meta) : undefined}
            titleContent={renderTitle(step, state)}
            action={step.action}
          >
            {step.detail ? renderDetail(step.detail) : null}
            {step.body ? (
              <View
                style={{
                  marginTop: 10,
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: theme.spacing.small,
                }}
              >
                {step.body}
              </View>
            ) : null}
          </HappierStep>
        );
      })}
    </View>
  );
}
