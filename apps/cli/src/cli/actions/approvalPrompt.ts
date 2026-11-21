import { stripVTControlCharacters } from 'node:util';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentApprovalReviewV1Schema, type DeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { CliApprovalRequestedHandler } from '@/session/actions/approvals/deferredResult';
import type { SessionControlJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';

function versionLabel(revision: DeploymentReviewRevisionV1): string {
  return revision.kind === 'repository' ? revision.sha.slice(0, 7) : `stored revision ${revision.contentRevision}`;
}

function describeRollbackReview(preview: unknown): string | undefined {
  const parsed = DeploymentApprovalReviewV1Schema.safeParse(readRecord(preview).deploymentReview);
  if (!parsed.success) return;
  const review = 'platformRollback' in parsed.data ? parsed.data.platformRollback
    : 'deployment' in parsed.data ? parsed.data.deployment : parsed.data;
  const data = 'platformName' in review ? review.data : review.rollbackData;
  if (!review.environment || !review.revision || review.replaces === undefined || !data) return;
  const target = 'platformName' in review
    ? [review.platformName, review.providerResourceId, review.providerEnvironment].join(' · ')
    : review.runtimeMachines?.map(machine => machine.machineId).join(', ') || review.machineId;
  if (!target) return;
  const terminalText = (value: string) => stripVTControlCharacters(value).replace(/\p{Cc}/gu, ' ');
  return [
    `Roll back ${terminalText(review.environment.name)} to ${versionLabel(review.revision)}`,
    review.replaces ? `Replaces ${versionLabel(review.replaces.revision)}` : 'No serving version to replace',
    `Target ${terminalText(target)}`,
    data === 'restoreBackup' ? 'Replace current data with the selected backup' : 'Keep current data',
    '',
    'Approve this Action?',
  ].join('\n');
}

/** Both CLI entry points present Ask while the originating call retains custody. */
export function createCliActionApprovalPresenter(options: Readonly<{
  actionId: string;
  json: boolean;
  envelopeKind: string;
  approve?: boolean;
}>): CliApprovalRequestedHandler {
  return async (artifactId, signal, decide, readPreview) => {
    if (options.json) console.error(JSON.stringify({ v: 1, ok: true, kind: options.envelopeKind,
      data: { kind: 'approval_request_created', artifactId, actionId: options.actionId },
    } satisfies SessionControlJsonEnvelope));
    else console.error(`Awaiting approval ${artifactId} — approve in the app`);
    let approve = options.approve === true;
    if (!approve) {
      // Only a person at this terminal decides here. Without one, or when the
      // prompt fails, the request stays open for another surface to decide.
      if (!isInteractiveTerminal()) return;
      try {
        const prompt = options.actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1
          ? describeRollbackReview(await readPreview?.()) : 'Approve this Action?';
        if (!prompt) return;
        approve = await promptConfirmYesNo(prompt, { default: 'no', signal });
      } catch (error) {
        if (signal.aborted) throw error;
        // Terminal Ctrl+C retires this wait without deciding the durable Ask.
        if (error instanceof Error && error.name === 'AbortError') {
          return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        }
        return;
      }
    }
    const decision = await decide(approve ? 'approve' : 'reject');
    return !approve && decision.ok
      ? { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' } : decision;
  };
}
