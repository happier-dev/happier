import { describe, expect, it } from 'vitest';
import {
  ManagedMachinePresetV1Schema,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import {
  ManagedMachinePresetContentV1Schema,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import {
  ManagedOpaquePresetReadV1Schema,
} from '@happier-dev/protocol/machines/managed/actionsV1';

import {
  captureManagedMachinePresetSavedSecretReferencesV1,
  prepareManagedMachinePresetSavedSecretPromotionRewritesV1,
} from './presetSavedSecretPromotion.js';

const rewrites = [{ personalSecretId: 'personal-token', resourceId: 'shared-token', resourceRevision: 1 }] as const;

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

  it('refuses delete capture when a sealed preset cannot be opened', async () => {
    expect(await captureManagedMachinePresetSavedSecretReferencesV1({
      homeId: 'home', resourceRef: 'happier:shared-secret:v1:deleted-secret',
      reader: { accountId: 'owner', listPresets: async () => ({ presets: [sourcePreset()] }),
        listManaged: async () => [], open: () => null },
    })).toEqual({ kind: 'unavailable' });
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
