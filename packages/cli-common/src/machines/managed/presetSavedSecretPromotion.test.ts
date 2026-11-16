import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { SavedSecretResourceEnvelopeCensusRecipientV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import {
  ManagedMachinePresetV1Schema,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import {
  ManagedMachinePresetContentV1Schema,
  openManagedMachinePresetContentV1,
  openManagedMachinePresetRecipientProjectionV1,
  replaceManagedMachinePresetPreparationV1,
  sealManagedMachinePresetContentV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import {
  ManagedOpaquePresetReadV1Schema,
} from '@happier-dev/protocol/machines/managed/actionsV1';

import {
  captureManagedMachinePresetSavedSecretReferencesV1,
  prepareManagedMachinePresetSavedSecretPromotionRewritesV1,
} from './presetSavedSecretPromotion.js';

const rewrites = [{ personalSecretId: 'personal-token', resourceId: 'shared-token', resourceRevision: 1 }] as const;

function recipientCensus(accountId: string, secret: Uint8Array, envelopeStatus: 'missing' | 'prepared' = 'missing') {
  const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
  return SavedSecretResourceEnvelopeCensusRecipientV1Schema.parse({
    account: { kind: 'account', accountId, firstName: accountId, lastName: null, username: accountId, avatarUrl: null },
    readiness: { status: 'available', contentPublicKey: encodeBase64(publicKey, 'base64'),
      contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) },
    envelopeStatus,
  });
}

function presetContent(name: string, ref = 'personal-token') {
  return ManagedMachinePresetContentV1Schema.parse({
    v: 1,
    name,
    setup: { secretRefs: { v: 1, bindings: { TOKEN: { ref, ...(ref.startsWith('happier:shared-secret:') ? { revision: 1 } : {}) } } } },
  });
}

function sourcePreset() {
  return ManagedMachinePresetV1Schema.parse({
    id: 'preset-source',
    homeId: 'home',
    revision: 4,
    owner: { kind: 'account', accountId: 'owner' },
    contentEncryptionMode: 'plain',
    content: { t: 'plain', v: presetContent('Saved source') },
    recipients: [],
  });
}

function snapshot(managedId: string, presetId: string, content = presetContent('Retained snapshot')) {
  return ManagedOpaquePresetReadV1Schema.parse({
    machine: {
      id: managedId,
      homeId: 'home',
      custodianAccountId: 'owner',
      preset: { id: presetId, revision: 4, contentEncryptionMode: 'plain' },
      allocation: 'unsubmitted',
      creationState: 'active',
      desired: 'start',
      desiredWhen: 'now',
      intentRevision: 0,
      retention: { kind: 'until-delete' },
      wakeOnAcceptedMessage: false,
    },
    presetContent: { content: { t: 'plain', v: content }, recipientEnvelope: null },
  });
}

describe('managed preset Saved Secret promotion capture', () => {
  it.each(['none', 'source', 'snapshot'] as const)('captures only presets that reference the deleted secret: %s', async target => {
    const source = sourcePreset();
    const secretRef = 'happier:shared-secret:v1:deleted-secret';
    if (target === 'source') source.content = { t: 'plain', v: presetContent('Saved source', secretRef) };
    const retained = snapshot('managed-retained', source.id,
      presetContent('Retained snapshot', target === 'snapshot' ? secretRef : 'another-secret'));

    const result = await captureManagedMachinePresetSavedSecretReferencesV1({
      homeId: 'home',
      resourceRef: secretRef,
      reader: {
        accountId: 'owner',
        listPresets: async () => ({ presets: [source] }),
        listManaged: async archived => archived ? [] : [retained],
        open: ({ projection }) => projection.content.t === 'plain' ? ManagedMachinePresetContentV1Schema.parse(projection.content.v) : null,
      },
    });

    expect(result).toEqual({
      kind: 'ready',
      opaquePresetReferences: {
        presets: target === 'source' ? [{ presetId: source.id }] : [],
        snapshots: target === 'snapshot' ? [{ managedId: retained.machine.id, presetId: source.id }] : [],
      },
    });
  });

  it.each(['source', 'snapshot'] as const)('names the missing recipient envelope that prevents delete capture: %s', async target => {
    const source = ManagedMachinePresetV1Schema.parse({ ...sourcePreset(),
      contentEncryptionMode: 'e2ee', content: { t: 'encrypted', c: Buffer.alloc(64).toString('base64') }, recipients: [] });
    const retained = snapshot('managed-retained', source.id);
    retained.machine.preset.contentEncryptionMode = 'e2ee';
    retained.presetContent = { content: source.content, recipientEnvelope: null };
    expect(await captureManagedMachinePresetSavedSecretReferencesV1({
      homeId: 'home', resourceRef: 'happier:shared-secret:v1:deleted-secret',
      reader: { accountId: 'owner', listPresets: async () => ({ presets: target === 'source' ? [source] : [] }),
        listManaged: async archived => target === 'snapshot' && !archived ? [retained] : [],
        open: input => openManagedMachinePresetRecipientProjectionV1({ ...input, mode: 'e2ee',
          accountId: 'owner', accountKey: new Uint8Array(32) }) },
    })).toEqual({ kind: 'unavailable', failure: { code: 'recipient_envelope_missing',
      context: { presetId: source.id, ...(target === 'snapshot' ? { managedId: retained.machine.id } : {}) } } });
  });

  it('fresh-seals changed source presets, same-DEK rewrites retained snapshots, and reads one current-Home inventory', async () => {
    const source = sourcePreset();
    const retained = snapshot('managed-retained', source.id);
    const cursors: Array<string | undefined> = [];
    const archivedReads: boolean[] = [];
    const censusIds: string[] = [];
    const opened: string[] = [];

    const result = await prepareManagedMachinePresetSavedSecretPromotionRewritesV1({
      homeId: 'home',
      rewrites,
      randomBytes: length => new Uint8Array(length).fill(7),
      reader: {
        accountId: 'owner',
        listPresets: async cursor => {
          cursors.push(cursor);
          return cursor === undefined ? { presets: [source], cursor: 'page-2' } : { presets: [] };
        },
        listManaged: async archived => {
          archivedReads.push(archived);
          return archived ? [] : [retained];
        },
        readRecipientCensus: async input => {
          censusIds.push(input.presetId ?? '');
          return { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] };
        },
        open: ({ presetId, projection }) => {
          opened.push(presetId);
          return projection.content.t === 'plain' ? ManagedMachinePresetContentV1Schema.parse(projection.content.v) : null;
        },
        withE2eeAccountKey: () => null,
      },
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(cursors).toEqual([undefined, 'page-2']);
    expect(archivedReads).toEqual([false, true]);
    expect(censusIds).toEqual([source.id]);
    expect(opened).toEqual([source.id, source.id]);
    expect(result.opaquePresetReferences).toEqual({
      presets: [{ presetId: source.id }],
      snapshots: [{ managedId: retained.machine.id, presetId: source.id }],
    });
    expect(result.rewrites.presets).toEqual([expect.objectContaining({
      presetId: source.id,
      expectedRevision: source.revision,
      replacement: expect.objectContaining({
        content: expect.objectContaining({ t: 'plain', v: expect.objectContaining({ setup: expect.objectContaining({
          secretRefs: expect.objectContaining({ bindings: expect.objectContaining({
            TOKEN: { ref: 'happier:shared-secret:v1:shared-token', revision: 1 },
          }) }),
        }) }) }),
        recipients: [],
      }),
    })]);
    expect(result.rewrites.snapshots).toEqual([expect.objectContaining({
      managedId: retained.machine.id,
      presetId: source.id,
      expectedContentEncryptionMode: 'plain',
      expectedContent: retained.presetContent.content,
      expectedRecipientEnvelope: null,
      replacementContent: expect.objectContaining({ t: 'plain', v: expect.objectContaining({ setup: expect.objectContaining({
        secretRefs: expect.objectContaining({ bindings: expect.objectContaining({
          TOKEN: { ref: 'happier:shared-secret:v1:shared-token', revision: 1 },
        }) }),
      }) }) }),
    })]);
  });

  it('fresh-seals a prepared E2EE source for the current census without exposing the old DEK', async () => {
    const ownerSecret = new Uint8Array(32).fill(31);
    const formerSecret = new Uint8Array(32).fill(32);
    const newSecret = new Uint8Array(32).fill(33);
    const launch = { provider: { pluginId: 'test.compute', localId: 'guest' }, schemaVersion: 1,
      name: 'Guest', choices: { image: 'ubuntu' } } as const;
    const preparation = { enabled: true as const };
    const authored = { ...presetContent('Prepared source'), launch, preparation };
    let nonce = 40;
    const randomBytes = (length: number) => new Uint8Array(length).fill(nonce++);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-source', mode: 'e2ee', content: authored, randomBytes,
      recipientCensus: [recipientCensus('owner', ownerSecret), recipientCensus('former', formerSecret)],
    });
    const prepared = {
      operationId: 'prepare-promotion',
      binding: { configuration: { launch: { provider: launch.provider,
        schemaVersion: launch.schemaVersion, choices: launch.choices }, setup: authored.setup },
        cliIdentity: 'home-payload:0.3:promotion', credentialConfigurations: [] },
      status: 'building' as const,
    };
    const preparedWrite = replaceManagedMachinePresetPreparationV1({
      presetId: 'preset-source', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, randomBytes, expectedOperationId: null, prepared,
    });
    if (!preparedWrite) throw new Error('Expected prepared source fixture');
    const source = ManagedMachinePresetV1Schema.parse({
      ...sourcePreset(), contentEncryptionMode: 'e2ee', content: preparedWrite.content, recipients: sealed.recipients,
    });

    const result = await prepareManagedMachinePresetSavedSecretPromotionRewritesV1({
      homeId: 'home', rewrites, randomBytes,
      reader: {
        accountId: 'owner',
        listPresets: async () => ({ presets: [source] }),
        listManaged: async () => [],
        readRecipientCensus: async () => ({ kind: 'ready', contentEncryptionMode: 'e2ee',
          recipients: [recipientCensus('owner', ownerSecret, 'prepared'), recipientCensus('new', newSecret)] }),
        open: input => openManagedMachinePresetRecipientProjectionV1({ ...input,
          accountId: 'owner', accountKey: ownerSecret }),
        withE2eeAccountKey: operation => operation({ accountId: 'owner', accountKey: ownerSecret }),
      },
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    const replacement = result.rewrites.presets[0]?.replacement;
    if (!replacement) throw new Error('Expected source replacement');
    const expected = { ...authored, setup: { secretRefs: { v: 1 as const,
      bindings: { TOKEN: { ref: 'happier:shared-secret:v1:shared-token', revision: 1 } } } }, prepared };
    expect(openManagedMachinePresetContentV1({ presetId: source.id, mode: 'e2ee', content: replacement.content,
      recipients: replacement.recipients, accountId: 'owner', accountKey: ownerSecret })).toEqual(expected);
    expect(openManagedMachinePresetContentV1({ presetId: source.id, mode: 'e2ee', content: replacement.content,
      recipients: replacement.recipients, accountId: 'new', accountKey: newSecret })).toEqual(expected);
    expect(openManagedMachinePresetContentV1({ presetId: source.id, mode: 'e2ee', content: replacement.content,
      recipients: sealed.recipients, accountId: 'former', accountKey: formerSecret })).toBeNull();
    const oldOwner = sealed.recipients.find(recipient => recipient.accountId === 'owner');
    const newOwner = replacement.recipients.find(recipient => recipient.accountId === 'owner');
    if (!oldOwner || !newOwner) throw new Error('Expected owner envelopes');
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(newOwner.envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: ownerSecret })).not.toEqual(openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(oldOwner.envelope.encryptedDataKey), recipientSecretKeyOrSeed: ownerSecret,
    }));
  });

  it('returns unavailable rather than dispatching a partial directive when any visible opaque snapshot cannot open', async () => {
    const source = sourcePreset();
    const readable = snapshot('managed-readable', source.id);
    const unavailable = snapshot('managed-unavailable', 'preset-unavailable', presetContent('Unavailable', 'personal-unmapped'));
    const censusIds: string[] = [];

    const result = await prepareManagedMachinePresetSavedSecretPromotionRewritesV1({
      homeId: 'home',
      rewrites,
      randomBytes: length => new Uint8Array(length).fill(8),
      reader: {
        accountId: 'owner',
        listPresets: async () => ({ presets: [source] }),
        listManaged: async archived => archived ? [unavailable] : [readable],
        readRecipientCensus: async input => {
          censusIds.push(input.presetId ?? '');
          return { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] };
        },
        open: ({ presetId, projection }) => presetId === unavailable.machine.preset.id
          ? null
          : projection.content.t === 'plain' ? ManagedMachinePresetContentV1Schema.parse(projection.content.v) : null,
        withE2eeAccountKey: () => null,
      },
    });

    expect(result).toEqual({ kind: 'unavailable' });
    expect(censusIds).toEqual([source.id]);
  });
});
