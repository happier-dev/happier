import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';

import {
  encodeBase64,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { SavedSecretResourceEnvelopeCensusRecipientV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { openCliMachinePresetsForRequester } from './presetRequesterOpening';

const tokenFor = (sub: string) =>
  `fixture.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;

describe('openCliMachinePresetsForRequester', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({
      app,
      origin: 'http://account.test',
    });
  });
  afterEach(async () => {
    restore();
    await app.close();
  });

  function ownSealedPreset(key: Uint8Array) {
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(key).publicKey;
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'own-preset',
      mode: 'e2ee',
      content: {
        v: 1,
        name: 'Private',
        launch: {
          provider: { pluginId: 'happier.machine.lima', localId: 'lima' },
          schemaVersion: 1,
          name: 'gpu',
          choices: {},
        },
      },
      recipientCensus: [
        SavedSecretResourceEnvelopeCensusRecipientV1Schema.parse({
          account: {
            kind: 'account',
            accountId: 'owner',
            firstName: 'o',
            lastName: null,
            username: 'o',
            avatarUrl: null,
          },
          readiness: {
            status: 'available',
            contentPublicKey: encodeBase64(publicKey, 'base64'),
            contentPublicKeyFingerprint:
              computeContentPublicKeyFingerprint(publicKey),
          },
          envelopeStatus: 'missing',
        }),
      ],
      randomBytes: (length) => new Uint8Array(length).fill(61),
    });
    app.get('/v1/account/encryption/currentness', async () =>
      AccountEncryptionCurrentnessResponseSchema.parse({
        mode: 'e2ee',
        version: 1,
        settingsVersion: 1,
        signingKeyFingerprint: null,
        updatedAt: 1,
        contentKeyFingerprint:
          computeAccountEncryptionMigrateKeyFingerprintV1(publicKey),
      }),
    );
    return {
      publicKey,
      preset: ManagedMachinePresetV1Schema.parse({
        id: 'own-preset',
        homeId: 'srv_preset',
        revision: 1,
        owner: { kind: 'account', accountId: 'owner' },
        contentEncryptionMode: 'e2ee',
        content: sealed.content,
        recipients: sealed.recipients,
        controller: { machineId: 'host-a', installationId: 'installation-a' },
      }),
    };
  }

  // Only the carrier's bearer is read here; the full signed binding is the transport owner's concern.
  const externalContext = (requester: string) =>
    ({
      surface: 'mcp',
      externalActionExecutionAuthorization: {
        v: 1,
        token: tokenFor(requester),
      },
    }) as unknown as ActionExecutorContext;

  it("opens for the key holder's own Session request carried by an external execution authorization", async () => {
    const key = new Uint8Array(32).fill(62);
    const { publicKey, preset } = ownSealedPreset(key);
    const token = tokenFor('owner');
    const opened = await openCliMachinePresetsForRequester({
      presets: [preset],
      context: externalContext('owner'),
      token,
      credentials: {
        token,
        encryption: { type: 'dataKey', machineKey: key, publicKey },
      },
      serverUrl: 'http://account.test',
    });
    expect(opened).toMatchObject([
      { kind: 'opened', presetId: 'own-preset', content: { name: 'Private' } },
    ]);
  });

  it('keeps the preset sealed when the external execution runs for another person', async () => {
    const key = new Uint8Array(32).fill(63);
    const { publicKey, preset } = ownSealedPreset(key);
    const token = tokenFor('owner');
    const opened = await openCliMachinePresetsForRequester({
      presets: [preset],
      context: externalContext('guest'),
      token,
      credentials: {
        token,
        encryption: { type: 'dataKey', machineKey: key, publicKey },
      },
      serverUrl: 'http://account.test',
    });
    expect(opened).toEqual([
      {
        kind: 'unavailable',
        presetId: 'own-preset',
        code: 'permission_denied',
      },
    ]);
  });

  it('opens a Team preset for its recipient and reports the pending Team key for an undelivered envelope', async () => {
    const key = new Uint8Array(32).fill(64);
    const { publicKey, preset } = ownSealedPreset(key);
    const teamPreset = { ...preset, owner: { kind: 'team' as const, teamId: 'team-a' } };
    const token = tokenFor('owner');
    const request = {
      context: externalContext('owner'),
      token,
      credentials: {
        token,
        encryption: { type: 'dataKey' as const, machineKey: key, publicKey },
      },
      serverUrl: 'http://account.test',
    };
    await expect(openCliMachinePresetsForRequester({ ...request, presets: [teamPreset] })).resolves.toMatchObject([
      { kind: 'opened', presetId: preset.id, content: { name: 'Private' } },
    ]);
    await expect(openCliMachinePresetsForRequester({
      ...request, presets: [{ ...teamPreset, recipients: [] }],
    })).resolves.toEqual([
      { kind: 'unavailable', presetId: preset.id, code: 'team_preset_key_pending' },
    ]);
  });
});
