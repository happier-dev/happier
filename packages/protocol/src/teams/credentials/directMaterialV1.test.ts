import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../../crypto/base64.js';
import { sealBoxBundle } from '../../crypto/boxBundle.js';

import {
  matchesTeamCredentialSourceVersionBasisV1,
  parseTeamCredentialSourceVersionV1,
  computeTeamCredentialConnectedAccountSourceVersionV1,
  computeTeamCredentialPoolMemberSourceVersionV1,
  computeTeamCredentialProviderCredentialSlotSourceVersionV1,
  computeTeamCredentialSourceMemberKeyV1,
  createTeamCredentialDirectMaterialStoredV1,
  materializeTeamCredentialDirectMaterialV1,
  openTeamCredentialDirectMaterialV1,
  parseTeamCredentialDirectMaterialStoredV1,
  sealTeamCredentialDirectMaterialV1,
  TeamCredentialDirectMaterialOpenRequestV1Schema,
  TeamCredentialDirectMaterialMineResponseV1Schema,
  type TeamCredentialDirectMaterialPayloadV1,
} from './directMaterialV1.js';

function randomBytesFactory(): (length: number) => Uint8Array {
  let next = 1;
  return (length) => {
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) result[i] = next++ & 0xff;
    return result;
  };
}

function payload(): TeamCredentialDirectMaterialPayloadV1 {
  return {
    v: 1,
    domain: 'happier.team-credential-direct-material',
    homeServerIdentityId: 'home-1',
    teamId: 'team-1',
    resourceId: 'resource-1',
    resourceRevision: 7,
    recipientAccountId: 'recipient-1',
    sourceMember: {
      kind: 'connected_account',
      service: { pluginId: 'happier.provider', localId: 'claude' },
      connectedAccountId: 'source-account-1',
    },
    sourceVersion: 'source-version-1',
    material: {
      kind: 'qualified_connected_account',
      credential: { v: 1, values: { token: 'secret' } },
      configuration: {
        values: { region: 'us-east' },
        secretValues: { clientSecret: 'configuration-secret' },
      },
      authenticationModeId: 'api-key',
    },
  };
}

