import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '../../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../identity/contentPublicKeyFingerprint.js';
import * as preset from './managedMachinePresetContentV1.js';

const content = {
  v: 1 as const, name: 'Prepared preset', preparation: { enabled: true },
  launch: { provider: { pluginId: 'test.compute', localId: 'guest' }, schemaVersion: 1,
    name: 'Guest', choices: { image: 'ubuntu' } },
  setup: { scripts: [{ body: 'echo prepared', affects: 'none' as const }] },
};
const reference = { contributionRef: content.launch.provider, schemaVersion: 1, value: { id: 'image-1' } };
const binding = {
  presetRevision: 3,
  configuration: { launch: { provider: content.launch.provider, schemaVersion: 1, choices: content.launch.choices },
    setup: content.setup },
  cliIdentity: 'home-payload:0.3:abc', credentialIdentity: 'connected-account:one',
};
const prepared = { operationId: 'prepare-1', binding, status: 'ready' as const, artifact: reference, bakedSetup: content.setup };

describe('private prepared preset content', () => {
  it('reads retained prepared state while rejecting author-forged operational bindings', () => {
    expect(preset.ManagedMachinePresetContentV1Schema.safeParse({ ...content, prepared }).success).toBe(true);
    expect(() => preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain',
      content: { ...content, prepared } })).toThrow('managed_preset_author_prepared_forbidden');
    expect(preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content }).content)
      .toEqual({ t: 'plain', v: content });
  });

  it.each(['plain', 'e2ee'] as const)('roundtrips private bindings in %s and rejects an acquire override changing them', mode => {
    const secret = new Uint8Array(32).fill(4);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
    let nonce = 10;
    const randomBytes = (length: number) => new Uint8Array(length).fill(nonce++);
    const sealed = mode === 'plain'
      ? preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content })
      : preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content, randomBytes,
        recipientCensus: [{ account: { kind: 'account', accountId: 'owner', firstName: 'Owner',
          lastName: null, username: 'owner', avatarUrl: null }, readiness: { status: 'available',
          contentPublicKey: encodeBase64(publicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'missing' }] });
    const auth = mode === 'plain' ? { mode } : { mode, accountId: 'owner', accountKey: secret,
      recipients: sealed.recipients, randomBytes };
    const next = preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset',
      ...auth, content: sealed.content, expectedOperationId: null, prepared });
    expect(next).not.toBeNull();
    const opened = preset.openManagedMachinePresetContentV1({ presetId: 'preset', ...auth, content: next });
    expect(opened).toEqual({ ...content, prepared });
    expect(preset.resolveManagedMachinePresetAcquireOverrideV1({ baseContent: opened,
      overrideContent: { ...opened, launch: { ...content.launch, name: 'Session name' },
        prepared: { ...prepared, artifact: { ...reference, value: { id: 'forged' } } } } })).toBeNull();
    expect(preset.resolveManagedMachinePresetAcquireOverrideV1({ baseContent: opened,
      overrideContent: { ...opened, launch: { ...content.launch, name: 'Session name' } } }))
      .toEqual({ launchName: 'Session name' });
    const newer = preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset', ...auth,
      content: next, expectedOperationId: 'prepare-1', prepared: { ...prepared, operationId: 'prepare-2', status: 'building' } });
    expect(preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset', ...auth,
      content: newer, expectedOperationId: 'prepare-1', prepared })).toBeNull();
    expect(preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset', ...auth,
      content: next, expectedOperationId: 'prepare-1', prepared: { ...prepared,
        artifact: { ...reference, contributionRef: { pluginId: 'other.compute', localId: 'guest' } } } })).toBeNull();
  });
});
