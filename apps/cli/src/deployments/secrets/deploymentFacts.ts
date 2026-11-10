import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';

/** Facts come from the already admitted source/receipt, never another storage read. */
export function resolveEnvironmentDeploymentFactForHost(
    fact: Extract<Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>['source'], { kind: 'deploymentFact' }>['fact'],
    facts: Readonly<Record<typeof fact, string | undefined>>,
): string {
    const value = facts[fact];
    if (value === undefined) throw Object.assign(new Error('reference_unavailable'), { code: 'reference_unavailable' });
    return value;
}
