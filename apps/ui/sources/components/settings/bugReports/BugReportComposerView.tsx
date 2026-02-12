import React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import {
  BUG_REPORT_DEFAULT_ISSUE_LABELS,
  BUG_REPORT_DEFAULT_ISSUE_OWNER,
  BUG_REPORT_DEFAULT_ISSUE_REPO,
  appendBugReportReporterToSummary,
  inferBugReportDeploymentTypeFromServerUrl as inferDeploymentType,
} from '@happier-dev/protocol';

import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/StyledText';
import { useServerFeatureValue } from '@/hooks/server/useServerFeatures';
import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines, useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { clearBugReportUserActionTrail, recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { clearBugReportLogBuffer } from '@/utils/system/bugReportLogBuffer';

import {
  BugReportConsentSection,
  BugReportDiagnosticsSection,
  BugReportEnvironmentSection,
  BugReportFrequencySeveritySection,
  BugReportIssueDetailsSection,
} from './BugReportComposerSections';
import { bugReportComposerStyles } from './bugReportComposerStyles';
import { collectBugReportDiagnosticsArtifacts } from './bugReportDiagnostics';
import {
  buildFallbackIssueUrl,
  formatFallbackIssueBody,
  normalizeReproductionSteps,
  type BugReportDeploymentType,
  type BugReportFrequency,
  type BugReportSeverity,
} from './bugReportFallback';
import { buildBugReportComposerDraftInput } from './bugReportComposerDraft';
import { DEFAULT_BUG_REPORT_FEATURE, type BugReportsFeature } from './bugReportFeatureDefaults';
import { openBugReportFallbackIssueUrl } from './openBugReportFallback';
import { submitBugReportToService } from './bugReportServiceClient';
import { submitBugReportFromDraft, validateBugReportDraft } from './bugReportSubmissionFlow';
import { useBugReportDiagnosticsPreview } from './hooks/useBugReportDiagnosticsPreview';
import { useBugReportDiagnosticsSelection } from './hooks/useBugReportDiagnosticsSelection';
import { useBugReportReporterGithubUsername } from './hooks/useBugReportReporterGithubUsername';

export const BugReportComposerView = React.memo(function BugReportComposerView() {
  const styles = bugReportComposerStyles;
  const router = useRouter();
  const safeArea = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const profile = useProfile();
  const serverUrlDefault = React.useMemo(() => getActiveServerSnapshot().serverUrl, []);

  const bugReportsFeature = useServerFeatureValue<BugReportsFeature>({
    initial: DEFAULT_BUG_REPORT_FEATURE,
    select: (features) => features?.features?.bugReports ?? DEFAULT_BUG_REPORT_FEATURE,
  });

  const [title, setTitle] = React.useState('');
  const { reporterGithubUsername, setReporterGithubUsername } = useBugReportReporterGithubUsername(profile);
  const [summary, setSummary] = React.useState('');
  const [currentBehavior, setCurrentBehavior] = React.useState('');
  const [expectedBehavior, setExpectedBehavior] = React.useState('');
  const [reproductionStepsText, setReproductionStepsText] = React.useState('');
  const [whatChangedRecently, setWhatChangedRecently] = React.useState('');
  const [frequency, setFrequency] = React.useState<BugReportFrequency>('often');
  const [severity, setSeverity] = React.useState<BugReportSeverity>('medium');
  const [deploymentType, setDeploymentType] = React.useState<BugReportDeploymentType>(inferDeploymentType(serverUrlDefault));

  const [appVersion, setAppVersion] = React.useState(Constants.expoConfig?.version ?? 'unknown');
  const [platformValue, setPlatformValue] = React.useState<string>(Platform.OS);
  const [osVersion, setOsVersion] = React.useState(typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version ?? ''));
  const [deviceModel, setDeviceModel] = React.useState(Constants.deviceName ?? '');
  const [serverUrl, setServerUrl] = React.useState(serverUrlDefault);
  const [serverVersion, setServerVersion] = React.useState('');

  const {
    includeDiagnostics,
    setIncludeDiagnostics,
    diagnosticsKinds,
    setDiagnosticsKinds,
  } = useBugReportDiagnosticsSelection(bugReportsFeature);
  const [acceptedPrivacyNotice, setAcceptedPrivacyNotice] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const collectDiagnosticsArtifacts = React.useCallback(() => collectBugReportDiagnosticsArtifacts({
    machines,
    includeDiagnostics: true,
    acceptedKinds: diagnosticsKinds,
    maxArtifactBytes: bugReportsFeature.maxArtifactBytes,
    contextWindowMs: bugReportsFeature.contextWindowMs,
  }), [
    bugReportsFeature.contextWindowMs,
    bugReportsFeature.maxArtifactBytes,
    diagnosticsKinds,
    machines,
  ]);

  const {
    previewing: previewingDiagnostics,
    previewDisabled,
    handlePreview: handlePreviewDiagnostics,
  } = useBugReportDiagnosticsPreview({
    disabled: submitting,
    includeDiagnostics,
    selectedKinds: diagnosticsKinds,
    collectDiagnosticsArtifacts,
  });

  const keyboardProps = Platform.select({
    ios: {
      behavior: 'padding' as const,
      keyboardVerticalOffset: 0,
    },
    default: {},
  });

  const openFallbackIssue = React.useCallback(async (environment: {
    appVersion: string;
    platform: string;
    osVersion?: string;
    deviceModel?: string;
    serverUrl?: string;
    serverVersion?: string;
    deploymentType: BugReportDeploymentType;
  }) => {
    const fallbackBody = formatFallbackIssueBody({
      summary: appendBugReportReporterToSummary(summary, reporterGithubUsername),
      currentBehavior: currentBehavior.trim(),
      expectedBehavior: expectedBehavior.trim(),
      reproductionSteps: normalizeReproductionSteps(reproductionStepsText),
      frequency,
      severity,
      environment,
      whatChangedRecently: whatChangedRecently.trim() || undefined,
      diagnosticsIncluded: includeDiagnostics,
    });

    const fallbackUrl = buildFallbackIssueUrl({
      owner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
      repo: BUG_REPORT_DEFAULT_ISSUE_REPO,
      title: title.trim() || 'Bug report',
      body: fallbackBody,
      labels: BUG_REPORT_DEFAULT_ISSUE_LABELS,
    });

    const opened = await openBugReportFallbackIssueUrl(fallbackUrl);
      if (opened) {
        recordBugReportUserAction('bug-report.fallback-opened', {
          route: '/settings/report-issue',
          metadata: { diagnosticsIncluded: includeDiagnostics },
        });
        clearBugReportUserActionTrail();
        clearBugReportLogBuffer();
      }
  }, [
    currentBehavior,
    expectedBehavior,
    frequency,
    includeDiagnostics,
    reporterGithubUsername,
    reproductionStepsText,
    severity,
    summary,
    title,
    whatChangedRecently,
  ]);

  const handleSubmit = React.useCallback(async () => {
    if (submitting) return;

    const draftInput = buildBugReportComposerDraftInput({
      title,
      reporterGithubUsername,
      summary,
      currentBehavior,
      expectedBehavior,
      reproductionStepsText,
      whatChangedRecently,
      frequency,
      severity,
      appVersion,
      platformValue,
      osVersion,
      deviceModel,
      serverUrl,
      serverVersion,
      deploymentType,
      includeDiagnostics,
      diagnosticsKinds,
      acceptedPrivacyNotice,
    });
    const validation = validateBugReportDraft(draftInput);
    if (validation.code !== 'ok') {
      await Modal.alert(validation.title, validation.message);
      return;
    }

    setSubmitting(true);
    recordBugReportUserAction('bug-report.submit-started', {
      route: '/settings/report-issue',
      metadata: {
        includeDiagnostics,
        providerEnabled: bugReportsFeature.enabled,
        hasProviderUrl: Boolean(bugReportsFeature.providerUrl),
      },
    });
    try {
      const result = await submitBugReportFromDraft({
        feature: bugReportsFeature,
        machines,
        input: draftInput,
        issueOwner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
        issueRepo: BUG_REPORT_DEFAULT_ISSUE_REPO,
        labels: BUG_REPORT_DEFAULT_ISSUE_LABELS,
        openFallbackIssue,
        collectDiagnosticsArtifacts: collectBugReportDiagnosticsArtifacts,
        submitBugReport: submitBugReportToService,
      });

      if (result.mode === 'fallback') {
        return;
      }

      await Modal.alert('Bug report submitted', `Issue #${result.issueNumber} has been created.\n\nReport ID: ${result.reportId}`);
      recordBugReportUserAction('bug-report.submit-succeeded', {
        route: '/settings/report-issue',
        metadata: {
          issueNumber: result.issueNumber,
          includeDiagnostics,
        },
      });

      await openBugReportFallbackIssueUrl(result.issueUrl);
      clearBugReportUserActionTrail();
      clearBugReportLogBuffer();
      router.back();
    } catch (error) {
      const fallback = await Modal.confirm(
        'Submission failed',
        `${error instanceof Error ? error.message : 'Could not submit this report.'}\n\nDo you want to open a prefilled GitHub issue instead?`,
        {
          confirmText: 'Open fallback issue',
          cancelText: t('common.cancel'),
        },
      );

      if (fallback) {
        await openFallbackIssue(draftInput.environment);
      }
      recordBugReportUserAction('bug-report.submit-failed', {
        route: '/settings/report-issue',
        metadata: {
          includeDiagnostics,
          fallbackOpened: Boolean(fallback),
        },
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    acceptedPrivacyNotice,
    appVersion,
    bugReportsFeature,
    currentBehavior,
    deploymentType,
    deviceModel,
    expectedBehavior,
    frequency,
    includeDiagnostics,
    diagnosticsKinds,
    machines,
    openFallbackIssue,
    osVersion,
    platformValue,
    reporterGithubUsername,
    reproductionStepsText,
    router,
    serverUrl,
    serverVersion,
    severity,
    submitting,
    summary,
    title,
    whatChangedRecently,
  ]);

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
              title={title}
              onTitleChange={setTitle}
              reporterGithubUsername={reporterGithubUsername}
              onReporterGithubUsernameChange={setReporterGithubUsername}
              summary={summary}
              onSummaryChange={setSummary}
              currentBehavior={currentBehavior}
              onCurrentBehaviorChange={setCurrentBehavior}
              expectedBehavior={expectedBehavior}
              onExpectedBehaviorChange={setExpectedBehavior}
              reproductionStepsText={reproductionStepsText}
              onReproductionStepsTextChange={setReproductionStepsText}
              whatChangedRecently={whatChangedRecently}
              onWhatChangedRecentlyChange={setWhatChangedRecently}
              placeholderTextColor={theme.colors.input.placeholder}
              disabled={submitting}
            />

            <BugReportFrequencySeveritySection
              frequency={frequency}
              onFrequencyChange={setFrequency}
              severity={severity}
              onSeverityChange={setSeverity}
            />

            <BugReportEnvironmentSection
              appVersion={appVersion}
              onAppVersionChange={setAppVersion}
              platformValue={platformValue}
              onPlatformValueChange={setPlatformValue}
              osVersion={osVersion}
              onOsVersionChange={setOsVersion}
              deviceModel={deviceModel}
              onDeviceModelChange={setDeviceModel}
              serverUrl={serverUrl}
              onServerUrlChange={setServerUrl}
              serverVersion={serverVersion}
              onServerVersionChange={setServerVersion}
              deploymentType={deploymentType}
              onDeploymentTypeChange={setDeploymentType}
              disabled={submitting}
            />

            <BugReportDiagnosticsSection
              includeDiagnostics={includeDiagnostics}
              onIncludeDiagnosticsChange={(value) => {
                setIncludeDiagnostics(value);
                if (value && diagnosticsKinds.length === 0) {
                  setDiagnosticsKinds(bugReportsFeature.acceptedArtifactKinds);
                }
              }}
              acceptedKinds={bugReportsFeature.acceptedArtifactKinds}
              selectedKinds={diagnosticsKinds}
	              onSelectedKindsChange={setDiagnosticsKinds}
	              onPreviewDiagnostics={handlePreviewDiagnostics}
	              previewDisabled={previewDisabled}
	            />

            <BugReportConsentSection
              acceptedPrivacyNotice={acceptedPrivacyNotice}
              onAcceptedPrivacyNoticeChange={setAcceptedPrivacyNotice}
            />

            <Pressable
              style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
              onPress={handleSubmit}
              disabled={submitting}
            >
              {submitting
                ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                : <Ionicons name="paper-plane-outline" size={18} color={theme.colors.button.primary.tint} />}
              <Text style={styles.submitButtonText}>{submitting ? 'Submitting report…' : 'Submit bug report'}</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </>
  );
});
