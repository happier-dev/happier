import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  TeamCredentialSourceBindingV1Schema,
  type TeamCredentialDirectMaterialUpsertRequestV1,
} from '@happier-dev/protocol/teams';

import type { QualifiedConnectedAccountMaterialSnapshot } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountTeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';

import { createTeamCredentialDirectMaterialClient } from './teamCredentialDirectMaterialClient';
import { produceTeamCredentialDirectMaterial } from './teamCredentialDirectMaterialProducer';

const account = {
  service: { pluginId: 'happier.agent.muse', localId: 'muse-account' },
  accountId: 'custodian-muse-account',
};
const parsedSource = TeamCredentialSourceBindingV1Schema.parse({
  v: 1,
  kind: 'connected_account',
  target: { kind: 'account', account },
  credentialIncarnation: 'custodian-account-incarnation',
});
if (parsedSource.kind !== 'connected_account') throw new Error('Expected Connected Account source');
const source = parsedSource;

type Publication = TeamCredentialDirectMaterialUpsertRequestV1['items'][number];

describe('Muse access-only Team delivery', () => {
  it.each(['plain', 'e2ee'] as const)(
    'delivers only access material through %s recipient opening, rotates it, and refuses the next revoked open',
    async recipientMode => {
      const secretKey = new Uint8Array(32).fill(19);
      const publicKey = tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey;
      const expiresAtMs = String(Date.now() + 60_000);
      let persistedSourceCurrent = true;
      let currentCredentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
      let revoked = false;
      let published: Publication | undefined;
      const uploads: Publication[] = [];

      function captureSource(accountToken: string, credentialRevision: string) {
        const material = {
          credential: {
            v: 1,
            values: {
              accountToken,
              expiresAtMs,
              credentialMode: 'native',
              refreshToken: 'synthetic-custodian-refresh',
              inferenceKey: 'synthetic-custodian-inference',
            },
          },
          configuration: {
            values: { privateEndpoint: 'https://custodian-private.example.test' },
            secretValues: { clientSecret: 'synthetic-private-configuration-secret' },
          },
          authenticationModeId: 'device',
          credentialRevision,
          configurationRevision: 'custodian-configuration-1',
          contributionContractVersion: 'muse-contribution-1',
          accessOnlyExport: {
            contractVersion: 'happier.team-credential-access-only-connected-account-direct.v1',
            accessTokenKey: 'accountToken',
            expiresAtMsKey: 'expiresAtMs',
            metadataKeys: ['credentialMode'],
          },
          isCurrent: async () => credentialRevision === currentCredentialRevision,
        } satisfies QualifiedConnectedAccountMaterialSnapshot;
        const snapshot = createConnectedAccountTeamCredentialSourceSnapshot({
          source,
          material,
          authenticationKind: 'oauth',
          isPersistedSourceCurrent: async () => persistedSourceCurrent,
        });
        if (!snapshot) throw new Error('Native Muse access-only source was refused');
        return snapshot;
      }

      async function publish(snapshot: ReturnType<typeof captureSource>) {
        const expected = {
          sourceMember: snapshot.currentness.sourceMember,
          publishedSourceVersion: published?.sourceVersion ?? null,
          expectedResourceRevision: 7,
          expectedStoredSourceVersion: published?.sourceVersion ?? null,
          recipientMode,
          recipientContentPublicKeyFingerprint: recipientMode === 'e2ee' ? 'synthetic-recipient-key' : null,
          ...(recipientMode === 'e2ee' ? { recipientContentPublicKey: publicKey } : {}),
        };
        return produceTeamCredentialDirectMaterial({
          sourceSnapshot: snapshot,
          expected,
          readCurrentPreparation: async () => expected,
          homeServerIdentityId: 'home-1',
          teamId: 'team-1',
          resourceId: 'muse-resource',
          recipientAccountId: 'member-account',
          randomBytes: tweetnacl.randomBytes,
          // Fake Home transport only: retain exactly what the real producer uploads.
          upsert: async item => {
            uploads.push(item);
            published = item;
            return { ok: true };
          },
        });
      }

      const client = createTeamCredentialDirectMaterialClient({
        // Home admission is a network boundary; cryptographic opening stays real.
        fetchCurrent: async () => {
          if (revoked) return { ok: false, reason: 'access_removed' };
          if (!published) return { ok: false, reason: 'preparing' };
          return {
            ok: true,
            recipientMode,
            stored: published.stored,
            expected: {
              homeServerIdentityId: 'home-1',
              teamId: 'team-1',
              resourceId: 'muse-resource',
              resourceRevision: 7,
              recipientAccountId: 'member-account',
              sourceMemberKey: published.sourceMemberKey,
              sourceVersion: published.sourceVersion,
            },
          };
        },
        readRecipientEncryptionMaterial: async () => recipientMode === 'plain'
          ? { mode: 'plain' }
          : { mode: 'e2ee', secretKeyOrSeed: secretKey },
      });
      const openRequest = {
        teamId: 'team-1',
        resourceId: 'muse-resource',
        consumer: { kind: 'session', sessionId: 'member-session' },
        slot: {
          kind: 'connected_service_purpose',
          purpose: { consumer: { pluginId: 'happier.agent.muse', localId: 'muse' }, purpose: 'muse-native' },
        },
        disclosedMember: account,
      } satisfies Parameters<typeof client.open>[0];

      async function expectOpenedAccessOnly(accountToken: string) {
        const opened = await client.open(openRequest);
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error('Recipient could not open Muse access material');
        expect(opened.payload.material).toEqual({
          kind: 'qualified_connected_account',
          authenticationModeId: 'device',
          credential: { v: 1, values: { accountToken, expiresAtMs, credentialMode: 'native' } },
          configuration: null,
        });
      }

      const first = captureSource('synthetic-member-access-1', currentCredentialRevision);
      await expect(publish(first)).resolves.toEqual({ ok: true, sourceVersion: first.currentness.sourceVersion });
      await expectOpenedAccessOnly('synthetic-member-access-1');

      currentCredentialRevision = 'csr_1123456789ABCDEFGHJKMNPQRS';
      const rotated = captureSource('synthetic-member-access-2', currentCredentialRevision);
      expect(rotated.currentness.sourceVersion).not.toBe(first.currentness.sourceVersion);
      await expect(publish(rotated)).resolves.toEqual({ ok: true, sourceVersion: rotated.currentness.sourceVersion });
      await expectOpenedAccessOnly('synthetic-member-access-2');

      const uploadsBeforeStale = uploads.length;
      await expect(publish(first)).resolves.toEqual({ ok: false, reason: 'source_changed' });
      persistedSourceCurrent = false;
      await expect(publish(rotated)).resolves.toEqual({ ok: false, reason: 'source_changed' });
      expect(uploads).toHaveLength(uploadsBeforeStale);

      revoked = true;
      await expect(client.open(openRequest)).resolves.toEqual({ ok: false, reason: 'access_removed' });
    },
  );
});
