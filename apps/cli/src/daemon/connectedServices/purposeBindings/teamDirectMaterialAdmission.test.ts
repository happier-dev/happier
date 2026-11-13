import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTeamCredentialSourceMemberKeyV1, createTeamCredentialDirectMaterialStoredV1 } from '@happier-dev/protocol/teams';
import { createHttpTeamCredentialDirectMaterialClient } from '../directMaterial/teamCredentialDirectMaterialClient';
import { admitTeamDirectActionMaterialOrigins } from './teamDirectMaterialAdmission';

vi.mock('axios', () => ({ default: { defaults: {}, post: vi.fn() } }));

const purpose = { consumer: { pluginId: 'plugin.cloud', localId: 'cloud' }, purpose: 'api' };
const sourceMember = { kind: 'connected_account' as const, service: { pluginId: 'plugin.cloud', localId: 'service' }, connectedAccountId: 'custodian-account' };
const payload = { v: 1 as const, domain: 'happier.team-credential-direct-material' as const,
  homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 1,
  recipientAccountId: 'requester', sourceMember, sourceVersion: 'source-v1',
  material: { kind: 'qualified_connected_account' as const, credential: { v: 1 as const, values: { token: 'shared-token' } },
    configuration: null, authenticationModeId: 'token' } };

describe('finite Action Team direct admission', () => {
  beforeEach(() => vi.mocked(axios.post).mockReset());
  it('retains requester material for admitted work and applies withdrawal at the next admission', async () => {
    // Axios is Home's HTTP boundary; the strict wire reader and recipient opener stay real.
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: { status: 'ready', recipientMode: 'plain',
      stored: createTeamCredentialDirectMaterialStoredV1({ payload, recipientMode: 'plain' }),
      expected: { homeServerIdentityId: payload.homeServerIdentityId, teamId: payload.teamId,
        resourceId: payload.resourceId, resourceRevision: payload.resourceRevision,
        recipientAccountId: payload.recipientAccountId, sourceVersion: payload.sourceVersion,
        sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(sourceMember) },
    } }).mockResolvedValue({ status: 200, data: { status: 'unavailable', reason: 'access_removed' } });
    const client = createHttpTeamCredentialDirectMaterialClient({ token: 'requester-token', teamId: 'team',
      readRecipientEncryptionMaterial: async () => ({ mode: 'plain' }),
      resolvePlatformOperationRequestHeaders: async () => null });
    const input = { subject: { kind: 'action_operation' as const, operationId: 'root-request', actionId: 'plugin.cloud/actions/acquire',
      pluginVersion: '1.0.0', consumer: purpose.consumer, isCurrent: () => true },
      origins: [{ teamId: 'team', resourceId: 'resource', purpose,
        disclosedMember: { service: sourceMember.service, accountId: sourceMember.connectedAccountId } }],
      openTeamDirect: client.open, resolveRequestHeaders: async () => ({ Authorization: 'Bearer signed-root' }),
      signal: new AbortController().signal };
    const admitted = await admitTeamDirectActionMaterialOrigins(input);
    expect(admitted[0]?.admittedActionMaterial?.payload).toEqual(payload);
    expect(axios.post).toHaveBeenCalledTimes(1);
    await expect(admitTeamDirectActionMaterialOrigins(input)).rejects.toMatchObject({ code: 'plugin_connected_account_direct_access_removed' });
    expect(admitted[0]?.admittedActionMaterial?.payload.material).toMatchObject({
      kind: 'qualified_connected_account', credential: { values: { token: 'shared-token' } } });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
