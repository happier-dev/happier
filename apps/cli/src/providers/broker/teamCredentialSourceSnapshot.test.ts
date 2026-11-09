import { describe, expect, it, vi } from 'vitest';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';

import {
  createConnectedAccountTeamCredentialSourceSnapshot,
  createConnectedPoolMemberTeamCredentialSourceSnapshot,
  createProviderConnectionTeamCredentialSourceSnapshot,
} from './teamCredentialSourceSnapshot';
import type { ProviderConnectionBrokerSourceSnapshot } from './providerConnectionSource';

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'service' });
const account = Object.freeze({ service, accountId: 'account-1' });
const material = Object.freeze({
  credential: Object.freeze({ v: 1 as const, values: Object.freeze({ token: 'secret' }) }),
  configuration: null,
  authenticationModeId: 'manual-token',
  credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
  configurationRevision: 'configuration-4',
  contributionContractVersion: 'contribution-generation-8',
  isCurrent: vi.fn(async () => true),
});
const parsedAccountSource = TeamCredentialSourceBindingV1Schema.parse({
  v: 1 as const,
  kind: 'connected_account' as const,
  target: Object.freeze({ kind: 'account' as const, account }),
  credentialIncarnation: 'credential-incarnation-2',
});
if (parsedAccountSource.kind !== 'connected_account') throw new Error('expected account source');
const accountSource = parsedAccountSource;

