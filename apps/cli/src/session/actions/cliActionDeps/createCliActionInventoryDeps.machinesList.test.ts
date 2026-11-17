import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';

const http = vi.hoisted(() => ({ get: vi.fn() }));
// HTTP is the boundary; bootstrap parsing, inventory and Action projection stay real.
vi.mock('axios', () => ({ default: { defaults: {}, get: http.get } }));

describe('machines.list installation discovery', () => {
  it.each(['manage', 'use'] as const)('retains the visible %s target identity without disclosing stored content', async role => {
    const access = { custodian: { accountId: 'other-owner', displayName: 'Owner' }, role,
      resourceMode: 'e2ee', accessState: 'key_pending' };
    const deploymentApp = { environmentId: 'collector-environment', deploymentId: 'collector-deployment',
      targetLinkId: 'collector-link', controller: { machineId: 'collector-host', installationId: 'host-installation' } };
    http.get.mockResolvedValue({ status: 200, data: [{ id: 'shared-machine', installationId: 'shared-installation',
      active: true, revokedAt: null, replacedByMachineId: null, access, deploymentApp,
      metadata: 'private-metadata', daemonState: 'private-daemon-state', dataEncryptionKey: 'private-wrapped-key',
      installationPublicKey: 'public-key-not-needed',
    }, { id: 'legacy-machine', active: false, revokedAt: null, replacedByMachineId: null }] });
    const inventory = createCliActionInventoryDeps({ token: 'requester-token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://machines.example.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const result = await executor.execute('machines.list', {}, { surface: 'agent', authority: 'account_automation', serverId: 'home' });
    expect(result).toMatchObject({ ok: true, result: { items: [
      { serverId: 'home', machineId: 'shared-machine', installationId: 'shared-installation', access, deploymentApp },
      { machineId: 'legacy-machine', installationId: null },
    ] } });
    expect(JSON.stringify(result)).not.toMatch(/private-|public-key-not-needed|requester-token/);
  });
});


it('lists machines with the admitted PAT proof instead of the daemon Account bearer', async () => {
  const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
  const target = { kind: 'machine' as const, machineId: 'daemon-machine' };
  const authorization = await projectExternalActionRequesterHttpAuthorization({
    authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'machine-list-root', binding: {
      accountId: 'owner', principalId: 'owner', custodianAccountId: 'owner',
      credentialId: '22222222-2222-4222-8222-222222222222', grant: API_TOKEN_FULL_GRANT_V1,
      accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: target.machineId,
      installationId: 'installation', actionId: 'machines.list', requestId: 'machine-list-request',
      requestEnvelopeDigest: 'a'.repeat(43), target,
    } }), serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://machines.example.test',
    target, installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true,
  });
  expect(authorization).not.toBeNull();
  http.get.mockImplementation(async (_url, options) => {
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('machine-list-root');
    return { status: 200, data: [{ id: 'visible-machine', active: true, revokedAt: null, replacedByMachineId: null }] };
  });
  const inventory = createCliActionInventoryDeps({ token: 'daemon-account-token', sessionId: '', mode: 'plain', ctx: null,
    serverId: 'home', serverHttpBaseUrl: 'https://machines.example.test' });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
  const result = await executor.execute('machines.list', {}, { surface: 'mcp', authority: 'account_automation', serverId: 'home',
    externalActionTarget: target, ...(authorization ? { externalActionExecutionAuthorization: authorization } : {}) });
  expect(result).toMatchObject({ ok: true, result: { items: [{ machineId: 'visible-machine' }] } });
});
