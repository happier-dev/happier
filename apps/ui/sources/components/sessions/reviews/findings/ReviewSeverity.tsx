import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HappierReviewSeveritySign } from '@happier-dev/plugin-ui/presentation';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { StructuredFindText } from '@/components/sessions/transcript/structured/structuredFindText';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import {
  reviewSeverityCounts,
  reviewSeverityLabel,
} from './reviewFindingPresentation';

/**
 * How a finding's severity is drawn wherever a finding appears (Walkthrough lab WT5): its dot and its word,
 * in its colour ("● High"), by the shared severity owner plugins draw with. Core supplies only its scaled
 * text (and its Find run).
 */
export function ReviewSeverityLabel(
  props: Readonly<{
    severity: ReviewFinding['severity'];
    label?: string;
    findBlockId?: string;
  }>,
) {
  const presentationTheme = usePresentationTheme();
  const label = props.label ?? reviewSeverityLabel(props.severity);
  return (
    <HappierReviewSeveritySign
      severity={props.severity}
      theme={presentationTheme}
      label={props.findBlockId ? (
        <StructuredFindText blockId={props.findBlockId} text={label} style={styles.severityText} />
      ) : (
        <Text style={styles.severityText}>{label}</Text>
      )}
    />
  );
}

/** The dot a contents row carries when its stop has a finding; the most severe one's colour. */
export function ReviewSeverityDot(
  props: Readonly<{ severity: ReviewFinding['severity'] }>,
) {
  const presentationTheme = usePresentationTheme();
  return (
    <HappierReviewSeveritySign
      presentation="dot"
      severity={props.severity}
      theme={presentationTheme}
      label={reviewSeverityLabel(props.severity)}
    />
  );
}

function usePresentationTheme() {
  const { theme } = useUnistyles();
  return usePluginUiTheme(theme);
}

/** "● 1 high  ● 2 medium  ● 1 low": a review's counts, most severe first (lab WT5-R8). */
export function ReviewSeveritySummary(
  props: Readonly<{
    findings: readonly ReviewFinding[];
    testID?: string;
    findBlockPrefix?: string;
  }>,
) {
  const counts = React.useMemo(
    () => reviewSeverityCounts(props.findings),
    [props.findings],
  );
  if (counts.length === 0) return null;
  return (
    <View testID={props.testID} style={styles.summary}>
      {counts.map(({ severity, label }) => (
        <ReviewSeverityLabel
          key={severity}
          severity={severity}
          label={label}
          findBlockId={
            props.findBlockPrefix
              ? `${props.findBlockPrefix}:${severity}`
              : undefined
          }
        />
      ))}
    </View>
  );
}

/**
 * One finding as a single line (lab WT5-R5 findings first, WT5-R8 finished card): severity in its own
 * column so every title starts on one edge, the title, then who found it. Pressable when the line leads
 * to the finding.
 */
export function ReviewFindingLine(
  props: Readonly<{
    severity: ReviewFinding['severity'];
    title: string;
    reviewer: string;
    testID?: string;
    /** Block ids for in-transcript Find: `<prefix>:severity|title|reviewer`. */
    findBlockPrefix?: string;
    onPress?: () => void;
  }>,
) {
  const find = props.findBlockPrefix;
  const content = (
    <>
      <View style={styles.lineSeverity}>
        <ReviewSeverityLabel
          severity={props.severity}
          findBlockId={find ? `${find}:severity` : undefined}
        />
      </View>
      {find ? (
        <StructuredFindText
          blockId={`${find}:title`}
          text={props.title}
          numberOfLines={1}
          style={styles.lineTitle}
        />
      ) : (
        <Text style={styles.lineTitle} numberOfLines={1}>
          {props.title}
        </Text>
      )}
      {find ? (
        <StructuredFindText
          blockId={`${find}:reviewer`}
          text={props.reviewer}
          numberOfLines={1}
          style={styles.lineReviewer}
        />
      ) : (
        <Text style={styles.lineReviewer} numberOfLines={1}>
          {props.reviewer}
        </Text>
      )}
    </>
  );
  if (!props.onPress)
    return (
      <View testID={props.testID} style={styles.line}>
        {content}
      </View>
    );
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={`${reviewSeverityLabel(props.severity)}: ${props.title}`}
      onPress={props.onPress}
      style={(state) => [
        styles.line,
        state.pressed ? styles.linePressed : null,
      ]}
    >
      {content}
    </HappierPressable>
  );
}

/** The severity column of a finding line: wide enough for "● Medium", so titles share one left edge. */
export const REVIEW_SEVERITY_COLUMN_WIDTH_PX = 72;

const styles = StyleSheet.create((theme) => ({
  severityText: {  ...Typography.variant('body', 'semiBold') },
  summary: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: theme.space.s4 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    minHeight: 30,
    borderRadius: 6,
  },
  linePressed: { backgroundColor: theme.colors.surface.pressed },
  lineSeverity: { width: REVIEW_SEVERITY_COLUMN_WIDTH_PX },
  lineTitle: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    color: theme.colors.text.primary,
  },
  lineReviewer: {
    flexShrink: 0,
    maxWidth: '30%',
    ...Typography.variant('body'),
    color: theme.colors.text.tertiary,
    textAlign: 'right',
  },
}));
