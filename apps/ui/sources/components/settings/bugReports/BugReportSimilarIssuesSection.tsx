import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { BugReportSimilarIssue } from './bugReportServiceClient';
import { bugReportComposerStyles } from './bugReportComposerStyles';

export function BugReportSimilarIssuesSection(props: Readonly<{
  loading: boolean;
  issues: BugReportSimilarIssue[];
  selectedIssueNumber: number | null;
  onSelectedIssueNumberChange: (value: number | null) => void;
  disabled: boolean;
}>): React.JSX.Element | null {
  const styles = bugReportComposerStyles;
  const { theme } = useUnistyles();

  if (!props.loading && props.issues.length === 0 && !props.selectedIssueNumber) {
    return null;
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{t('bugReports.composer.similarIssues.title')}</Text>
        <Text style={styles.helperText}>{t('bugReports.composer.similarIssues.subtitle')}</Text>
      </View>

      {props.loading && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
          <Text style={styles.helperText}>{t('bugReports.composer.similarIssues.searching')}</Text>
        </View>
      )}

      {props.selectedIssueNumber && (
        <Pressable
          style={[styles.similarIssueRow, styles.similarIssueRowSelected]}
          onPress={() => props.onSelectedIssueNumberChange(null)}
          disabled={props.disabled}
        >
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.similarIssueTitle}>{t('bugReports.composer.similarIssues.selectedTitle', { number: props.selectedIssueNumber })}</Text>
            <Text style={styles.helperText}>{t('bugReports.composer.similarIssues.selectedSubtitle')}</Text>
          </View>
          <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
        </Pressable>
      )}

      {!props.selectedIssueNumber && props.issues.length > 0 && (
        <View style={styles.similarIssuesList}>
            {props.issues.map((issue) => (
              <Pressable
                key={`${issue.owner}/${issue.repo}#${issue.number}`}
                style={styles.similarIssueRow}
                onPress={() => props.onSelectedIssueNumberChange(issue.number)}
                disabled={props.disabled}
                accessibilityRole="button"
                accessibilityLabel={t('bugReports.composer.similarIssues.useIssueA11y', { number: issue.number })}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.similarIssueTitle}>{`#${issue.number} ${issue.title}`}</Text>
                  <Text style={styles.helperText}>{issue.state === 'open' ? t('bugReports.composer.similarIssues.issueState.open') : t('bugReports.composer.similarIssues.issueState.closed')}</Text>
                </View>
                <Ionicons name="arrow-forward-circle-outline" size={18} color={theme.colors.textSecondary} />
              </Pressable>
            ))}
        </View>
      )}
    </View>
  );
}
