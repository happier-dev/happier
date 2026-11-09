import { BugReportSubmitInputSchema } from '@happier-dev/protocol/actions/specs/bugReport';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { DEFAULT_BUG_REPORTS_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/bugReportsCapabilities';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';
import { collectBugReportDiagnosticsArtifacts } from '@/components/settings/bugReports/bugReportDiagnostics';
import { submitBugReportFromDraft, validateBugReportDraft } from '@/components/settings/bugReports/bugReportSubmissionFlow';
import { submitBugReportToService } from '@/components/settings/bugReports/bugReportServiceClient';
import { openBugReportFallbackFromDraft } from '@/components/settings/bugReports/bugReportFallbackSubmission';
import type { LazyActionAccountContext } from './actionAccountContext';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

export function createBugReportSubmitAction(account: LazyActionAccountContext | null): NonNullable<ActionExecutorDeps['bugReportSubmit']> {
  return async (raw, context) => {
    if (!account) return { ok: false, errorCode: 'action_account_scope_unavailable', error: 'action_account_scope_unavailable' };
    account.assertCurrent();
    context.signal?.throwIfAborted();
    const input = BugReportSubmitInputSchema.parse(raw);
    const validation = validateBugReportDraft(input.draft);
    if (validation.code !== 'ok') return { ok: false, errorCode: 'bug_report_draft_invalid', error: validation.message,
      details: { field: validation.code } };

    const snapshot = await getServerFeaturesSnapshot({ serverId: account.serverId });
    const features = snapshot.status === 'ready' ? snapshot.features : null;
    const settings = await account.readSettings();
    account.assertCurrent();
    context.signal?.throwIfAborted();
    const capabilities = features?.capabilities.bugReports ?? DEFAULT_BUG_REPORTS_CAPABILITIES;
    const feature = { ...capabilities, enabled: resolveRuntimeFeatureDecisionFromSnapshot({
      featureId: 'bugReports', settings, snapshot, scope: { scopeKind: 'spawn', serverId: account.serverId },
    })?.state === 'enabled' };
    const providerUrl = feature.enabled ? feature.providerUrl : null;
    if (providerUrl !== input.destination.providerUrl) {
      return { ok: false, errorCode: 'bug_report_destination_changed', error: 'bug_report_destination_changed' };
    }
    // Legacy callers without a prepared selection still collect from the focused Home.
    // Prepared form diagnostics already retain their explicit target and exclusions.
    if (input.draft.includeDiagnostics && !input.preparedDiagnostics && !areServerProfileIdentifiersEquivalent(account.serverId, getActiveServerSnapshot().serverId)) {
      return { ok: false, errorCode: 'bug_report_diagnostics_scope_unavailable', error: 'bug_report_diagnostics_scope_unavailable' };
    }
    const inventory = storage.getState().machineListByServerId;
    const keys = resolveServerScopedMachineInventoryKeys({ serverId: account.serverId, machineListByServerId: inventory });
    const machines = keys.map(key => inventory[key]).find(list => list !== null && list !== undefined) ?? [];
    try {
      return await submitBugReportFromDraft({
        // Admission already applied the user's approval policy to this exact
        // diagnostic submission. Preserve the report service's consent shape
        // without imposing a second checkbox confirmation after approval/waiver.
        feature, machines, input: input.draft.includeDiagnostics
          ? { ...input.draft, acceptedPrivacyNotice: true } : input.draft,
        issueOwner: input.destination.issueOwner, issueRepo: input.destination.issueRepo,
        existingIssueNumber: input.destination.existingIssueNumber,
        openFallbackIssue: async environment => {
          account.assertCurrent();
          context.signal?.throwIfAborted();
          await openBugReportFallbackFromDraft({ ...input.draft, environment }, async value => {
            // This port is part of the admitted bugreport.submit operation; the
            // fallback button must retain its original Account and cancellation.
            try {
              account.assertCurrent();
              if (context.signal?.aborted) return false;
              return await setClipboardStringSafe(value);
            } catch { return false; }
          });
        },
        collectDiagnosticsArtifacts: async args => {
          account.assertCurrent();
          context.signal?.throwIfAborted();
          return input.preparedDiagnostics ?? await collectBugReportDiagnosticsArtifacts({ ...args, pastedCliDoctorSnapshotJson: input.pastedCliDoctorSnapshotJson });
        },
        submitBugReport: async args => {
          account.assertCurrent();
          context.signal?.throwIfAborted();
          return await submitBugReportToService(args);
        },
      });
    } catch (error) {
      account.assertCurrent();
      context.signal?.throwIfAborted();
      return { ok: false, errorCode: 'bug_report_submission_failed', error: error instanceof Error ? error.message : 'bug_report_submission_failed' };
    }
  };
}
