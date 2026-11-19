import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Modal } from '@/modal';
import { BugReportSubmitOutputSchema } from '@happier-dev/protocol/actions/specs/bugReport';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { clearBugReportUserActionTrail, recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { clearBugReportLogBuffer } from '@/utils/system/bugReportLogBuffer';
import { clearPreRestartBugReportSnapshot } from '@/utils/system/preRestartBugReportSnapshot';

import type { collectBugReportDiagnosticsArtifacts, BugReportSessionTarget } from '../bugReportDiagnostics';
import { bugReportErrorMessage, isBugReportDiagnosticsSuperseded } from '../bugReportErrorMessage';
import type { BugReportsFeature } from '../bugReportFeatureDefaults';
import { openBugReportIssueUrlSilently } from '../openBugReportFallback';
import { validateBugReportDraft } from '../bugReportSubmissionFlow';
import type { BugReportComposerSubmissionInput } from '../bugReportSubmissionFlow';

export function useBugReportComposerSubmit(input: Readonly<{
  feature: BugReportsFeature;
  route: string;
  includeDiagnostics: boolean;
  diagnosticsKinds: string[];
  issueOwner: string;
  issueRepo: string;
  existingIssueNumber: number | null;
  openFallbackIssue: (environment: BugReportComposerSubmissionInput['environment']) => Promise<void>;
  pastedCliDoctorSnapshotJson?: string;
  sessionTarget?: BugReportSessionTarget | null;
  reportServerId?: string;
  collectDiagnosticsArtifacts?: () => Promise<Pick<Awaited<ReturnType<typeof collectBugReportDiagnosticsArtifacts>>, 'artifacts' | 'environment'>>;
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
  const execute = React.useMemo(() => createFrontDoorActionExecute(), []);

  const {
    feature,
    route,
    includeDiagnostics,
    diagnosticsKinds,
    issueOwner,
    issueRepo,
    existingIssueNumber,
    openFallbackIssue,
    pastedCliDoctorSnapshotJson,
    sessionTarget, reportServerId, collectDiagnosticsArtifacts,
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
      const preparedDiagnostics = includeDiagnostics && feature.enabled && feature.providerUrl && collectDiagnosticsArtifacts
        ? await collectDiagnosticsArtifacts() : undefined;
      const executed = await execute('bugreport.submit', {
        draft: draftInput,
        destination: { providerUrl: feature.enabled ? feature.providerUrl : null, issueOwner, issueRepo,
          ...(existingIssueNumber === null ? {} : { existingIssueNumber }) },
        ...(pastedCliDoctorSnapshotJson ? { pastedCliDoctorSnapshotJson } : {}),
        ...(preparedDiagnostics ? { preparedDiagnostics: { artifacts: preparedDiagnostics.artifacts, environment: preparedDiagnostics.environment } } : {}),
      }, { surface: 'ui', serverId: reportServerId,
        ...(sessionTarget?.accountId ? { expectedAccountId: sessionTarget.accountId } : {}),
      });
      if (!executed.ok) {
        // A refusal is not a service failure and must not offer a fallback
        // that could send the same report after its approval was declined.
        if (executed.errorCode !== 'bug_report_submission_failed') {
          await Modal.alert(
            t('bugReports.composer.alerts.submitFailedTitle'),
            bugReportErrorMessage(executed, t('bugReports.composer.alerts.submitFailedFallbackMessage')),
          );
          return;
        }
        throw new Error(executed.error);
      }
      if (ActionApprovalRequestCreatedResultSchema.safeParse(executed.result).success) return;
      const result = BugReportSubmitOutputSchema.parse(executed.result);

      if (result.mode === 'fallback') {
        return;
      }

      const submittedMessage = existingIssueNumber
        ? t('bugReports.composer.alerts.submittedExistingIssueBody', { issueNumber: result.issueNumber, reportId: result.reportId })
        : t('bugReports.composer.alerts.submittedNewIssueBody', { issueNumber: result.issueNumber, reportId: result.reportId });
      await Modal.alert(t('bugReports.composer.alerts.submittedTitle'), submittedMessage);
      recordBugReportUserAction('bug-report.submit-succeeded', {
        route,
        metadata: {
          issueNumber: result.issueNumber,
          includeDiagnostics,
          existingIssueNumber: existingIssueNumber ?? undefined,
        },
      });

      // Best-effort only: avoid stacking extra modals over the success state if opening fails.
      void openBugReportIssueUrlSilently(result.issueUrl);
      clearBugReportUserActionTrail();
      clearBugReportLogBuffer();
      void clearPreRestartBugReportSnapshot();
      router.back();
    } catch (error) {
      if (isBugReportDiagnosticsSuperseded(error)) return;
      if (error instanceof Error && (error.message === 'bug_report_diagnostics_scope_changed' || error.message === 'action_account_scope_changed')) {
        await Modal.alert(t('bugReports.composer.alerts.submitFailedTitle'), bugReportErrorMessage(error, t('bugReports.composer.scopeChanged')));
        return;
      }
      const baseMessage = bugReportErrorMessage(error, t('bugReports.composer.alerts.submitFailedFallbackMessage'));
      const fallback = await Modal.confirm(
        t('bugReports.composer.alerts.submitFailedTitle'),
        t('bugReports.composer.alerts.submitFailedBody', { message: baseMessage }),
        {
          confirmText: t('bugReports.composer.alerts.openFallbackIssueButton'),
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
    openFallbackIssue,
    route,
    router,
    submitting,
    pastedCliDoctorSnapshotJson,
    sessionTarget, reportServerId, collectDiagnosticsArtifacts,
    execute,
  ]);

  return {
    submitting,
    handleSubmit,
  };
}
