import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol';

import type { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';

type PiTurnFailureInput = Parameters<NonNullable<NonNullable<Parameters<typeof createAcpRuntime>[0]['hooks']>['onTurnFailure']>>[0];

/** Terminal reports consume the exact issue accepted by the host turn lifecycle. */
export async function reportPiTurnFailure(input: PiTurnFailureInput): Promise<void> {
  if (!input.sessionId || !input.issue) return;
  const error = input.error && typeof input.error === 'object' && !Array.isArray(input.error)
    ? input.error as Record<string, unknown>
    : null;
  const parsed = sanitizeConnectedServiceRuntimeFailureClassification(error?.runtimeAuthClassification);
  if (!parsed) return;
  const classification = {
    ...parsed,
    runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(input.issue),
  };
  const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
    sessionId: input.sessionId,
    switchesThisTurn: 0,
    classification,
    logPrefix: '[pi]',
  });
  projectConnectedServiceRuntimeAuthRecoveryReport({
    report,
    classification,
    sendGenericStatusMessage: (message) => {
      if (!input.session.sendSessionEvent) return false;
      input.session.sendSessionEvent({ type: 'message', message });
      return true;
    },
  });
}
