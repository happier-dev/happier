import * as React from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import {
  inferBugReportDeploymentTypeFromServerUrl as inferDeploymentType,
  type BugReportDeploymentType,
  type BugReportFrequency,
  type BugReportSeverity,
} from '@happier-dev/protocol';

import type { Profile } from '@/sync/domains/profiles/profile';

import { buildBugReportComposerDraftInput } from '../bugReportComposerDraft';
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
  const [deploymentType, setDeploymentType] = React.useState<BugReportDeploymentType>(
    inferDeploymentType(input.serverUrlDefault),
  );

  const [appVersion, setAppVersion] = React.useState(Constants.expoConfig?.version ?? 'unknown');
  const [platformValue, setPlatformValue] = React.useState<string>(Platform.OS);
  const [osVersion, setOsVersion] = React.useState(
    typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version ?? ''),
  );
  const [deviceModel, setDeviceModel] = React.useState(Constants.deviceName ?? '');
  const [serverUrl, setServerUrl] = React.useState(input.serverUrlDefault);
  const [serverVersion, setServerVersion] = React.useState('');

  const [acceptedPrivacyNotice, setAcceptedPrivacyNotice] = React.useState(false);

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
    setTitle,
    reporterGithubUsername,
    setReporterGithubUsername,
    summary,
    setSummary,
    currentBehavior,
    setCurrentBehavior,
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
    setAppVersion,
    platformValue,
    setPlatformValue,
    osVersion,
    setOsVersion,
    deviceModel,
    setDeviceModel,
    serverUrl,
    setServerUrl,
    serverVersion,
    setServerVersion,
    acceptedPrivacyNotice,
    setAcceptedPrivacyNotice,
    buildDraftInput,
  };
}

