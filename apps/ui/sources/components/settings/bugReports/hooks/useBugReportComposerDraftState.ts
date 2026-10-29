import * as React from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';

import {
  inferBugReportDeploymentTypeFromServerUrl as inferDeploymentType,
  redactBugReportSensitiveText,
  type BugReportDeploymentType,
  type BugReportFrequency,
  type BugReportSeverity,
} from '@happier-dev/protocol';

import type { Profile } from '@/sync/domains/profiles/profile';
import { t } from '@/text';
import { Modal } from '@/modal';
import { clearPreRestartBugReportSnapshot, peekPreRestartBugReportSnapshot, formatPreRestartBugReportSnapshotDetails } from '@/utils/system/preRestartBugReportSnapshot';

import { buildBugReportComposerDraftInput, BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH } from '../bugReportComposerDraft';
import type { BugReportComposerSubmissionInput } from '../bugReportSubmissionFlow';

import { useBugReportReporterGithubUsername } from './useBugReportReporterGithubUsername';

export function useBugReportComposerDraftState(input: Readonly<{
  profile: Profile | null;
  serverUrlDefault: string;
}>): {
  title: string;
  setTitle: (value: string) => void;
  reporterGithubUsername: string;
  setReporterGithubUsername: (value: string) => void;
  summary: string;
  setSummary: (value: string) => void;
  currentBehavior: string;
  setCurrentBehavior: (value: string) => void;
  expectedBehavior: string;
  setExpectedBehavior: (value: string) => void;
  reproductionStepsText: string;
  setReproductionStepsText: (value: string) => void;
  whatChangedRecently: string;
  setWhatChangedRecently: (value: string) => void;
  frequency: BugReportFrequency;
  setFrequency: (value: BugReportFrequency) => void;
  severity: BugReportSeverity;
  setSeverity: (value: BugReportSeverity) => void;
  deploymentType: BugReportDeploymentType;
  setDeploymentType: (value: BugReportDeploymentType) => void;
  appVersion: string;
  setAppVersion: (value: string) => void;
  platformValue: string;
  setPlatformValue: (value: string) => void;
  osVersion: string;
  setOsVersion: (value: string) => void;
  deviceModel: string;
  setDeviceModel: (value: string) => void;
  serverUrl: string;
  setServerUrl: (value: string) => void;
  serverVersion: string;
  setServerVersion: (value: string) => void;
  acceptedPrivacyNotice: boolean;
  setAcceptedPrivacyNotice: (value: boolean) => void;
  crashReportStatus: 'loading' | 'saved' | 'none' | 'discarded';
  discardSavedCrash: () => Promise<void>;
  copySavedCrash: () => Promise<void>;
  buildDraftInput: (input: Readonly<{
    includeDiagnostics: boolean;
    diagnosticsKinds: string[];
  }>) => BugReportComposerSubmissionInput;
} {
  const [title, setTitle] = React.useState('');
  const { reporterGithubUsername, setReporterGithubUsername } = useBugReportReporterGithubUsername(input.profile);
  const [summary, setSummary] = React.useState('');
  const [currentBehavior, setCurrentBehavior] = React.useState('');
  const [expectedBehavior, setExpectedBehavior] = React.useState('');
  const [reproductionStepsText, setReproductionStepsText] = React.useState('');
  const [whatChangedRecently, setWhatChangedRecently] = React.useState('');
  const [frequency, setFrequency] = React.useState<BugReportFrequency>('often');
  const [severity, setSeverity] = React.useState<BugReportSeverity>('medium');
  const [deploymentType, setDeploymentTypeState] = React.useState<BugReportDeploymentType>(
    inferDeploymentType(input.serverUrlDefault),
  );
  const [deploymentTypeEdited, setDeploymentTypeEdited] = React.useState(false);

  const [appVersion, setAppVersion] = React.useState(Constants.expoConfig?.version ?? 'unknown');
  const [platformValue, setPlatformValue] = React.useState<string>(Platform.OS);
  const [osVersion, setOsVersion] = React.useState(
    typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version ?? ''),
  );
  const [deviceModel, setDeviceModel] = React.useState(Constants.deviceName ?? '');
  const [serverUrl, setServerUrlState] = React.useState(input.serverUrlDefault);
  const [serverUrlEdited, setServerUrlEdited] = React.useState(false);
  const [serverVersion, setServerVersion] = React.useState('');

  const [acceptedPrivacyNotice, setAcceptedPrivacyNotice] = React.useState(false);
  const [crashReportStatus, setCrashReportStatus] = React.useState<'loading' | 'saved' | 'none' | 'discarded'>('loading');
  const edited = React.useRef({ title: false, summary: false, currentBehavior: false, appVersion: false, platformValue: false, osVersion: false });

  React.useEffect(() => {
    let cancelled = false;
    void peekPreRestartBugReportSnapshot().then((snapshot) => {
      if (cancelled) return;
      setCrashReportStatus(snapshot ? 'saved' : 'none');
      if (!snapshot) return;
      const details = formatPreRestartBugReportSnapshotDetails(snapshot);
      const suffix = `\n\n${t('appCrash.stackTruncated')}`;
      const visibleDetails = details.length > BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH
        ? details.slice(0, BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH - suffix.length) + suffix
        : details;
      if (!edited.current.title) setTitle(t('appCrash.title'));
      if (!edited.current.summary) setSummary((redactBugReportSensitiveText(snapshot.errorDetails).split('\n')[0] || t('appCrash.title')).slice(0, 800));
      if (!edited.current.currentBehavior) setCurrentBehavior(visibleDetails);
      if (!edited.current.appVersion && snapshot.runtime?.appVersion) setAppVersion(snapshot.runtime.appVersion);
      if (!edited.current.platformValue) setPlatformValue(snapshot.platform);
      if (!edited.current.osVersion && snapshot.runtime?.osVersion) setOsVersion(snapshot.runtime.osVersion);
    });
    return () => { cancelled = true; };
  }, []);

  const discardSavedCrash = React.useCallback(async () => {
    if (!await clearPreRestartBugReportSnapshot()) {
      await Modal.alert(t('common.error'), t('appCrash.discardFailed'));
      return;
    }
    setCrashReportStatus('discarded');
  }, []);

  const copySavedCrash = React.useCallback(async () => {
    try {
      const snapshot = await peekPreRestartBugReportSnapshot();
      if (snapshot) await Clipboard.setStringAsync(formatPreRestartBugReportSnapshotDetails(snapshot));
    } catch {
      await Modal.alert(t('common.error'), t('appCrash.copyFailed'));
    }
  }, []);

  const editTitle = React.useCallback((value: string) => { edited.current.title = true; setTitle(value); }, []);
  const editSummary = React.useCallback((value: string) => { edited.current.summary = true; setSummary(value); }, []);
  const editCurrentBehavior = React.useCallback((value: string) => { edited.current.currentBehavior = true; setCurrentBehavior(value); }, []);

  const editAppVersion = React.useCallback((value: string) => { edited.current.appVersion = true; setAppVersion(value); }, []);
  const editPlatformValue = React.useCallback((value: string) => { edited.current.platformValue = true; setPlatformValue(value); }, []);
  const editOsVersion = React.useCallback((value: string) => { edited.current.osVersion = true; setOsVersion(value); }, []);
  React.useEffect(() => {
    if (!serverUrlEdited) {
      setServerUrlState(input.serverUrlDefault);
    }
    if (!deploymentTypeEdited) {
      setDeploymentTypeState(inferDeploymentType(input.serverUrlDefault));
    }
  }, [deploymentTypeEdited, input.serverUrlDefault, serverUrlEdited]);

  const setServerUrl = React.useCallback((value: string) => {
    setServerUrlEdited(true);
    setServerUrlState(value);
  }, []);

  const setDeploymentType = React.useCallback((value: BugReportDeploymentType) => {
    setDeploymentTypeEdited(true);
    setDeploymentTypeState(value);
  }, []);

  const buildDraftInput = React.useCallback((draft: Readonly<{
    includeDiagnostics: boolean;
    diagnosticsKinds: string[];
  }>): BugReportComposerSubmissionInput => {
    return buildBugReportComposerDraftInput({
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
      includeDiagnostics: draft.includeDiagnostics,
      diagnosticsKinds: draft.diagnosticsKinds,
      acceptedPrivacyNotice,
    });
  }, [
    acceptedPrivacyNotice,
    appVersion,
    currentBehavior,
    deploymentType,
    deviceModel,
    expectedBehavior,
    frequency,
    osVersion,
    platformValue,
    reporterGithubUsername,
    reproductionStepsText,
    serverUrl,
    serverVersion,
    severity,
    summary,
    title,
    whatChangedRecently,
  ]);

  return {
    title,
    setTitle: editTitle,
    reporterGithubUsername,
    setReporterGithubUsername,
    summary,
    setSummary: editSummary,
    currentBehavior,
    setCurrentBehavior: editCurrentBehavior,
    expectedBehavior,
    setExpectedBehavior,
    reproductionStepsText,
    setReproductionStepsText,
    whatChangedRecently,
    setWhatChangedRecently,
    frequency,
    setFrequency,
    severity,
    setSeverity,
    deploymentType,
    setDeploymentType,
    appVersion,
    setAppVersion: editAppVersion,
    platformValue,
    setPlatformValue: editPlatformValue,
    osVersion,
    setOsVersion: editOsVersion,
    deviceModel,
    setDeviceModel,
    serverUrl,
    setServerUrl,
    serverVersion,
    setServerVersion,
    acceptedPrivacyNotice,
    setAcceptedPrivacyNotice,
    crashReportStatus,
    discardSavedCrash,
    copySavedCrash,
    buildDraftInput,
  };
}
