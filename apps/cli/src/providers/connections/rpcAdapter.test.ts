import { describe, expect, it, vi } from 'vitest';
import { DaemonProviderConnectionMutationRequestV1Schema } from '@happier-dev/protocol/rpc';

import { createProviderConnectionRpcAdapter } from './rpcAdapter';

describe('createProviderConnectionRpcAdapter', () => {
  it('dispatches the strict mutation union and preserves the action discriminator', async () => {
    const connection = {
      connectionId: 'pc_a', contributionKey: 'acme/a', displayName: 'A', providerName: 'A',
      icon: null,
      role: 'default' as const, displayNameMode: 'automatic' as const, sourceStatus: 'available' as const,
      grants: { accountEnabled: false, enabledMachineIds: [] },
      credential: null,
      endpoints: [],
      scope: null, authorized: false, authorizationError: null, revision: 0,
      runtime: { health: 'not_checked' as const, modelCount: null, checkedAt: null },
      probeCapability: 'none' as const,
      manualModelPolicy: 'allowed' as const,
      compatibility: [],
    };
    const service = {
      describe: vi.fn(async () => ({
        status: 'success' as const, connections: [], available: [], availableTruncated: false,
        diagnostics: [], diagnosticsTruncated: false,
      })),
      create: vi.fn(async () => ({ status: 'success' as const, connection, created: true })),
      update: vi.fn(), duplicate: vi.fn(), setEnabled: vi.fn(), bindSecret: vi.fn(), delete: vi.fn(),
    };
    const adapter = createProviderConnectionRpcAdapter(service as never);
    await expect(adapter.mutateConnection(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_a',
      contributionKey: 'acme/a', displayName: null, savedSecretId: null, enable: false,
      authoringReview: {
        candidateId: null,
        fingerprint: 'authoring-review:v1:reviewed',
        revision: 0,
      },
    }))).resolves.toMatchObject({ status: 'success', action: 'createContribution', connection: { connectionId: 'pc_a' } });
    expect(service.create).toHaveBeenCalledTimes(1);
  });
});
