import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  ProviderConnectionIdSchema,
  ProviderConnectionSecurityFingerprintV1Schema,
  ProviderCredentialTransportV1Schema,
  TeamCredentialDirectMaterialPreparationResponseV1Schema,
  TeamCredentialDirectMaterialUpsertRequestV1Schema,
} from '@happier-dev/protocol';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams';

import type { TeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';
import { QualifiedConnectedAccountMaterialError } from '../qualifiedConnectedAccountMaterialError';
import { reconcileTeamCredentialDirectMaterial } from './reconcileTeamCredentialDirectMaterial';
import { TeamCredentialDirectMaterialHttpContractError, upsertTeamCredentialDirectMaterial } from './teamCredentialDirectMaterialHttp';

// Axios is the network boundary; producer, orchestration and wire admission stay real.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, put: vi.fn() } };
});

const sourceMember = Object.freeze({
  kind: 'provider_credential_slot' as const,
  connectionId: ProviderConnectionIdSchema.parse('pc_source'),
  credentialSlotId: 'apiKey',
});
const sourceSnapshot: TeamCredentialSourceSnapshot = Object.freeze({
  currentness: Object.freeze({
    sourceMember,
    sourceVersion: 'source-v2',
    isCurrent: vi.fn(async () => true),
  }),
  material: Object.freeze({
    kind: 'provider_api_key' as const,
    value: 'source-secret',
    runtimeBinding: Object.freeze({
      provider: Object.freeze({ identity: Object.freeze({ pluginId: 'provider.test', localId: 'test' }), definitionRevision: 1 }),
      endpoint: Object.freeze({
        endpointTemplateId: 'responses', normalizedUrl: 'https://api.example.test/v1',
        protocol: 'openai-responses' as const, publicHeaders: Object.freeze({}),
      }),
      credentialTransport: ProviderCredentialTransportV1Schema.parse({
        id: 'api-key', protocols: ['openai-responses'], uses: ['runtime'],
        destination: Object.freeze({ kind: 'httpHeader' as const, name: 'Authorization', format: 'bearer' as const }),
      }),
    }),
  }),
});
const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);

