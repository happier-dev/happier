import type { CliApprovalRequestedHandler } from '@/session/actions/approvals/deferredResult';
import type { SessionControlJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';

/** Both CLI entry points present Ask while the originating call retains custody. */
export function createCliActionApprovalPresenter(options: Readonly<{
  actionId: string;
  json: boolean;
  envelopeKind: string;
  approve?: boolean;
}>): CliApprovalRequestedHandler {
  return async (artifactId, signal, decide) => {
    if (options.json) console.error(JSON.stringify({ v: 1, ok: true, kind: options.envelopeKind,
      data: { kind: 'approval_request_created', artifactId, actionId: options.actionId },
    } satisfies SessionControlJsonEnvelope));
    else console.error(`Waiting for approval: ${artifactId}`);
    let approve = options.approve === true;
    if (!approve) {
      try {
        approve = await promptConfirmYesNo('Approve this Action?', { default: 'no', signal });
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    const decision = await decide(approve ? 'approve' : 'reject');
    return !approve && decision.ok
      ? { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' } : decision;
  };
}
