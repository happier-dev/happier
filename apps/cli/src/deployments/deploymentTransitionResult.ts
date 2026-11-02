import type { DeploymentReceiptResultV1 } from '@happier-dev/protocol';
import { readUnexpectedActionErrorDiagnosticV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Native continuations already have a receipt; pending admission is not a transition ACK. */
export type DeploymentTransitionResultForHost =
    Extract<DeploymentReceiptResultV1, { ok: true; deploymentId: string }> | ActionExecuteFailure;

/** Keep issued-write ambiguity while retaining only the protocol owner's safe diagnostic vocabulary. */
export function projectDeploymentTransitionOutcomeUnknownForHost(error: unknown): ActionExecuteFailure {
    const reason = readUnexpectedActionErrorDiagnosticV1(error).errorCode;
    return { ok: false, errorCode: 'outcome_unknown',
        error: reason ? `Deployment transition outcome is unknown (${reason}).` : 'outcome_unknown' };
}

/** The transition boundary owns the domain-to-Action failure projection, including quota facts. */
export function projectDeploymentTransitionResultForHost(
    result: DeploymentReceiptResultV1,
): DeploymentTransitionResultForHost | null {
    if (!result.ok) return { ok: false, errorCode: result.error, error: result.error, details: result };
    return 'deploymentId' in result ? result : null;
}