describe('reconcileTeamCredentialDirectMaterial', () => {
  it.each(['valid', 'invalid_request', 'invalid_response'] as const)(
    'preserves the producer → HTTP contract through reconciliation (%s)', async mode => {
      const page = TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
        homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 4,
        source: { v: 1, kind: 'provider_connection', connectionId: sourceMember.connectionId,
          connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:test'), credentialSlotId: 'apiKey' },
        sourceMember, sourceCredentialIncarnation: null, publishedSourceVersion: null,
        recipients: [{ recipientAccountId: 'a', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null,
          recipientContentPublicKey: null, expectedStoredSourceVersion: null, storedTupleCurrent: false }],
        nextCursor: null,
      });
      const put = vi.mocked(axios.put).mockReset();
      put.mockImplementation(async (_url, body) => ({ status: 200, data: mode === 'invalid_response' ? {} : {
        results: TeamCredentialDirectMaterialUpsertRequestV1Schema.parse(body).items.map(item => ({
          status: 'stored', recipientAccountId: item.recipientAccountId,
          sourceMemberKey: item.sourceMemberKey, sourceVersion: item.sourceVersion,
        })),
      } }));
      let preparationReads = 0;
      const result = reconcileTeamCredentialDirectMaterial({
        teamId: page.teamId, resourceId: page.resourceId, sourceMemberKey,
        fetchPreparation: async () => { preparationReads++; return page; },
        resolveSourceSnapshot: async () => sourceSnapshot,
        upsert: async item => {
          await upsertTeamCredentialDirectMaterial({
            token: 'fixture-token', serverUrl: 'https://home.test', teamId: page.teamId, resourceId: page.resourceId,
            body: { items: [mode === 'invalid_request' ? { ...item, recipientAccountId: '' } : item] },
          });
          return { ok: true };
        },
        withdrawPublication: async () => ({ ok: true }),
      });
      if (mode === 'valid') {
        await expect(result).resolves.toEqual({ ok: true, prepared: 1 });
        expect(put.mock.calls[0]?.[0]).toBe('https://home.test/v2/teams/team/credential-resources/resource/direct-material');
        expect(TeamCredentialDirectMaterialUpsertRequestV1Schema.parse(put.mock.calls[0]?.[1]).items[0].stored).toMatchObject({
          t: 'plain', v: { resourceId: 'resource', recipientAccountId: 'a' },
        });
      } else {
        await expect(result).rejects.toBeInstanceOf(TeamCredentialDirectMaterialHttpContractError);
      }
      // A bad request never reaches the network; a contract failure settles without a re-poll.
      expect(put).toHaveBeenCalledTimes(mode === 'invalid_request' ? 0 : 1);
      expect(preparationReads).toBe(3);
    },
  );

  it.each(['missing', 'unavailable', 'expiry_unavailable', 'changed', 'replacement_rejected'] as const)('withdraws the captured publication when source configuration is %s', async (failure) => {
    let published: string | null = 'source-v1';
    const page = TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
      homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 4,
      source: { v: 1, kind: 'provider_connection', connectionId: sourceMember.connectionId, connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:test'), credentialSlotId: 'apiKey' },
      sourceMember, sourceCredentialIncarnation: null, publishedSourceVersion: published,
      recipients: [{ recipientAccountId: 'a', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: published, storedTupleCurrent: true }],
      nextCursor: null,
    });
    const result = await reconcileTeamCredentialDirectMaterial({
      teamId: 'team', resourceId: 'resource', sourceMemberKey,
      fetchPreparation: async () => page,
      resolveSourceSnapshot: async () => {
        if (failure === 'expiry_unavailable') throw new QualifiedConnectedAccountMaterialError(
          'access_only_expiry_unavailable', 'Reconnect this imported login to share it natively.');
        if (failure === 'unavailable') throw new Error('Saved Secret access removed');
        if (failure === 'missing') return null;
        return { ...sourceSnapshot, currentness: { ...sourceSnapshot.currentness, isCurrent: async () => failure !== 'changed' } };
      },
      upsert: async () => ({ ok: false as const, reason: 'recipient_unavailable' }),
      withdrawPublication: async (expected: Readonly<{ expectedResourceRevision: number; expectedPublishedSourceVersion: string }>) => {
        if (expected.expectedResourceRevision !== 4 || expected.expectedPublishedSourceVersion !== published) return { ok: false as const };
        published = null;
        return { ok: true as const };
      },
    });
    expect(result.ok).toBe(false);
    if (failure === 'expiry_unavailable') expect(result).toEqual({ ok: false, reason: 'access_only_expiry_unavailable', prepared: 0 });
    expect(published).toBeNull();
  });

  it('consumes paginated current preparation and publishes each recipient through the canonical producer', async () => {
    const firstPage = TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
        homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 4,
        source: { v: 1, kind: 'provider_connection', connectionId: sourceMember.connectionId, connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:test'), credentialSlotId: 'apiKey' },
        sourceMember, sourceCredentialIncarnation: null, publishedSourceVersion: 'source-v1',
        recipients: [{ recipientAccountId: 'a', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: null, storedTupleCurrent: false }],
        nextCursor: 'next',
      });
    const secondPage = TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
        homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 4,
        source: { v: 1, kind: 'provider_connection', connectionId: sourceMember.connectionId, connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:test'), credentialSlotId: 'apiKey' },
        sourceMember, sourceCredentialIncarnation: null, publishedSourceVersion: 'source-v2',
        recipients: [{ recipientAccountId: 'b', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: 'source-v1', storedTupleCurrent: false }],
        nextCursor: null,
      });
    const fetchPreparation = vi.fn(async (input: Readonly<{
      teamId: string;
      resourceId: string;
      sourceMemberKey: string;
      cursor?: string;
      signal?: AbortSignal;
    }>) => (
      input.cursor === 'next' ? secondPage : firstPage
    ));
    const upsert = vi.fn(async () => ({ ok: true as const }));

    await expect(reconcileTeamCredentialDirectMaterial({
      teamId: 'team', resourceId: 'resource', sourceMemberKey,
      fetchPreparation,
      resolveSourceSnapshot: vi.fn(async () => sourceSnapshot),
      upsert,
      withdrawPublication: async () => ({ ok: true }),
    })).resolves.toEqual({ ok: true, prepared: 2 });

    expect(fetchPreparation).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: undefined }));
    expect(fetchPreparation).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'next' }));
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedPublishedSourceVersion: 'source-v1' }));
    expect(upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedPublishedSourceVersion: 'source-v2' }));
  });

  // The Home advances the resource's published source version on the first
  // tuple of a run, so the remaining recipients of the same page must be
  // fenced against the version this run just published, not the one captured
  // before it.
  it('carries the version this run published into the remaining recipients of the page', async () => {
    let publishedSourceVersion: string | null = null;
    const page = () => TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
      homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 4,
      source: { v: 1, kind: 'provider_connection', connectionId: sourceMember.connectionId, connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:test'), credentialSlotId: 'apiKey' },
      sourceMember, sourceCredentialIncarnation: null, publishedSourceVersion,
      recipients: [
        { recipientAccountId: 'a', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: null, storedTupleCurrent: false },
        { recipientAccountId: 'b', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: null, storedTupleCurrent: false },
      ],
      nextCursor: null,
    });
    const upsert = vi.fn(async (item: Readonly<{ sourceVersion: string }>) => {
      publishedSourceVersion = item.sourceVersion;
      return { ok: true as const };
    });

    await expect(reconcileTeamCredentialDirectMaterial({
      teamId: 'team', resourceId: 'resource', sourceMemberKey,
      fetchPreparation: vi.fn(async () => page()),
      resolveSourceSnapshot: vi.fn(async () => sourceSnapshot),
      upsert,
      withdrawPublication: async () => ({ ok: true }),
    })).resolves.toEqual({ ok: true, prepared: 2 });
    expect(upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedPublishedSourceVersion: null }));
    expect(upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedPublishedSourceVersion: 'source-v2' }));
  });

  // Child 06 L10D-R13: preparation reconciles only missing or stale tuples.
  // Rewriting a tuple the Home already reports current for the snapshot's own
  // source version would publish a Team change that restarts this reconciler.
  it('prepares only recipients whose stored tuple is missing or stale for the current source version', async () => {
    const page = TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
      homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 4,
      source: { v: 1, kind: 'provider_connection', connectionId: sourceMember.connectionId, connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:test'), credentialSlotId: 'apiKey' },
      sourceMember, sourceCredentialIncarnation: null, publishedSourceVersion: 'source-v2',
      recipients: [
        { recipientAccountId: 'current', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: 'source-v2', storedTupleCurrent: true },
        { recipientAccountId: 'rekeyed', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: 'source-v2', storedTupleCurrent: false },
        { recipientAccountId: 'missing', recipientMode: 'plain', recipientContentPublicKeyFingerprint: null, recipientContentPublicKey: null, expectedStoredSourceVersion: null, storedTupleCurrent: false },
      ],
      nextCursor: null,
    });
    const upsert = vi.fn(async (_item: Readonly<{ recipientAccountId: string }>) => ({ ok: true as const }));

    await expect(reconcileTeamCredentialDirectMaterial({
      teamId: 'team', resourceId: 'resource', sourceMemberKey,
      fetchPreparation: vi.fn(async () => page),
      resolveSourceSnapshot: vi.fn(async () => sourceSnapshot),
      upsert,
      withdrawPublication: async () => ({ ok: true }),
    })).resolves.toEqual({ ok: true, prepared: 2 });
    expect(upsert.mock.calls.map(([item]) => item.recipientAccountId)).toEqual(['rekeyed', 'missing']);

    // The same Home-current tuple is stale once the source itself moved on.
    // The Home publishes the new version with the first accepted tuple, so the
    // fake Home answers every later preparation read with it.
    let published = 'source-v2';
    const rotatedUpsert = vi.fn(async (item: Readonly<{ recipientAccountId: string; sourceVersion: string }>) => {
      published = item.sourceVersion;
      return { ok: true as const };
    });
    await expect(reconcileTeamCredentialDirectMaterial({
      teamId: 'team', resourceId: 'resource', sourceMemberKey,
      fetchPreparation: vi.fn(async () => ({ ...page, publishedSourceVersion: published })),
      resolveSourceSnapshot: vi.fn(async () => ({
        ...sourceSnapshot,
        currentness: { ...sourceSnapshot.currentness, sourceVersion: 'source-v3' },
      })),
      upsert: rotatedUpsert,
      withdrawPublication: async () => ({ ok: true }),
    })).resolves.toEqual({ ok: true, prepared: 3 });
    expect(rotatedUpsert.mock.calls.map(([item]) => item.recipientAccountId)).toEqual(['current', 'rekeyed', 'missing']);
  });

  it('fails closed when the preparation source member differs from the canonical snapshot', async () => {
    const upsert = vi.fn();
    await expect(reconcileTeamCredentialDirectMaterial({
      teamId: 'team', resourceId: 'resource', sourceMemberKey: 'member',
      fetchPreparation: vi.fn(async () => TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
        homeServerIdentityId: 'home', teamId: 'team', resourceId: 'resource', resourceRevision: 1,
        source: { v: 1, kind: 'provider_connection', connectionId: sourceMember.connectionId, connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:test'), credentialSlotId: 'apiKey' },
        sourceMember: { ...sourceMember, credentialSlotId: 'other' }, sourceCredentialIncarnation: null, publishedSourceVersion: null,
        recipients: [], nextCursor: null,
      })),
      resolveSourceSnapshot: vi.fn(async () => sourceSnapshot),
      upsert,
      withdrawPublication: async () => ({ ok: true }),
    })).resolves.toEqual({ ok: false, reason: 'source_changed', prepared: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });
});
