import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';

/** Facts come from the already admitted source/receipt, never another storage read. */
export function resolveEnvironmentDeploymentFactForHost(
    fact: Extract<Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>['source'], { kind: 'deploymentFact' }>['fact'],
    facts: Readonly<Record<typeof fact, string | undefined>>,
): string {
    const value = facts[fact];
    if (value === undefined) throw createActionExecuteFailureError({ ok: false, errorCode: 'reference_unavailable', error: 'reference_unavailable' });
    return value;
}
