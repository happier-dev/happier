import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { isHappierPageRowNarrow, readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { PermissionDecisionButton } from './PermissionDecisionButton';
import {
  arrangeOfferedChoices,
  isOfferedPermissionChoiceAvailable,
  isRefusingPermissionChoice,
  resolveOfferedChoiceLayout,
  type OfferedPermissionChoice,
} from './offeredChoiceLayout';

type Props = Readonly<{
  choices: readonly OfferedPermissionChoice[];
  primaryId: string | null;
  /** Every choice is withheld (answered, pending, unconfirmed). */
  disabled: boolean;
  busyChoiceId: string | null;
  permissionOwnerLabel?: string;
  onChoose: (choiceId: string) => void;
  primaryRef?: React.Ref<View>;
}>;

/** The second line of a list row: the producer's own rule preview, else what the offered scope means. */
function describeOfferedChoice(choice: OfferedPermissionChoice, ownerRequiredReason: string): string | null {
  if (!isOfferedPermissionChoiceAvailable(choice))
    return ownerRequiredReason;
  if (choice.rulePreview) return choice.rulePreview;
  if (isRefusingPermissionChoice(choice)) return null;
  if (choice.scope === 'session')
    return t('capabilities.session.toolAsk.untilSessionEnds');
  if (choice.scope === 'localPersistent')
    return t('capabilities.session.toolAsk.savedForLater');
  return null;
}

/**
 * `PermissionFooter`'s offered native choices: every choice the agent offered, its words verbatim and in its
 * order. One footer, two layouts: a row while they all fit on one line, otherwise (and always on a phone) a
 * list whose rows say what each scope means. The primary is the narrowest-scope allow.
 */
export const PermissionFooterOfferedChoices = React.memo(
  function PermissionFooterOfferedChoices(props: Props) {
    const { theme } = useUnistyles();
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
    const arranged = arrangeOfferedChoices(props.choices);
    const endEdge = arranged.rowEnd[arranged.rowEnd.length - 1];
    const layout = resolveOfferedChoiceLayout({
      narrow,
      primaryLeadsApprovals: props.primaryId === null || endEdge?.id === props.primaryId,
      rowNaturalWidthPx,
      containerWidthPx,
    });
    const unavailable = props.choices.find(
      (choice) => !isOfferedPermissionChoiceAvailable(choice),
    );
    const ownerRequiredReason = t('capabilities.session.toolAsk.ownerRequired', { owner: props.permissionOwnerLabel });

    const renderRowChoice = (
      choice: OfferedPermissionChoice,
      measuring: boolean,
    ) => {
      const refusal = isRefusingPermissionChoice(choice);
      const primary = choice.id === props.primaryId;
      const disabled =
        props.disabled || !isOfferedPermissionChoiceAvailable(choice);
      const busy = props.busyChoiceId === choice.id;
      return (
        <PermissionDecisionButton
          key={choice.id}
          testID={
            measuring ? undefined : `permission-footer.choice.${choice.id}`
          }
          ref={!measuring && primary ? props.primaryRef : undefined}
          accessibilityRole="button"
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
          onPress={measuring ? undefined : () => props.onChoose(choice.id)}
          disabled={measuring || disabled}
          activeOpacity={0.7}
        >
          <View style={styles.rowContent}>
            {busy ? (
              <ActivitySpinner
                size={Platform.OS === 'ios' ? 'small' : 14}
                color={
                  primary
                    ? theme.colors.button.primary.tint
                    : theme.colors.text.secondary
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
        </PermissionDecisionButton>
      );
    };

    const renderListChoice = (
      choice: OfferedPermissionChoice,
      index: number,
    ) => {
      const refusal = isRefusingPermissionChoice(choice);
      const primary = choice.id === props.primaryId;
      const disabled =
        props.disabled || !isOfferedPermissionChoiceAvailable(choice);
      const busy = props.busyChoiceId === choice.id;
      const description = describeOfferedChoice(choice, ownerRequiredReason);
      const hairline =
        arranged.refusalsTrail &&
        refusal &&
        index > 0 &&
        !isRefusingPermissionChoice(props.choices[index - 1]!);
      return (
        <React.Fragment key={choice.id}>
          {hairline ? <View style={styles.hairline} /> : null}
          <PermissionDecisionButton
            testID={`permission-footer.choice.${choice.id}`}
            ref={primary ? props.primaryRef : undefined}
            accessibilityRole="button"
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
            onPress={() => props.onChoose(choice.id)}
            disabled={disabled}
            activeOpacity={0.7}
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
                  variant="meta"
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
              <ActivitySpinner
                size={Platform.OS === 'ios' ? 'small' : 14}
                color={
                  primary
                    ? theme.colors.button.primary.tint
                    : theme.colors.text.secondary
                }
              />
            ) : null}
          </PermissionDecisionButton>
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
        {layout === 'row' ? (
          <>
            {unavailable ? (
              <View style={styles.reason}>
                <Icon
                  name="info"
                  size={14}
                  color={theme.colors.text.secondary}
                />
                <Text variant="meta" style={styles.reasonText}>
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

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.space.s8,
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
    gap: theme.space.s8,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  reasonText: {
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
  },
  rowStart: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  rowEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    flexShrink: 1,
  },
  rowButton: {
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: theme.space.s12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  rowPrimary: {
    backgroundColor: theme.colors.button.primary.background,
    borderColor: theme.colors.button.primary.background,
  },
  rowBordered: {
    borderColor: theme.colors.border.default,
  },
  rowRefusal: {
    paddingHorizontal: theme.space.s4,
  },
  withheld: {
    opacity: 0.45,
  },
  label: {
    ...Typography.variant('body'),
    fontWeight: '500',
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  labelPrimary: {
    color: theme.colors.button.primary.tint,
    fontWeight: '600',
  },
  labelRefusal: {
    color: theme.colors.text.secondary,
  },
  list: {
    gap: theme.space.s6,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: 44,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  listRefusal: {
    paddingVertical: theme.space.s6,
  },
  listContent: {
    flex: 1,
    gap: theme.space.s2,
  },
  description: {
    color: theme.colors.text.secondary,
  },
  descriptionPrimary: {
    color: theme.colors.button.primary.tint,
    opacity: 0.8,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border.default,
    marginVertical: theme.space.s2,
  },
}));
