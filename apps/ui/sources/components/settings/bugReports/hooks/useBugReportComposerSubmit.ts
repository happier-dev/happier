import * as React from 'react';

import { useRouter } from 'expo-router';

import { Modal } from '@/modal';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { clearBugReportUserActionTrail, recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { clearBugReportLogBuffer } from '@/utils/system/bugReportLogBuffer';

import { collectBugReportDiagnosticsArtifacts } from '../bugReportDiagnostics';
import type { BugReportsFeature } from '../bugReportFeatureDefaults';
import { openBugReportFallbackIssueUrl } from '../openBugReportFallback';
import { submitBugReportToService } from '../bugReportServiceClient';
import { submitBugReportFromDraft, validateBugReportDraft } from '../bugReportSubmissionFlow';
import type { BugReportComposerSubmissionInput } from '../bugReportSubmissionFlow';

export function useBugReportComposerSubmit(input: Readonly<{
  feature: BugReportsFeature;
  machines: Machine[];
  route: string;
  includeDiagnostics: boolean;
  diagnosticsKinds: string[];
  issueOwner: string;
  issueRepo: string;
  existingIssueNumber: number | null;
  openFallbackIssue: (environment: BugReportComposerSubmissionInput['environment']) => Promise<void>;
  buildDraftInput: (input: Readonly<{
    includeDiagnostics: boolean;
    diagnosticsKinds: string[];
  }>) => BugReportComposerSubmissionInput;
}>): {
  submitting: boolean;
  handleSubmit: () => Promise<void>;
} {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);

  const {
    feature,
    machines,
    route,
    includeDiagnostics,
    diagnosticsKinds,
    issueOwner,
    issueRepo,
    existingIssueNumber,
    openFallbackIssue,
    buildDraftInput,
  } = input;

  const handleSubmit = React.useCallback(async () => {
    if (submitting) return;

    const draftInput = buildDraftInput({
      includeDiagnostics,
      diagnosticsKinds,
    });
    const validation = validateBugReportDraft(draftInput);
    if (validation.code !== 'ok') {
      await Modal.alert(validation.title, validation.message);
      return;
    }

    setSubmitting(true);
    recordBugReportUserAction('bug-report.submit-started', {
      route,
      metadata: {
        includeDiagnostics,
        existingIssueNumber: existingIssueNumber ?? undefined,
        providerEnabled: feature.enabled,
        hasProviderUrl: Boolean(feature.providerUrl),
      },
    });

    try {
      const result = await submitBugReportFromDraft({
        feature,
        machines,
        input: draftInput,
        issueOwner,
        issueRepo,
        existingIssueNumber: existingIssueNumber ?? undefined,
        openFallbackIssue,
        collectDiagnosticsArtifacts: collectBugReportDiagnosticsArtifacts,
        submitBugReport: submitBugReportToService,
      });

      if (result.mode === 'fallback') {
        return;
      }

      const submittedMessage = existingIssueNumber
        ? `A comment has been posted on issue #${result.issueNumber}.\n\nReport ID: ${result.reportId}`
        : `Issue #${result.issueNumber} has been created.\n\nReport ID: ${result.reportId}`;
      await Modal.alert('Bug report submitted', submittedMessage);
      recordBugReportUserAction('bug-report.submit-succeeded', {
        route,
        metadata: {
          issueNumber: result.issueNumber,
          includeDiagnostics,
          existingIssueNumber: existingIssueNumber ?? undefined,
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
        route,
        metadata: {
          includeDiagnostics,
          fallbackOpened: Boolean(fallback),
        },
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    buildDraftInput,
    diagnosticsKinds,
    existingIssueNumber,
    feature,
    includeDiagnostics,
    issueOwner,
    issueRepo,
    machines,
    openFallbackIssue,
    route,
    router,
    submitting,
  ]);

  return {
    submitting,
    handleSubmit,
  };
}
