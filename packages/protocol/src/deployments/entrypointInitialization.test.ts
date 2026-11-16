import { describe, expect, it, vi } from 'vitest';

describe('deployment protocol initialization', () => {
  it.each(['domain-first', 'receipt-first', 'actions-first'])('loads and consumes Domain, scope and header %s', async (order) => {
    vi.resetModules();
    if (order === 'domain-first') await import('./deploymentDomainProviderResultV1.js');
    else if (order === 'receipt-first') await import('./deploymentReceiptEventsV1.js');
    else await import('./deploymentActionsV1.js');
    const { DeploymentTargetDomainResultV1Schema, DeploymentTargetDomainResultV1ProtocolSchema } =
      await import('../plugins/contributions/deploymentTargetRolesV1.js');
    const value = { v: 1, hostname: 'example.test', state: 'active', dns: [] };
    expect(DeploymentTargetDomainResultV1Schema.parse(value)).toEqual(value);
    expect(DeploymentTargetDomainResultV1ProtocolSchema.safeParse(value).success).toBe(true);
    expect(DeploymentTargetDomainResultV1ProtocolSchema.safeParse({ ...value, state: 'invalid' }).success).toBe(false);
    const { DeploymentTargetScopeV1Schema, DeploymentEnvironmentHeaderV1Schema } = await import('./deploymentActionsV1.js');
    const scope = { kind: 'account', accountId: 'account-1' };
    expect(DeploymentTargetScopeV1Schema.parse(scope)).toEqual(scope);
    // Consuming the header must return a validation result, even for missing fields.
    expect(DeploymentEnvironmentHeaderV1Schema.safeParse({}).success).toBe(false);
  });
});
