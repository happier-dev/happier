import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

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
        <Text style={styles.sectionTitle}>Possible duplicates</Text>
        <Text style={styles.helperText}>If one of these matches, you can post your report as a comment instead of opening a new issue.</Text>
      </View>

      {props.loading && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
          <Text style={styles.helperText}>Searching issues…</Text>
        </View>
      )}

      {props.selectedIssueNumber && (
        <Pressable
          style={[styles.similarIssueRow, styles.similarIssueRowSelected]}
          onPress={() => props.onSelectedIssueNumberChange(null)}
          disabled={props.disabled}
        >
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.similarIssueTitle}>Using issue #{props.selectedIssueNumber}</Text>
            <Text style={styles.helperText}>Tap to switch back to creating a new issue.</Text>
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
              accessibilityLabel={`Use issue #${issue.number}`}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.similarIssueTitle}>#{issue.number} {issue.title}</Text>
                <Text style={styles.helperText}>{issue.state === 'open' ? 'Open issue' : 'Closed issue'}</Text>
              </View>
              <Ionicons name="arrow-forward-circle-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