describe('Team credential source snapshots', () => {
  it('binds an exact manual Connected Account incarnation and every material/contribution revision', async () => {
    const persisted = vi.fn(async () => true);
    const snapshot = createConnectedAccountTeamCredentialSourceSnapshot({
      source: accountSource,
      material,
      authenticationKind: 'manual',
      isPersistedSourceCurrent: persisted,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      currentness: {
        sourceMember: { kind: 'connected_account', connectedAccountId: 'account-1' },
      },
      material: { kind: 'qualified_connected_account' },
    });
    await expect(snapshot!.currentness.isCurrent()).resolves.toBe(true);
    expect(persisted).toHaveBeenCalledWith(accountSource);

    const changed = createConnectedAccountTeamCredentialSourceSnapshot({
      source: accountSource,
      material: { ...material, configurationRevision: 'configuration-5' },
      authenticationKind: 'manual',
      isPersistedSourceCurrent: persisted,
    });
    expect(changed?.currentness.sourceVersion).not.toBe(snapshot?.currentness.sourceVersion);
  });

  it('does not reuse direct material after a Saved Secret held key record rotates', () => {
    const snapshot = (credentialSecretFingerprint?: string) => createConnectedAccountTeamCredentialSourceSnapshot({
      source: accountSource,
      material: { ...material, ...(credentialSecretFingerprint ? { credentialSecretFingerprint } : {}) },
      authenticationKind: 'manual',
      isPersistedSourceCurrent: async () => true,
    });
    expect(snapshot('key-record-rotated')?.currentness.sourceVersion).not.toBe(snapshot('key-record-first')?.currentness.sourceVersion);
    expect(snapshot('key-record-first')?.currentness.sourceVersion).not.toBe(snapshot()?.currentness.sourceVersion);
    expect(snapshot('key-record-first')?.currentness.sourceVersion).toBe(snapshot('key-record-first')?.currentness.sourceVersion);
  });

  it('rejects auto-refreshing Connected Accounts from direct source snapshots', () => {
    expect(createConnectedAccountTeamCredentialSourceSnapshot({
      source: accountSource,
      material,
      authenticationKind: 'oauth',
      isPersistedSourceCurrent: async () => true,
    })).toBeNull();
  });

  it('does not reuse direct material when only private service configuration currentness changes', () => {
    const snapshot = (serviceConfigurationFingerprint: string) => createConnectedAccountTeamCredentialSourceSnapshot({
      source: accountSource,
      material: { ...material, configurationRevision: null, serviceConfigurationFingerprint },
      authenticationKind: 'manual',
      isPersistedSourceCurrent: async () => true,
    });
    expect(snapshot('service-configuration-2')?.currentness.sourceVersion)
      .not.toBe(snapshot('service-configuration-1')?.currentness.sourceVersion);
    expect(snapshot('service-configuration-1')?.currentness.sourceVersion)
      .toBe(snapshot('service-configuration-1')?.currentness.sourceVersion);
  });

  it('binds Pool incarnation and enabled state without granting selection mutation', async () => {
    const parsedPoolSource = TeamCredentialSourceBindingV1Schema.parse({
      v: 1 as const,
      kind: 'connected_pool' as const,
      target: Object.freeze({ kind: 'group' as const, service, groupId: 'pool-1' }),
      poolIncarnation: 'pool-incarnation-7',
    });
    if (parsedPoolSource.kind !== 'connected_pool') throw new Error('expected pool source');
    const poolSource = parsedPoolSource;
    const snapshot = createConnectedPoolMemberTeamCredentialSourceSnapshot({
      source: poolSource,
      sourceAccount: account,
      sourceCredentialIncarnation: 'credential-incarnation-2',
      memberEnabled: true,
      material,
      authenticationKind: 'manual',
      isPersistedSourceCurrent: async () => true,
    });
    const disabled = createConnectedPoolMemberTeamCredentialSourceSnapshot({
      source: poolSource,
      sourceAccount: account,
      sourceCredentialIncarnation: 'credential-incarnation-2',
      memberEnabled: false,
      material,
      authenticationKind: 'manual',
      isPersistedSourceCurrent: async () => true,
    });
    expect(snapshot?.currentness.sourceVersion).not.toBe(disabled?.currentness.sourceVersion);
    await expect(disabled?.currentness.isCurrent()).resolves.toBe(false);
    expect(snapshot?.currentness).not.toHaveProperty('select');
    expect(snapshot?.currentness).not.toHaveProperty('reportFailure');
  });

  it('binds Provider registry, contribution, endpoint/grant and Saved Secret facts while exposing only material', async () => {
    const parsedSource = TeamCredentialSourceBindingV1Schema.parse({
      v: 1 as const,
      kind: 'provider_connection' as const,
      connectionId: 'pc_source',
      connectionSecurityFingerprint: 'connection-security:v1:source',
      credentialSlotId: 'apiKey',
    });
    if (parsedSource.kind !== 'provider_connection') throw new Error('expected Provider source');
    const source = parsedSource;
    const expected = {
      source,
      machineId: 'machine-1',
      provider: Object.freeze({
        identity: Object.freeze({ pluginId: 'acme.gateway', localId: 'gateway' }),
        definitionRevision: 1,
      }),
      connectionRevision: 3,
      endpointSetFingerprint: 'endpoint-set:v1:one',
      grantFingerprint: 'grant:v1:one',
      activationOccurrenceId: 'gateway-occurrence-9',
      endpoint: Object.freeze({
        endpointTemplateId: 'responses', normalizedUrl: 'https://example.test/v1',
        protocol: 'openai-responses' as const,
        publicHeaders: Object.freeze({}),
        resolvedAddresses: Object.freeze(['203.0.113.10']),
      }),
      credentialRef: Object.freeze({
        connectionId: source.connectionId,
        machineId: 'machine-1',
        protocol: 'openai-responses' as const,
        transport: Object.freeze({
          id: 'bearer', protocols: ['openai-responses' as const], uses: ['runtime' as const],
          destination: Object.freeze({ kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const }),
        }),
        reference: Object.freeze({ kind: 'apiKey' as const, secretId: 'secret-1', secretRecordFingerprint: 'secret:v1:one' }),
      }),
    } satisfies ProviderConnectionBrokerSourceSnapshot;
    const snapshot = createProviderConnectionTeamCredentialSourceSnapshot({
      sourceAccountId: 'owner-account',
      expected,
      resolvedCredential: { kind: 'apiKey', value: 'provider-secret' },
      isPersistedSourceCurrent: async () => true,
      isProviderSourceCurrent: async () => true,
    });
    expect(snapshot).toMatchObject({
      currentness: {
        sourceMember: { kind: 'provider_credential_slot', connectionId: 'pc_source', credentialSlotId: 'apiKey' },
      },
      material: { kind: 'provider_api_key', value: 'provider-secret' },
    });
    expect(snapshot?.currentness).not.toHaveProperty('source');
    expect(JSON.stringify(snapshot?.currentness)).not.toContain('connectionSecurityFingerprint');
    await expect(snapshot?.currentness.isCurrent()).resolves.toBe(true);
  });
});
