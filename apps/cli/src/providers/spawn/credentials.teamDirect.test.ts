import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { TeamCredentialDirectMaterialPayloadV1Schema } from '@happier-dev/protocol/teams';

import { resolveProviderCredentialPlaintextAsync } from './credentials';

describe('Provider credential team-direct materialization', () => {
  it.each([
    ['preparing', 'provider_endpoint_unavailable', true, 'retry'],
    ['temporarily_unavailable', 'provider_endpoint_unavailable', true, 'retry'],
    ['source_changed', 'provider_authorization_changed', true, 'retry'],
    ['recipient_binding_changed', 'provider_authorization_changed', true, 'retry'],
    ['access_removed', 'provider_account_grant_stale', false, 'review_account_grant'],
    ['disabled', 'provider_connection_disabled', false, 'enable_connection'],
    ['unsupported_direct_source', 'provider_credential_transport_unavailable', false, 'review_credential_transport'],
    ['invalid_material', 'provider_materialization_failed', false, 'review_connection'],
    ['resource_corrupt', 'provider_materialization_failed', false, 'review_connection'],
  ] as const)(
    'preserves Team direct failure %s as %s',
    async (reason, code, retryable, action) => {
      await expect(resolveProviderCredentialPlaintextAsync({
        reference: {
          kind: 'team_direct',
          teamId: 'team-1',
          resourceId: 'resource-1',
          expectedResourceRevision: 3,
          sourceMemberKey: 'provider:source-member',
          sourceVersion: 'source-version:7',
        },
        accountSettings: {},
        settingsSecretsReadKeys: [],
        connectionId: 'resource-1',
        machineId: 'machine-a',
        openTeamDirect: async () => ({ ok: false, reason }),
      })).resolves.toMatchObject({
        ok: false,
        error: { code, retryable, action },
      });
    },
  );

  it('normalizes the canonical direct client payload into ProviderResolvedCredential', async () => {
    const openTeamDirect = vi.fn(async () => ({
      ok: true as const,
      payload: TeamCredentialDirectMaterialPayloadV1Schema.parse({
        v: 1 as const, domain: 'happier.team-credential-direct-material' as const,
        homeServerIdentityId: 'home-1', teamId: 'team-1', resourceId: 'resource-1', resourceRevision: 7,
        recipientAccountId: 'recipient-1',
        sourceMember: {
          kind: 'provider_credential_slot' as const,
          connectionId: ProviderConnectionIdSchema.parse('connection-1'),
          credentialSlotId: 'apiKey',
        },
        sourceVersion: 'version-1',
        material: {
          kind: 'provider_api_key' as const, value: 'team-secret',
          runtimeBinding: {
            provider: { identity: { pluginId: 'provider.test', localId: 'test' }, definitionRevision: 1 },
            endpoint: {
              endpointTemplateId: 'responses', normalizedUrl: 'https://api.example.test/v1',
              protocol: 'openai-responses' as const, publicHeaders: {},
            },
            credentialTransport: {
              id: 'api-key', protocols: ['openai-responses' as const], uses: ['runtime' as const],
              destination: { kind: 'httpHeader' as const, name: 'Authorization', format: 'bearer' as const },
            },
          },
        },
      }),
    } as const));
    await expect(resolveProviderCredentialPlaintextAsync({
      reference: {
        kind: 'team_direct',
        teamId: 'team-1',
        resourceId: 'resource-1',
        expectedResourceRevision: 7,
        sourceMemberKey: 'member-1',
        sourceVersion: 'version-1',
      },
      accountSettings: {},
      settingsSecretsReadKeys: [],
      connectionId: 'connection-1',
      machineId: 'machine-1',
      openTeamDirect,
    })).resolves.toEqual({
      ok: true,
      credential: { kind: 'apiKey', value: 'team-secret' },
    });
    expect(openTeamDirect).toHaveBeenCalledWith({
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      sourceMemberKey: 'member-1',
      expectedSourceVersion: 'version-1',
    });
  });

  it('preserves Team authentication operation errors through Provider materialization', async () => {
    await expect(resolveProviderCredentialPlaintextAsync({
      reference: {
        kind: 'team_direct', teamId: 'team-1', resourceId: 'resource-1',
        expectedResourceRevision: 7, sourceMemberKey: 'member-1', sourceVersion: 'version-1',
      },
      accountSettings: {}, settingsSecretsReadKeys: [], connectionId: 'connection-1', machineId: 'machine-1',
      openTeamDirect: vi.fn(async () => ({
        ok: false as const,
        operationError: { error: 'team_authentication_required' as const },
      })),
    })).rejects.toMatchObject({ code: 'team_authentication_required' });
  });
});
