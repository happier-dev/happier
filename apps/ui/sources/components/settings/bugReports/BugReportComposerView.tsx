import React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/StyledText';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines, useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';

import {
  BugReportConsentSection,
  BugReportDiagnosticsSection,
  BugReportEnvironmentSection,
  BugReportFrequencySeveritySection,
  BugReportIssueDetailsSection,
} from './BugReportComposerSections';
import { BugReportSimilarIssuesSection } from './BugReportSimilarIssuesSection';
import { bugReportComposerStyles } from './bugReportComposerStyles';
import { DEFAULT_BUG_REPORT_CAPABILITIES, type BugReportsFeature } from './bugReportFeatureDefaults';
import { useBugReportComposerModel } from './hooks/useBugReportComposerModel';

export const BugReportComposerView = React.memo(function BugReportComposerView() {
  const styles = bugReportComposerStyles;
  const safeArea = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const profile = useProfile();
  const serverUrlDefault = React.useMemo(() => getActiveServerSnapshot().serverUrl, []);
  const bugReportsEnabled = useFeatureEnabled('bugReports');
  const bugReportsCapabilities = useFeatureDetails({
    featureId: 'bugReports',
    fallback: DEFAULT_BUG_REPORT_CAPABILITIES,
    select: (features) => features.capabilities.bugReports,
  });
  const bugReportsFeature = React.useMemo<BugReportsFeature>(
    () => ({ ...bugReportsCapabilities, enabled: bugReportsEnabled }),
    [bugReportsEnabled, bugReportsCapabilities],
  );

  const model = useBugReportComposerModel({
    feature: bugReportsFeature,
    machines,
    profile,
    serverUrlDefault,
    route: '/settings/report-issue',
  });

  const keyboardProps = Platform.select({
    ios: {
      behavior: 'padding' as const,
      keyboardVerticalOffset: 0,
    },
    default: {},
  });

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitle: t('settings.reportIssue'),
        }}
      />
      <View style={styles.container}>
        <KeyboardAvoidingView {...keyboardProps} style={{ flex: 1 }}>
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={[
              styles.contentContainer,
              { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', paddingBottom: safeArea.bottom + 32 },
            ]}
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior={Platform.OS === 'ios' ? 'automatic' : undefined}
          >
	              <BugReportIssueDetailsSection
	                title={model.title}
	                onTitleChange={model.setTitle}
	                reporterGithubUsername={model.reporterGithubUsername}
	                onReporterGithubUsernameChange={model.setReporterGithubUsername}
	                summary={model.summary}
	                onSummaryChange={model.setSummary}
	                currentBehavior={model.currentBehavior}
	                onCurrentBehaviorChange={model.setCurrentBehavior}
	                expectedBehavior={model.expectedBehavior}
	                onExpectedBehaviorChange={model.setExpectedBehavior}
	                reproductionStepsText={model.reproductionStepsText}
	                onReproductionStepsTextChange={model.setReproductionStepsText}
	                whatChangedRecently={model.whatChangedRecently}
	                onWhatChangedRecentlyChange={model.setWhatChangedRecently}
	                placeholderTextColor={theme.colors.input.placeholder}
	                fieldErrors={{
	                  title: model.fieldErrors.title,
	                  summary: model.fieldErrors.summary,
	                }}
	                disabled={model.submitting}
	              />

            <BugReportSimilarIssuesSection
              loading={model.similarIssues.loading}
              issues={model.similarIssues.issues}
              selectedIssueNumber={model.existingIssueNumber}
              onSelectedIssueNumberChange={model.setExistingIssueNumber}
              disabled={model.submitting}
            />

            <BugReportFrequencySeveritySection
              frequency={model.frequency}
              onFrequencyChange={model.setFrequency}
              severity={model.severity}
              onSeverityChange={model.setSeverity}
            />

            <BugReportEnvironmentSection
              appVersion={model.appVersion}
              onAppVersionChange={model.setAppVersion}
              platformValue={model.platformValue}
              onPlatformValueChange={model.setPlatformValue}
              osVersion={model.osVersion}
              onOsVersionChange={model.setOsVersion}
              deviceModel={model.deviceModel}
              onDeviceModelChange={model.setDeviceModel}
              serverUrl={model.serverUrl}
              onServerUrlChange={model.setServerUrl}
              serverVersion={model.serverVersion}
              onServerVersionChange={model.setServerVersion}
              deploymentType={model.deploymentType}
              onDeploymentTypeChange={model.setDeploymentType}
              disabled={model.submitting}
            />

            <BugReportDiagnosticsSection
              includeDiagnostics={model.includeDiagnostics}
              onIncludeDiagnosticsChange={(value) => {
                model.setIncludeDiagnostics(value);
                if (value && model.diagnosticsKinds.length === 0) {
                  model.setDiagnosticsKinds(bugReportsFeature.acceptedArtifactKinds);
                }
              }}
              acceptedKinds={bugReportsFeature.acceptedArtifactKinds}
              selectedKinds={model.diagnosticsKinds}
              onSelectedKindsChange={model.setDiagnosticsKinds}
              onPreviewDiagnostics={model.handlePreviewDiagnostics}
              previewDisabled={model.previewDisabled}
            />

            <BugReportConsentSection
              acceptedPrivacyNotice={model.acceptedPrivacyNotice}
              onAcceptedPrivacyNoticeChange={model.setAcceptedPrivacyNotice}
              errorText={model.includeDiagnostics ? model.fieldErrors.privacy : undefined}
            />

	            {model.validation.code !== 'ok' && (
	              <View style={{ marginHorizontal: 12, marginTop: -8 }}>
	                {model.title.trim().length === 0
	                  && model.summary.trim().length === 0
	                  && !model.includeDiagnostics
	                  ? <Text style={bugReportComposerStyles.helperText}>Complete the required fields to enable submission.</Text>
	                  : <Text style={bugReportComposerStyles.errorText}>{model.validation.message}</Text>}
	              </View>
	            )}

            <Pressable
              style={[
                styles.submitButton,
                (model.submitting || model.validation.code !== 'ok') && styles.submitButtonDisabled,
              ]}
              onPress={model.handleSubmit}
              disabled={model.submitting || model.validation.code !== 'ok'}
            >
              {model.submitting
                ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                : <Ionicons name="paper-plane-outline" size={18} color={theme.colors.button.primary.tint} />}
              <Text style={styles.submitButtonText}>
                {model.submitting
                  ? 'Submitting report…'
                  : model.existingIssueNumber
                    ? `Add to issue #${model.existingIssueNumber}`
                    : 'Submit bug report'}
              </Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </>
  );
});
