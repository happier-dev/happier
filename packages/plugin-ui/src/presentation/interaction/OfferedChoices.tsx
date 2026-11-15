import * as React from 'react';
import { Platform, View, StyleSheet, TextInput as NativeTextInput, type LayoutChangeEvent, type TextStyle } from 'react-native';
import type { HappierUiTheme, HappierUiTypography } from '../../environment/types.js';
import { useOptionalHappierUiTypography } from '../../environment/context.js';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import { HappierText as Text, useHappierTextPresentation } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import { scaleTextStyleMetrics } from '../text/textStyleScale.js';
import { HappierSpinner } from '../feedback/Spinner.js';
import { HappierPressable } from './Pressable.js';
import { HAPPIER_TEXT_INPUT_FOCUS_RESET_STYLE, HAPPIER_TEXT_INPUT_WEB_MARKER } from './focusVisible.js';
import { isHappierPageRowNarrow, readHappierVisibleLayoutWidth } from '../layout/pageMetrics.js';
import type { HappierFocusable, HappierStyleProp } from '../portableTypes.js';

import { arrangeOfferedChoices, resolveOfferedChoiceLayout, type OfferedChoice } from './offeredChoiceLayout.js';
export type { OfferedChoice } from './offeredChoiceLayout.js';

export type OfferedChoiceButtonProps = Readonly<{
  testID?: string;
  primary?: boolean;
  disabled?: boolean;
  accessibilityState?: Readonly<{ disabled?: boolean; busy?: boolean }>;
  style: HappierStyleProp;
  onPress?: () => void;
  hitReach?: number;
  children: React.ReactNode;
}>;

export type OfferedChoiceFeedbackInputHostProps = Readonly<{
  testID: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  editable: boolean;
  accessibilityLabel?: string;
  autoFocus?: boolean;
  style: HappierStyleProp;
  placeholderTextColor: string;
}>;
export type OfferedChoiceFeedbackInputProps = Omit<OfferedChoiceFeedbackInputHostProps, 'style' | 'placeholderTextColor'> & Readonly<{
  theme: HappierUiTheme;
  renderInput?: (props: OfferedChoiceFeedbackInputHostProps) => React.ReactNode;
}>;

export type OfferedChoicesProps = Readonly<{
  theme: HappierUiTheme;
  choices: readonly OfferedChoice[];
  primaryId: string | null;
  disabled: boolean;
  busyChoiceId: string | null;
  unavailableReason: string;
  unavailableIcon?: React.ReactNode;
  feedbackPlaceholder: string;
  cancelLabel: string;
  onChoose: (choiceId: string, feedback?: string) => void;
  primaryControlRef?: (control: HappierFocusable | null) => void;
  testID?: string;
  /** Native hosts may retain their decision ref contract without owning row/list geometry. */
  renderButton?: (props: OfferedChoiceButtonProps) => React.ReactNode;
  renderFeedbackInput?: OfferedChoiceFeedbackInputProps['renderInput'];
}>;

function DefaultFeedbackInput(props: OfferedChoiceFeedbackInputHostProps) {
  const text = useHappierTextPresentation({});
  const style = scaleTextStyleMetrics(props.style, text.metricScale) as TextStyle;
  return <NativeTextInput {...props} {...HAPPIER_TEXT_INPUT_WEB_MARKER}
    style={[style, HAPPIER_TEXT_INPUT_FOCUS_RESET_STYLE]} multiline allowFontScaling={text.allowHostFontScaling} />;
}

/** One multiline decision-feedback field, also consumed by the core plan-change adapter. */
export function OfferedChoiceFeedbackInput({ theme, renderInput, ...props }: OfferedChoiceFeedbackInputProps): React.ReactElement {
  const typography = useOptionalHappierUiTypography();
  const input: OfferedChoiceFeedbackInputHostProps = {
    ...props,
    style: { ...resolveHappierTypeRoleStyle('body', theme, typography), borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10,
      paddingHorizontal: HAPPIER_SPACE_STEPS.s12, paddingVertical: HAPPIER_SPACE_STEPS.s10,
      minHeight: 88, color: theme.colors.text, textAlignVertical: 'top' },
    placeholderTextColor: theme.colors.secondaryText,
  };
  return <>{renderInput ? renderInput(input) : <DefaultFeedbackInput {...input} />}</>;
}

