import { describe, expect, it, vi } from 'vitest';

import { PluginInstallReviewPrincipalDigestSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  inspectRawCredentialAuthorizationReadiness,
  RawCredentialAuthorizationClient,
} from './rawCredentialAuthorizationClient';

const contribution = Object.freeze({ pluginId: 'acme.voice', localId: 'browser' });
const rawGrant = Object.freeze({
  realm: 'daemon' as const,
  phase: 'speech' as const,
  request: Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    headerNames: Object.freeze(['authorization']),
  }),
});

function authorization() {
  return {
    pluginId: contribution.pluginId,
    capability: 'credentials.materialize.raw' as const,
    targetScope: { kind: 'account' as const },
    subject: {
      kind: 'credential_access_disclosure' as const,
      contribution,
      credentialSlotId: 'api_key' as never,
      purpose: 'voice.browser' as never,
      accessDeclarationDigest: 'b'.repeat(64) as never,
      selectedAuthorityDigest: 'c'.repeat(64) as never,
      selectedRawAccessDigest: 'd'.repeat(64) as never,
      installedGenerationId: 'generation-1' as never,
      installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
    },
    // The daemon only ever authorizes as an exact machine installation, so the
    // response carries the installation whose approval a client must match.
    authoritySource: {
      kind: 'machine_installation' as const,
      machineId: 'machine-1',
      installationId: 'installation-1',
    },
    disclosures: [{
      sourceClass: { kind: 'savedSecret' as const, secretKinds: ['apiKey' as const] },
      realm: 'web' as const,
      phase: 'connection' as const,
      materialization: 'httpHeaders' as const,
      origin: 'https://voice.example.test',
      destination: 'authorization',
    }],
  };
}

function review() {
  return {
    plugin: { id: contribution.pluginId, name: 'Acme Voice', version: '2.0.0' },
    package: { identity: '@acme/voice' },
    distribution: { kind: 'unavailable' as const },
    publisher: { status: 'unavailable' as const },
    packageSignature: { status: 'unavailable' as const },
    contribution: { identity: contribution, name: 'Browser Voice' },
    credentialSlot: { id: 'api_key', name: 'API key', purpose: 'voice.browser' },
  };
}

describe('raw credential authorization client', () => {
  it('calls inspect and request with the qualified contribution and exact raw tuple', async () => {
    const machineRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method === RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT) {
        return { ok: true, authorization: authorization(), review: review() };
      }
      return {
        ok: true,
        authorization: authorization(),
        review: review(),
        pendingRequest: {
          v: 1,
          id: 'request-1',
          accountId: 'account-1',
          pluginId: contribution.pluginId,
          capability: 'credentials.materialize.raw',
          targetScope: { kind: 'account' },
          subject: authorization().subject,
          authoritySource: authorization().authoritySource,
          requester: { kind: 'plugin', pluginId: contribution.pluginId },
          reason: 'Voice provider raw credential access review',
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        },
      };
    });
    const client = new RawCredentialAuthorizationClient({
      resolveMachineId: () => 'machine-1',
      machineRpc: machineRpc as never,
    });

    await expect(client.inspect(contribution, rawGrant)).resolves.toMatchObject({ authorization: authorization() });
    await expect(client.request(contribution, rawGrant)).resolves.toMatchObject({ pendingRequest: { id: 'request-1' } });
    expect(machineRpc.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        method: RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT,
        payload: { contribution, rawGrant },
      }),
      expect.objectContaining({
        method: RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST,
        payload: { contribution, rawGrant },
      }),
    ]);
  });

  it('fails closed on malformed daemon output', async () => {
    const client = new RawCredentialAuthorizationClient({
      resolveMachineId: () => 'machine-1',
      machineRpc: vi.fn(async () => ({ ok: true, authorization: { grants: [] } })) as never,
    });
    await expect(client.inspect(contribution, rawGrant)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts an active grant for the exact daemon speech tuple', async () => {
    const speechAuthorization = {
      ...authorization(),
      disclosures: [{
        ...authorization().disclosures[0],
        realm: 'daemon' as const,
        phase: 'speech' as const,
      }],
    };
    const inspect = vi.fn(async () => ({
      ok: true as const,
      authorization: speechAuthorization,
      review: review(),
    }));
    const list = vi.fn(async () => ({
      grants: [{
        id: 'grant-1',
        status: 'active',
        authoritySource: speechAuthorization.authoritySource,
      }],
      pendingRequests: [],
    } as never));

    await expect(inspectRawCredentialAuthorizationReadiness(
      contribution,
      rawGrant,
      undefined,
      { client: { inspect }, list },
    )).resolves.toBe('ready');
  });

  it('does not treat an authorization without an active exact grant as ready', async () => {
    await expect(inspectRawCredentialAuthorizationReadiness(
      contribution,
      rawGrant,
      undefined,
      {
        client: { inspect: vi.fn(async () => ({
          ok: true as const,
          authorization: authorization(),
          review: review(),
        })) },
        list: vi.fn(async () => ({ grants: [], pendingRequests: [] })),
      },
    )).resolves.toBe('approval_required');
  });
});
