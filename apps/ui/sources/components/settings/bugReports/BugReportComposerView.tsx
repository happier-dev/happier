import React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { openReportSessionSelectionModal } from '@/components/sessions/selection/openReportSessionSelectionModal';
import type { BugReportSessionTarget } from './bugReportDiagnostics';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Text } from '@/components/ui/text/Text';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { useProfile, useActiveMachineFacts } from '@/sync/domains/state/storage';
import { t } from '@/text';

import {
  BugReportConsentSection,
  BugReportDoctorSnapshotField,
  BugReportDiagnosticsSection,
  BugReportEnvironmentSection,
  BugReportFrequencySeveritySection,
  BugReportIssueDetailsSection,
  BugReportMoreDetailSection,
} from './BugReportComposerSections';
import { BugReportSimilarIssuesSection } from './BugReportSimilarIssuesSection';
import { DEFAULT_BUG_REPORT_CAPABILITIES, type BugReportsFeature } from './bugReportFeatureDefaults';
import { useBugReportComposerModel } from './hooks/useBugReportComposerModel';
import { Icon } from '@/components/ui/icons/Icon';

const submitRowStyle: ViewStyle = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 12 };

export const BugReportComposerView = React.memo(function BugReportComposerView(props: Readonly<{ initialSessionTarget?: BugReportSessionTarget | null }>) {
  const safeArea = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const machines = useActiveMachineFacts();
  const profile = useProfile();
  const activeServer = useActiveServerSnapshot();
  const [sessionTarget, setSessionTarget] = React.useState(props.initialSessionTarget ?? null);
  const isSessionVisible = useSessionRecordingVisibility(sessionTarget !== null);
  const selectedServer = sessionTarget ? getServerProfileById(sessionTarget.serverId) : null;
  const serverUrlDefault = sessionTarget ? selectedServer?.serverUrl ?? '' : activeServer.serverUrl;
  const reportScope = React.useMemo(() => ({ scopeKind: 'spawn' as const,
    serverId: sessionTarget?.accountId ? sessionTarget.serverId : activeServer.serverId,
  }), [sessionTarget?.accountId, sessionTarget?.serverId, activeServer.serverId]);
  const bugReportsEnabled = useFeatureEnabled('bugReports', reportScope);
  const bugReportsCapabilities = useFeatureDetails({
    featureId: 'bugReports',
    scope: reportScope,
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
    sessionTarget,
    reportServerId: reportScope.serverId,
  });

  const submitLabel = model.submitting
    ? t('bugReports.composer.submit.submitting')
    : model.existingIssueNumber
      ? t('bugReports.composer.submit.addToIssue', { number: model.existingIssueNumber })
      : t('bugReports.composer.submit.submitNew');

  return (
    <ItemList keyboardAware testID="bug-report-composer" contentContainerStyle={{ paddingBottom: safeArea.bottom + 32 }}>
      <SettingsPageHeader description={t('bugReports.composer.pageDescription')} />
      {model.crashReportStatus === 'saved' && (
        <ItemGroup description={t('appCrash.savedReportNotice')}>
          <SectionContentRow showDivider={false}>
            <View style={submitRowStyle}>
              <RoundButton
                testID="bug-report-copy-saved-crash"
                size="small"
                display="inverted"
                title={t('appCrash.copyDetails')}
                disabled={model.submitting}
                onPress={() => { void model.copySavedCrash(); }}
              />
              <RoundButton
                testID="bug-report-discard-saved-crash"
                size="small"
                display="inverted"
                title={t('appCrash.discardSavedReport')}
                disabled={model.submitting}
                onPress={() => { void model.discardSavedCrash(); }}
              />
            </View>
          </SectionContentRow>
        </ItemGroup>
      )}
      <BugReportIssueDetailsSection
        title={model.title}
        onTitleChange={model.setTitle}
        summary={model.summary}
        onSummaryChange={model.setSummary}
        fieldErrors={{
          title: model.fieldErrors.title,
          summary: model.fieldErrors.summary,
        }}
        disabled={model.submitting}
      />
      <ItemGroup title={t('bugReports.composer.relatedSession')}>
        <Item
          title={t(sessionTarget ? 'bugReports.composer.selectedSession' : 'bugReports.noRelatedSession')}
          subtitle={sessionTarget && isSessionVisible(sessionTarget) ? [sessionTarget.sessionId.slice(0, 12), selectedServer?.name].filter(Boolean).join(' · ') : undefined}
          showChevron={false}
          accessoryLayout="adaptive"
          rightElement={<View style={submitRowStyle}>
            <RoundButton testID="bug-report-select-session" size="small" display="inverted"
              title={t(sessionTarget ? 'bugReports.composer.changeSession' : 'bugReports.composer.chooseSession')}
              disabled={model.submitting} onPress={async () => {
                const selection = await openReportSessionSelectionModal();
                if (selection !== undefined) setSessionTarget(selection);
              }} />
            {sessionTarget ? <RoundButton testID="bug-report-remove-session" size="small" display="inverted"
              title={t('bugReports.composer.removeSession')} disabled={model.submitting}
              onPress={() => setSessionTarget(null)} /> : null}
          </View>}
        />
      </ItemGroup>
      <BugReportSimilarIssuesSection
        loading={model.similarIssues.loading}
        issues={model.similarIssues.issues}
        selectedIssueNumber={model.existingIssueNumber}
        onSelectedIssueNumberChange={model.setExistingIssueNumber}
        disabled={model.submitting}
      />
      <BugReportMoreDetailSection
        showCurrentBehavior={model.crashReportStatus === 'saved' || model.crashReportStatus === 'discarded'}
        reporterGithubUsername={model.reporterGithubUsername}
        onReporterGithubUsernameChange={model.setReporterGithubUsername}
        currentBehavior={model.currentBehavior}
        onCurrentBehaviorChange={model.setCurrentBehavior}
        expectedBehavior={model.expectedBehavior}
        onExpectedBehaviorChange={model.setExpectedBehavior}
        reproductionStepsText={model.reproductionStepsText}
        onReproductionStepsTextChange={model.setReproductionStepsText}
        whatChangedRecently={model.whatChangedRecently}
        onWhatChangedRecentlyChange={model.setWhatChangedRecently}
        disabled={model.submitting}
      >
        <BugReportFrequencySeveritySection disabled={model.submitting}
          frequency={model.frequency}
          onFrequencyChange={model.setFrequency}
          severity={model.severity}
          onSeverityChange={model.setSeverity}
        />
      </BugReportMoreDetailSection>
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
      >
        <BugReportDoctorSnapshotField value={model.pastedCliDoctorSnapshotJson}
          onChange={model.setPastedCliDoctorSnapshotJson} disabled={model.submitting} />
      </BugReportEnvironmentSection>
      <BugReportDiagnosticsSection
        includeDiagnostics={model.includeDiagnostics}
        onIncludeDiagnosticsChange={(value) => {
          model.setIncludeDiagnostics(value);
          if (value && model.diagnosticsKinds.length === 0) {
            model.setDiagnosticsKinds(bugReportsFeature.acceptedArtifactKinds);
          }
        }}
        logSelection={model.logSelection}
        onLogSelectionChange={model.setLogSelection}
        collectionStatuses={model.collectionStatuses}
        disabled={model.submitting}
        onPreviewDiagnostics={model.handlePreviewDiagnostics}
        previewDisabled={model.previewDisabled}
      />
      <BugReportConsentSection
        acceptedPrivacyNotice={model.acceptedPrivacyNotice}
        onAcceptedPrivacyNoticeChange={model.setAcceptedPrivacyNotice}
        errorText={model.includeDiagnostics ? model.fieldErrors.privacy : undefined}
      />
      <ItemGroup surface="none">
        <SectionContentRow showDivider={false}>
          <View style={submitRowStyle}>
            <Text variant="body" style={{ flex: 1, minWidth: 0, color: model.submitHint === 'problem' ? theme.colors.state.danger.foreground : theme.colors.text.secondary }}>
              {model.submitHint === 'required'
                ? t('bugReports.composer.submit.requiredFieldsHint')
                : model.submitHint === 'problem' && model.validation.code !== 'ok'
                  ? model.validation.message
                  : null}
            </Text>
            <RoundButton
              testID="bug-report-submit"
              size="normal"
              title={submitLabel}
              leading={model.submitting ? undefined : <Icon name="paper-plane" size={16} color={theme.colors.button.primary.tint} />}
              loading={model.submitting}
              disabled={model.submitting || model.validation.code !== 'ok'}
              onPress={model.handleSubmit}
            />
          </View>
        </SectionContentRow>
      </ItemGroup>
    </ItemList>
  );
});