describe('Team credential direct material v1', () => {
  it('accepts an omitted admission label while validating bounded metadata when present', () => {
    const value = payload();
    const response = {
      status: 'ready' as const,
      recipientMode: 'plain' as const,
      stored: createTeamCredentialDirectMaterialStoredV1({ payload: value, recipientMode: 'plain' }),
      expected: {
        homeServerIdentityId: value.homeServerIdentityId, teamId: value.teamId,
        resourceId: value.resourceId, resourceRevision: value.resourceRevision,
        recipientAccountId: value.recipientAccountId, sourceVersion: value.sourceVersion,
        sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(value.sourceMember),
      },
    };
    expect(TeamCredentialDirectMaterialMineResponseV1Schema.parse(response)).toEqual(response);
    const admittedResource = { displayName: 'Acme service', teamId: value.teamId };
    expect(TeamCredentialDirectMaterialMineResponseV1Schema.parse({ ...response, admittedResource }))
      .toEqual({ ...response, admittedResource });
    expect(TeamCredentialDirectMaterialMineResponseV1Schema.safeParse({
      ...response, admittedResource: { ...admittedResource, displayName: '' },
    }).success).toBe(false);
  });

  it('projects retired stored fields in plain and encrypted material without weakening recipient binding', () => {
    const original = payload();
    const retained = { ...original, retired: true, sourceMember: { ...original.sourceMember, retired: true } };
    const expected = { homeServerIdentityId: original.homeServerIdentityId, teamId: original.teamId,
      resourceId: original.resourceId, resourceRevision: original.resourceRevision, recipientAccountId: original.recipientAccountId,
      sourceVersion: original.sourceVersion, sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(original.sourceMember) };
    expect(materializeTeamCredentialDirectMaterialV1({ stored: { t: 'plain', v: retained, retired: true },
      recipientMode: 'plain', expected })).toEqual(original);
    const secret = new Uint8Array(32).fill(7);
    const envelope = encodeBase64(sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(retained)),
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(secret).publicKey, randomBytes: randomBytesFactory() }), 'base64');
    expect(openTeamCredentialDirectMaterialV1({ envelope, recipientSecretKeyOrSeed: secret, expected })).toEqual(original);
    expect(openTeamCredentialDirectMaterialV1({ envelope, recipientSecretKeyOrSeed: secret,
      expected: { ...expected, recipientAccountId: 'another-account' } })).toBeNull();
    expect(() => createTeamCredentialDirectMaterialStoredV1({ payload: retained, recipientMode: 'plain' })).toThrow();
  });
  it('versions private service configuration for both accounts and Pool members without changing the Home basis', () => {
    const source = {
      sourceAccountId: 'source-account-1',
      credentialIncarnation: 'credential-1',
      sourceMember: {
        kind: 'connected_account' as const,
        service: { pluginId: 'happier.provider', localId: 'claude' },
        connectedAccountId: 'source-account-1',
      },
      credentialRevision: 'credential-revision-1',
      configurationRevision: null,
      authenticationModeId: 'manual-token',
      contributionContractVersion: 'contribution-1',
    };
    const version = (fingerprint: string) => computeTeamCredentialConnectedAccountSourceVersionV1({
      ...source,
      privateConfigurationFingerprint: fingerprint,
    });
    const original = version('configuration-fingerprint-1');
    const rotated = version('configuration-fingerprint-2');
    expect(rotated).not.toBe(original);
    expect(version('configuration-fingerprint-1')).toBe(original);
    const poolVersion = (connectedAccountSourceVersion: string) => computeTeamCredentialPoolMemberSourceVersionV1({
      connectedAccountSourceVersion,
      poolIncarnation: 'pool-1',
      memberEnabled: true,
    });
    expect(poolVersion(rotated)).not.toBe(poolVersion(original));
    const basis = computeTeamCredentialConnectedAccountSourceVersionV1(source);
    expect(parseTeamCredentialSourceVersionV1(original)).toEqual({
      sourceBasisVersion: basis, privateConfigurationFingerprint: 'configuration-fingerprint-1',
    });
    expect(matchesTeamCredentialSourceVersionBasisV1(rotated, basis)).toBe(true);
    expect(matchesTeamCredentialSourceVersionBasisV1(poolVersion(rotated), poolVersion(basis))).toBe(true);
    expect(parseTeamCredentialSourceVersionV1(poolVersion(rotated)).privateConfigurationFingerprint).toBe('configuration-fingerprint-2');
    expect(matchesTeamCredentialSourceVersionBasisV1(original, 'other-basis')).toBe(false);
    expect(matchesTeamCredentialSourceVersionBasisV1('v1:["basis"]', 'basis')).toBe(false);
  });

  it('requires an exact admitted consumer and connected-service purpose to open material', () => {
    const common = {
      resourceId: 'resource-1',
      slot: { kind: 'connected_service_purpose' as const, purpose: {
        consumer: { pluginId: 'happier.agent', localId: 'example' }, purpose: 'search',
      } },
      disclosedMember: {
        service: { pluginId: 'happier.service', localId: 'example' },
        accountId: 'account-1',
      },
    } as const;
    expect(TeamCredentialDirectMaterialOpenRequestV1Schema.parse({
      ...common,
      consumer: { kind: 'session', sessionId: 'session-1' },
    }).consumer).toEqual({ kind: 'session', sessionId: 'session-1' });
    expect(TeamCredentialDirectMaterialOpenRequestV1Schema.parse({
      ...common,
      consumer: { kind: 'execution_run', executionRunId: 'run-1', workerMachineId: 'machine-1' },
    }).consumer).toMatchObject({ kind: 'execution_run', executionRunId: 'run-1' });
    expect(TeamCredentialDirectMaterialOpenRequestV1Schema.parse({
      resourceId: 'provider-resource-1',
      slot: { kind: 'provider_model' },
      sourceMemberKey: 'provider-member-key',
      consumer: { kind: 'session', sessionId: 'session-provider' },
    })).toMatchObject({ slot: { kind: 'provider_model' }, sourceMemberKey: 'provider-member-key' });
    expect(TeamCredentialDirectMaterialOpenRequestV1Schema.safeParse(common).success).toBe(false);
    expect(TeamCredentialDirectMaterialOpenRequestV1Schema.parse({
      ...common, consumer: { kind: 'platform_operation', deploymentId: 'receipt-1', environmentId: 'environment-1', operationId: 'deploy-1' },
    }).consumer).toEqual({ kind: 'platform_operation', deploymentId: 'receipt-1', environmentId: 'environment-1', operationId: 'deploy-1' });
    expect(TeamCredentialDirectMaterialOpenRequestV1Schema.safeParse({
      ...common, consumer: { kind: 'platform_operation', operationId: 'deploy-1' },
    }).success).toBe(false);
  });

  it('keeps Provider runtime binding inside the strict recipient-private payload', () => {
    const providerPayload: TeamCredentialDirectMaterialPayloadV1 = {
      ...payload(),
      sourceMember: {
        kind: 'provider_credential_slot', connectionId: 'connection-1', credentialSlotId: 'apiKey',
      },
      material: {
        kind: 'provider_api_key', value: 'private-key',
        runtimeBinding: {
          provider: { identity: { pluginId: 'happier.provider.openai', localId: 'openai' }, definitionRevision: 1 },
          endpoint: {
            endpointTemplateId: 'responses', normalizedUrl: 'https://api.example.test/v1',
            protocol: 'openai-responses', publicHeaders: { 'X-Public': 'stable' },
          },
          credentialTransport: {
            id: 'api-key', protocols: ['openai-responses'], uses: ['runtime'],
            destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
          },
        },
      },
    };
    const stored = createTeamCredentialDirectMaterialStoredV1({ payload: providerPayload, recipientMode: 'plain' });
    expect(stored).toEqual({ t: 'plain', v: providerPayload });
    expect(() => createTeamCredentialDirectMaterialStoredV1({
      payload: {
        ...providerPayload,
        material: { kind: 'provider_api_key', value: 'private-key' } as never,
      },
      recipientMode: 'plain',
    })).toThrow();
  });

  it('uses stable source identity independent of object key order', () => {
    const member = payload().sourceMember;
    expect(computeTeamCredentialSourceMemberKeyV1(member)).toBe(
      computeTeamCredentialSourceMemberKeyV1({
        connectedAccountId: 'source-account-1',
        kind: 'connected_account',
        service: { localId: 'claude', pluginId: 'happier.provider' },
      }),
    );
  });

  it('round-trips an explicit plain representation without requiring a key', () => {
    const stored = createTeamCredentialDirectMaterialStoredV1({ payload: payload(), recipientMode: 'plain' });
    expect(stored.t).toBe('plain');
    const expected = {
      homeServerIdentityId: 'home-1',
      teamId: 'team-1',
      resourceId: 'resource-1',
      resourceRevision: 7,
      recipientAccountId: 'recipient-1',
      sourceVersion: 'source-version-1',
      sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(payload().sourceMember),
    };
    expect(materializeTeamCredentialDirectMaterialV1({ stored, recipientMode: 'plain', expected })).toEqual(payload());
    expect(materializeTeamCredentialDirectMaterialV1({
      stored,
      recipientMode: 'e2ee',
      recipientSecretKeyOrSeed: new Uint8Array(32).fill(5),
    })).toBeNull();
  });

  it('requires complete expected currentness for both plain and encrypted material', () => {
    const stored = createTeamCredentialDirectMaterialStoredV1({ payload: payload(), recipientMode: 'plain' });
    expect(materializeTeamCredentialDirectMaterialV1({ stored, recipientMode: 'plain' })).toBeNull();
    expect(materializeTeamCredentialDirectMaterialV1({
      stored,
      recipientMode: 'plain',
      expected: { resourceId: 'resource-1' },
    })).toBeNull();

    const secret = new Uint8Array(32).fill(7);
    const envelope = sealTeamCredentialDirectMaterialV1({
      payload: payload(),
      recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(secret).publicKey,
      randomBytes: randomBytesFactory(),
    });
    expect(openTeamCredentialDirectMaterialV1({ envelope, recipientSecretKeyOrSeed: secret })).toBeNull();
  });

  it('projects retired configuration fields on read while keeping fully resolved material writes strict', () => {
    const candidate = payload();
    const retained = {
        ...candidate,
        material: {
          ...candidate.material,
          configuration: {
            values: { region: 'us-east' },
            secretValues: { clientSecret: 'resolved-secret' },
            secretRefs: { clientSecret: 'saved-secret-id' },
          },
        },
      };
    const stored = parseTeamCredentialDirectMaterialStoredV1({ t: 'plain', v: retained });
    expect(stored).not.toHaveProperty('v.material.configuration.secretRefs');
    expect(stored).toMatchObject({ v: { material: { configuration: {
      values: { region: 'us-east' }, secretValues: { clientSecret: 'resolved-secret' },
    } } } });
    expect(() => createTeamCredentialDirectMaterialStoredV1({ payload: retained, recipientMode: 'plain' })).toThrow();
  });

  it('derives source versions from every source-kind currentness fact', () => {
    const connectedInput = {
      sourceAccountId: 'source-owner-1',
      credentialIncarnation: 'credential-incarnation-1',
      sourceMember: payload().sourceMember,
      credentialRevision: 'credential-revision-1',
      configurationRevision: 'configuration-revision-1',
      authenticationModeId: 'api-key',
      contributionContractVersion: 'contract-1',
    } as const;
    const connected = computeTeamCredentialConnectedAccountSourceVersionV1(connectedInput);
    expect(computeTeamCredentialConnectedAccountSourceVersionV1({
      ...connectedInput,
      configurationRevision: 'configuration-revision-2',
    })).not.toBe(connected);
    expect(computeTeamCredentialConnectedAccountSourceVersionV1({
      ...connectedInput,
      contributionContractVersion: 'contract-2',
    })).not.toBe(connected);

    const pool = computeTeamCredentialPoolMemberSourceVersionV1({
      connectedAccountSourceVersion: connected,
      poolIncarnation: 'pool-incarnation-1',
      memberEnabled: true,
    });
    expect(computeTeamCredentialPoolMemberSourceVersionV1({
      connectedAccountSourceVersion: connected,
      poolIncarnation: 'pool-incarnation-1',
      memberEnabled: false,
    })).not.toBe(pool);

    const providerInput = {
      sourceAccountId: 'source-owner-1',
      sourceMember: {
        kind: 'provider_credential_slot' as const,
        connectionId: 'connection-1',
        credentialSlotId: 'slot-1',
      },
      providerConnectionRevision: 'connection-revision-1',
      machineBinding: 'machine-1',
      savedSecretFingerprint: 'fingerprint-1',
      credentialTransport: 'api_key' as const,
    };
    const provider = computeTeamCredentialProviderCredentialSlotSourceVersionV1(providerInput);
    expect(computeTeamCredentialProviderCredentialSlotSourceVersionV1({
      ...providerInput,
      savedSecretFingerprint: 'fingerprint-2',
    })).not.toBe(provider);
  });

  it('seals and opens E2EE material while binding every expected field', () => {
    const secret = new Uint8Array(32).fill(7);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
    const envelope = sealTeamCredentialDirectMaterialV1({
      payload: payload(),
      recipientContentPublicKey: publicKey,
      randomBytes: randomBytesFactory(),
    });
    const expected = {
      homeServerIdentityId: 'home-1',
      teamId: 'team-1',
      resourceId: 'resource-1',
      resourceRevision: 7,
      recipientAccountId: 'recipient-1',
      sourceVersion: 'source-version-1',
      sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(payload().sourceMember),
    };
    expect(openTeamCredentialDirectMaterialV1({ envelope, recipientSecretKeyOrSeed: secret, expected })).toEqual(payload());
    expect(openTeamCredentialDirectMaterialV1({
      envelope,
      recipientSecretKeyOrSeed: secret,
      expected: { ...expected, resourceId: 'other-resource' },
    })).toBeNull();
    expect(materializeTeamCredentialDirectMaterialV1({
      stored: { t: 'encrypted', c: envelope },
      recipientMode: 'e2ee',
      recipientSecretKeyOrSeed: secret,
      expected,
    })).toEqual(payload());
  });

  it('rejects malformed stored shapes and does not reinterpret encrypted content as plain', () => {
    expect(() => parseTeamCredentialDirectMaterialStoredV1({ t: 'plain', v: { v: 1 } })).toThrow();
    expect(() => parseTeamCredentialDirectMaterialStoredV1({ t: 'encrypted', c: '' })).toThrow();
    expect(materializeTeamCredentialDirectMaterialV1({
      stored: { t: 'encrypted', c: 'not-a-bundle' },
      recipientMode: 'plain',
    })).toBeNull();
  });
});