function ChoiceButton(props: OfferedChoiceButtonProps & Readonly<{
  primaryControlRef?: OfferedChoicesProps['primaryControlRef'];
  renderButton?: OfferedChoicesProps['renderButton'];
}>) {
  const { renderButton, primaryControlRef, primary, ...input } = props;
  if (renderButton) return renderButton({ ...input, primary });
  return <HappierPressable testID={input.testID} accessibilityRole="button"
    disabled={input.disabled} busy={input.accessibilityState?.busy} onPress={input.onPress ?? (() => {})}
    controlRef={primary ? primaryControlRef : undefined} hitReach={input.hitReach ?? HAPPIER_SPACE_STEPS.s6 / 2}
    style={({ pressed }) => [input.style, pressed && { opacity: 0.7 }]}>{input.children}</HappierPressable>;
}

/**
 * Offered decisions: every caller-supplied choice, its words verbatim and in its order. One footer, two layouts: a row while they all fit on one line, otherwise (and always on a phone) a
 * list whose rows show the caller's descriptions. The caller chooses the primary.
 */
export const OfferedChoices = React.memo(
  function OfferedChoices(props: OfferedChoicesProps) {
    const theme = props.theme;
    const typography = useOptionalHappierUiTypography();
    const styles = React.useMemo(() => createStyles(theme, typography), [theme, typography]);
    const testID = props.testID ?? "offered-choices";
    const [containerWidthPx, setContainerWidthPx] = React.useState<
      number | null
    >(null);
    const [rowNaturalWidthPx, setRowNaturalWidthPx] = React.useState<
      number | null
    >(null);
    const onContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
      const width = readHappierVisibleLayoutWidth(
        event.nativeEvent.layout.width,
      );
      if (width !== null)
        setContainerWidthPx((current) => (current === width ? current : width));
    }, []);
    const onRowMeasure = React.useCallback((event: LayoutChangeEvent) => {
      const width = readHappierVisibleLayoutWidth(
        event.nativeEvent.layout.width,
      );
      if (width !== null)
        setRowNaturalWidthPx((current) =>
          current === width ? current : width,
        );
    }, []);
    // The shared narrow-row rule on this view's own column: a phone always lists.
    const narrow = isHappierPageRowNarrow(containerWidthPx);
    const arranged = arrangeOfferedChoices(props.choices, props.primaryId);
    const endEdge = arranged.rowEnd[arranged.rowEnd.length - 1];
    const layout = resolveOfferedChoiceLayout({
      narrow,
      primaryLeadsApprovals: props.primaryId === null || endEdge?.id === props.primaryId,
      rowNaturalWidthPx,
      containerWidthPx,
    });
    const unavailable = props.choices.find(
      (choice) => !choice.available,
    );
    const ownerRequiredReason = props.unavailableReason;
    // A choice that accepts feedback opens the feedback field in the choices' place; its own label sends it.
    const [feedbackChoiceId, setFeedbackChoiceId] = React.useState<string | null>(null);
    const [feedback, setFeedback] = React.useState('');
    const feedbackChoice = feedbackChoiceId === null || props.disabled
      ? null
      : props.choices.find((choice) => choice.id === feedbackChoiceId && choice.available) ?? null;
    const choose = (choice: OfferedChoice) => {
      if (choice.allowsFeedback) setFeedbackChoiceId(choice.id);
      else props.onChoose(choice.id);
    };
    const sendFeedback = (choice: OfferedChoice) => {
      const trimmed = feedback.trim();
      setFeedbackChoiceId(null);
      props.onChoose(choice.id, trimmed.length > 0 ? trimmed : undefined);
    };

    const renderRowChoice = (
      choice: OfferedChoice,
      measuring: boolean,
    ) => {
      const refusal = choice.refusal;
      const primary = choice.id === props.primaryId;
      const disabled =
        props.disabled || !choice.available;
      const busy = props.busyChoiceId === choice.id;
      return (
        <ChoiceButton
          key={choice.id}
          testID={
            measuring ? undefined : `${testID}.choice.${choice.id}`
          }
          primary={!measuring && primary}
          renderButton={props.renderButton}
          primaryControlRef={props.primaryControlRef}
          accessibilityState={{ disabled, busy }}
          style={[
            styles.rowButton,
            refusal
              ? styles.rowRefusal
              : primary
                ? styles.rowPrimary
                : styles.rowBordered,
            disabled && !busy && styles.withheld,
          ]}
          onPress={measuring ? undefined : () => choose(choice)}
          disabled={measuring || disabled}
        >
          <View style={styles.rowContent}>
            {busy ? (
              <HappierSpinner
                size={Platform.OS === 'ios' ? 'small' : 14}
                color={
                  primary
                    ? theme.colors.onAccent
                    : theme.colors.secondaryText
                }
              />
            ) : null}
            <Text
              style={[
                styles.label,
                refusal
                  ? styles.labelRefusal
                  : primary
                    ? styles.labelPrimary
                    : null,
              ]}
              numberOfLines={1}
            >
              {choice.label}
            </Text>
          </View>
        </ChoiceButton>
      );
    };

    const renderListChoice = (
      choice: OfferedChoice,
      index: number,
    ) => {
      const refusal = choice.refusal;
      const primary = choice.id === props.primaryId;
      const disabled =
        props.disabled || !choice.available;
      const busy = props.busyChoiceId === choice.id;
      // A second line only when it adds something: a description that restates the label is noise.
      const description = choice.description?.trim() && choice.description.trim() !== choice.label.trim()
        ? choice.description
        : null;
      const hairline =
        arranged.refusalsTrail &&
        refusal &&
        index > 0 &&
        !props.choices[index - 1]!.refusal;
      return (
        <React.Fragment key={choice.id}>
          {hairline ? <View style={styles.hairline} /> : null}
          <ChoiceButton
            testID={`${testID}.choice.${choice.id}`}
            primary={primary}
            renderButton={props.renderButton}
            primaryControlRef={props.primaryControlRef}
            accessibilityState={{ disabled, busy }}
            style={[
              styles.listRow,
              refusal
                ? styles.listRefusal
                : primary
                  ? styles.rowPrimary
                  : styles.rowBordered,
              disabled && !busy && styles.withheld,
            ]}
            onPress={() => choose(choice)}
            disabled={disabled}
            hitReach={0}
          >
            <View style={styles.listContent}>
              <Text
                style={[
                  styles.label,
                  refusal
                    ? styles.labelRefusal
                    : primary
                      ? styles.labelPrimary
                      : null,
                ]}
              >
                {choice.label}
              </Text>
              {description ? (
                <Text
                  style={[
                    styles.description,
                    primary && styles.descriptionPrimary,
                  ]}
                >
                  {description}
                </Text>
              ) : null}
            </View>
            {busy ? (
              <HappierSpinner
                size={Platform.OS === 'ios' ? 'small' : 14}
                color={
                  primary
                    ? theme.colors.onAccent
                    : theme.colors.secondaryText
                }
              />
            ) : null}
          </ChoiceButton>
        </React.Fragment>
      );
    };

    return (
      <View onLayout={onContainerLayout} style={styles.container}>
        {/* The row's natural one-line width, measured out of flow and never seen. */}
        {narrow ? null : (
          <View
            style={styles.measure}
            onLayout={onRowMeasure}
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {[...arranged.rowStart, ...arranged.rowEnd].map((choice) =>
              renderRowChoice(choice, true),
            )}
          </View>
        )}
        {feedbackChoice ? (
          <View style={styles.feedback}>
            <OfferedChoiceFeedbackInput
              testID={`${testID}.feedback`}
              theme={theme}
              renderInput={props.renderFeedbackInput}
              value={feedback}
              onChangeText={setFeedback}
              placeholder={props.feedbackPlaceholder}
              accessibilityLabel={feedbackChoice.label}
              editable
              autoFocus
            />
            <View style={styles.row}>
              <View style={styles.rowStart}>
                <ChoiceButton
                  testID={`${testID}.feedback.cancel`}
                  renderButton={props.renderButton}
                  style={[styles.rowButton, styles.rowRefusal]}
                  onPress={() => setFeedbackChoiceId(null)}
                >
                  <Text style={[styles.label, styles.labelRefusal]} numberOfLines={1}>{props.cancelLabel}</Text>
                </ChoiceButton>
              </View>
              <View style={styles.rowEnd}>
                <ChoiceButton
                  testID={`${testID}.feedback.send`}
                  primary
                  renderButton={props.renderButton}
                  primaryControlRef={props.primaryControlRef}
                  style={[styles.rowButton, styles.rowPrimary]}
                  onPress={() => sendFeedback(feedbackChoice)}
                >
                  <Text style={[styles.label, styles.labelPrimary]} numberOfLines={1}>{feedbackChoice.label}</Text>
                </ChoiceButton>
              </View>
            </View>
          </View>
        ) : layout === 'row' ? (
          <>
            {unavailable ? (
              <View style={styles.reason}>
                {props.unavailableIcon}
                <Text style={styles.reasonText}>
                  {ownerRequiredReason}
                </Text>
              </View>
            ) : null}
            <View style={styles.row}>
              <View style={styles.rowStart}>
                {arranged.rowStart.map((choice) =>
                  renderRowChoice(choice, false),
                )}
              </View>
              <View style={styles.rowEnd}>
                {arranged.rowEnd.map((choice) =>
                  renderRowChoice(choice, false),
                )}
              </View>
            </View>
          </>
        ) : (
          <View style={styles.list}>{props.choices.map(renderListChoice)}</View>
        )}
      </View>
    );
  },
);

function createStyles(theme: HappierUiTheme, typography: HappierUiTypography | null) {
  return StyleSheet.create({
  container: {
    gap: HAPPIER_SPACE_STEPS.s8,
  },
  feedback: {
    gap: HAPPIER_SPACE_STEPS.s10,
  },
  measure: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
    pointerEvents: 'none',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignSelf: 'flex-start',
    gap: HAPPIER_SPACE_STEPS.s8,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HAPPIER_SPACE_STEPS.s6,
  },
  reasonText: {
    ...resolveHappierTypeRoleStyle('meta', theme, typography),
    color: theme.colors.secondaryText,
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: HAPPIER_SPACE_STEPS.s8,
  },
  rowStart: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HAPPIER_SPACE_STEPS.s8,
  },
  rowEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: HAPPIER_SPACE_STEPS.s8,
    flexShrink: 1,
  },
  rowButton: {
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: HAPPIER_SPACE_STEPS.s12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HAPPIER_SPACE_STEPS.s6,
  },
  rowPrimary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  rowBordered: {
    borderColor: theme.colors.divider,
  },
  rowRefusal: {
    paddingHorizontal: HAPPIER_SPACE_STEPS.s4,
  },
  withheld: {
    opacity: 0.45,
  },
  label: {
    ...resolveHappierTypeRoleStyle('body', theme, typography),
    fontWeight: '500',
    color: theme.colors.text,
    flexShrink: 1,
  },
  labelPrimary: {
    color: theme.colors.onAccent,
    fontWeight: '600',
  },
  labelRefusal: {
    color: theme.colors.secondaryText,
  },
  list: {
    gap: HAPPIER_SPACE_STEPS.s6,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HAPPIER_SPACE_STEPS.s8,
    minHeight: 44,
    paddingHorizontal: HAPPIER_SPACE_STEPS.s12,
    paddingVertical: HAPPIER_SPACE_STEPS.s8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  listRefusal: {
    paddingVertical: HAPPIER_SPACE_STEPS.s6,
  },
  listContent: {
    flex: 1,
    gap: HAPPIER_SPACE_STEPS.s2,
  },
  description: {
    ...resolveHappierTypeRoleStyle('meta', theme, typography),
    color: theme.colors.secondaryText,
  },
  descriptionPrimary: {
    color: theme.colors.onAccent,
    opacity: 0.8,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.divider,
    marginVertical: HAPPIER_SPACE_STEPS.s2,
  },
  });
}
