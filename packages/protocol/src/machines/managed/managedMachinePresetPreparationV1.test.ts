import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { openEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { computeContentPublicKeyFingerprint } from '../identity/contentPublicKeyFingerprint.js';
import * as preset from './managedMachinePresetContentV1.js';
import { MachineProvisionerPreparationBuildResultV1Schema } from '../../plugins/contributions/machineProvisionerPreparationSchemas.js';

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
  cliIdentity: 'home-payload:0.3:abc',
};
const prepared = { operationId: 'prepare-1', binding, status: 'ready' as const, artifact: reference,
  cliBinaryPath: '/opt/happier/cli/current/happier', bakedSetup: content.setup };

describe('private prepared preset content', () => {
  it.each(['plain', 'e2ee'] as const)('refuses unreviewed or foreign provider/schema/Account execution through the real %s sealer', mode => {
    const secret = new Uint8Array(32).fill(4);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
    let nonce = 80;
    const randomBytes = (length: number) => new Uint8Array(length).fill(nonce++);
    const launch = { ...content.launch, credentials: [{ purpose: { consumer: content.launch.provider, purpose: 'compute' },
      account: { service: { pluginId: 'test.service', localId: 'compute' }, accountId: 'selected-account' } }] };
    const source = { ...content, launch };
    const sealed = mode === 'plain' ? preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content: source })
      : preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content: source, randomBytes,
        recipientCensus: [{ account: { kind: 'account', accountId: 'owner', firstName: 'Owner',
          lastName: null, username: 'owner', avatarUrl: null }, readiness: { status: 'available',
          contentPublicKey: encodeBase64(publicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'missing' }] });
    const auth = mode === 'plain' ? { mode } : { mode, accountId: 'owner', accountKey: secret,
      recipients: sealed.recipients, randomBytes };
    const effectiveLaunch = { ...launch, choices: { image: 'selected-owned-artifact' } };
    const preparationExecution = { launch: effectiveLaunch, binaryPath: '/opt/happier/cli/current/happier' };
    const review = (selectedLaunch: typeof launch) => ({ launch: selectedLaunch, optionStatus: 'current' as const,
      billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
      retentionCapabilities: { supportedIntents: ['start', 'delete'] }, prerequisites: [],
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false });
    const replacement = { presetId: 'preset', ...auth, content: sealed.content, launchName: launch.name };
    expect(preset.replaceManagedMachinePresetLaunchNameV1({ ...replacement, preparationExecution,
      reviewedFacts: review(effectiveLaunch) })).not.toBeNull();
    expect.soft(preset.replaceManagedMachinePresetLaunchNameV1({ ...replacement, preparationExecution }), 'missing review').toBeNull();
    const foreignSelections: Array<readonly [string, typeof launch]> = [
      ['provider', { ...effectiveLaunch, provider: { pluginId: 'other.compute', localId: 'guest' } }],
      ['schema', { ...effectiveLaunch, schemaVersion: 2 }],
      ['Account', { ...effectiveLaunch, credentials: [{ ...launch.credentials[0]!,
        account: { ...launch.credentials[0]!.account, accountId: 'foreign-account' } }] }],
    ];
    for (const [label, selectedLaunch] of foreignSelections) {
      expect.soft(preset.replaceManagedMachinePresetLaunchNameV1({ ...replacement,
        preparationExecution: { ...preparationExecution, launch: selectedLaunch }, reviewedFacts: review(selectedLaunch) }), label).toBeNull();
    }
  });

  it.each(['plain', 'e2ee'] as const)('refuses forged %s execution and drops per-Machine execution when editing the reusable author body', mode => {
    const secret = new Uint8Array(32).fill(4);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
    let nonce = 50;
    const randomBytes = (length: number) => new Uint8Array(length).fill(nonce++);
    const recipientCensus = [{ account: { kind: 'account' as const, accountId: 'owner', firstName: 'Owner',
      lastName: null, username: 'owner', avatarUrl: null }, readiness: { status: 'available' as const,
      contentPublicKey: encodeBase64(publicKey, 'base64'),
      contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'missing' as const }];
    const sealed = mode === 'plain' ? preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content })
      : preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content, recipientCensus, randomBytes });
    const auth = mode === 'plain' ? { mode } : { mode, accountId: 'owner', accountKey: secret,
      recipients: sealed.recipients, randomBytes };
    const preparationExecution = { launch: { ...content.launch, choices: { image: 'selected-owned-artifact' } },
      binaryPath: '/opt/happier/cli/current/happier', deferredSetup: content.setup };
    const reviewedFacts = { launch: preparationExecution.launch, optionStatus: 'current' as const,
      billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
      retentionCapabilities: { supportedIntents: ['start', 'delete'] }, prerequisites: [],
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
    const admitted = preset.replaceManagedMachinePresetLaunchNameV1({ presetId: 'preset', ...auth,
      content: sealed.content, launchName: content.launch.name, preparationExecution, reviewedFacts });
    expect(admitted).not.toBeNull();
    const opened = preset.openManagedMachinePresetContentV1({ presetId: 'preset', ...auth, content: admitted });
    expect(opened).toMatchObject({ launch: content.launch, setup: content.setup, preparationExecution });
    expect(preset.resolveManagedMachinePresetAcquireOverrideV1({ baseContent: content,
      overrideContent: { ...content, preparationExecution } })).toBeNull();
    expect(preset.resolveManagedMachinePresetSetupOverrideV1({ baseContent: opened,
      overrideContent: { ...opened, preparationExecution: { ...preparationExecution, binaryPath: '/forged-path' } } })).toBeNull();
    const projection = preset.projectManagedMachinePresetForRecipientV1({ content: admitted,
      recipients: sealed.recipients, recipientAccountId: 'owner' });
    const replacement = { presetId: 'preset', projection, content: { ...content, name: 'Edited author' } };
    const authored = mode === 'plain' ? preset.replaceManagedMachinePresetAuthorContentV1({ ...replacement, mode })
      : preset.replaceManagedMachinePresetAuthorContentV1({ ...replacement, mode,
        accountId: 'owner', accountKey: secret, recipientCensus, randomBytes });
    expect(authored).not.toBeNull();
    const authoredOpened = mode === 'plain'
      ? preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode, content: authored?.content })
      : preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode, content: authored?.content,
        recipients: authored?.recipients ?? [], accountId: 'owner', accountKey: secret });
    expect(authoredOpened).toEqual(replacement.content);
    const forged = { ...content, preparationExecution, reviewedFacts };
    expect(mode === 'plain'
      ? preset.replaceManagedMachinePresetAuthorContentV1({ ...replacement, mode, content: forged })
      : preset.replaceManagedMachinePresetAuthorContentV1({ ...replacement, mode, content: forged,
        accountId: 'owner', accountKey: secret, recipientCensus, randomBytes })).toBeNull();
    expect(() => mode === 'plain'
      ? preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content: forged })
      : preset.sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content: forged, recipientCensus, randomBytes }))
      .toThrow('managed_preset_author_reviewed_facts_forbidden');
  });

  it('accepts canonical Account selections without a second credential identity', () => {
    const { name: _name, ...launch } = content.launch;
    expect(preset.ManagedMachinePresetContentV1Schema.safeParse({ ...content, prepared: { ...prepared,
      binding: { presetRevision: binding.presetRevision, cliIdentity: binding.cliIdentity,
        configuration: { ...binding.configuration, launch: { ...launch, credentials: [{
          purpose: { consumer: launch.provider, purpose: 'compute' },
          account: { service: { pluginId: 'test.service', localId: 'compute' }, accountId: 'provider-account' },
        }] } } } } }).success).toBe(true);
  });
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
    const nativeResult = MachineProvisionerPreparationBuildResultV1Schema.parse({ kind: 'ready',
      artifact: { ...reference, value: { id: 'image-1', layers: [['portable-cli']] } } });
    if (nativeResult.kind !== 'ready') throw new Error('fixture must be ready');
    const writerPrepared = { ...prepared, artifact: nativeResult.artifact };
    const next = preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset',
      ...auth, content: sealed.content, expectedOperationId: null, prepared: writerPrepared });
    expect(next).not.toBeNull();
    expect(next?.prepared).toEqual(writerPrepared);
    const opened = preset.openManagedMachinePresetContentV1({ presetId: 'preset', ...auth, content: next?.content });
    expect(opened).toEqual({ ...content, prepared: writerPrepared });
    expect(preset.resolveManagedMachinePresetAcquireOverrideV1({ baseContent: opened,
      overrideContent: { ...opened, launch: { ...content.launch, name: 'Session name' },
        prepared: { ...prepared, artifact: { ...reference, value: { id: 'forged' } } } } })).toBeNull();
    expect(preset.resolveManagedMachinePresetAcquireOverrideV1({ baseContent: opened,
      overrideContent: { ...opened, launch: { ...content.launch, name: 'Session name' } } }))
      .toEqual({ launchName: 'Session name' });
    const projection = preset.projectManagedMachinePresetForRecipientV1({
      content: next?.content,
      recipients: sealed.recipients,
      recipientAccountId: 'owner',
    });
    const authorDisabled = mode === 'plain'
      ? preset.replaceManagedMachinePresetAuthorContentV1({ presetId: 'preset', mode, projection,
        content: { ...content, preparation: { enabled: false } } })
      : preset.replaceManagedMachinePresetAuthorContentV1({ presetId: 'preset', mode, projection,
        content: { ...content, preparation: { enabled: false } }, accountId: 'owner', accountKey: secret,
        recipientCensus: [{ account: { kind: 'account', accountId: 'owner', firstName: 'Owner',
          lastName: null, username: 'owner', avatarUrl: null }, readiness: { status: 'available',
          contentPublicKey: encodeBase64(publicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'prepared' }],
        randomBytes });
    expect(authorDisabled).not.toBeNull();
    expect(mode === 'plain'
      ? preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode, content: authorDisabled?.content })
      : preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode,
        content: authorDisabled?.content, recipients: authorDisabled?.recipients ?? [],
        accountId: 'owner', accountKey: secret }))
      .toEqual({ ...content, preparation: { enabled: false }, prepared: writerPrepared });
    expect(mode === 'plain'
      ? preset.replaceManagedMachinePresetAuthorContentV1({ presetId: 'preset', mode, projection,
        content: { ...content, prepared: { ...prepared, operationId: 'forged-author-operation' } } })
      : preset.replaceManagedMachinePresetAuthorContentV1({ presetId: 'preset', mode, projection,
        content: { ...content, prepared: { ...prepared, operationId: 'forged-author-operation' } },
        accountId: 'owner', accountKey: secret,
        recipientCensus: [{ account: { kind: 'account', accountId: 'owner', firstName: 'Owner',
          lastName: null, username: 'owner', avatarUrl: null }, readiness: { status: 'available',
          contentPublicKey: encodeBase64(publicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'prepared' }],
        randomBytes })).toBeNull();
    const { artifact: _artifact, bakedSetup: _bakedSetup, ...pendingPreparation } = prepared;
    const newer = preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset', ...auth,
      content: next?.content, expectedOperationId: 'prepare-1', prepared: { ...pendingPreparation,
        operationId: 'prepare-2', status: 'building', buildSetup: content.setup } });
    expect(newer).not.toBeNull();
    const pending = preset.openManagedMachinePresetContentV1({ presetId: 'preset', ...auth, content: newer?.content });
    expect(pending?.prepared).toMatchObject({ status: 'building', buildSetup: content.setup });
    expect(pending?.prepared).not.toHaveProperty('bakedSetup');
    expect(preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset', ...auth,
      content: newer?.content, expectedOperationId: 'prepare-1', prepared })).toBeNull();
    expect(preset.replaceManagedMachinePresetPreparationV1({ presetId: 'preset', ...auth,
      content: next?.content, expectedOperationId: 'prepare-1', prepared: { ...prepared,
        artifact: { ...reference, contributionRef: { pluginId: 'other.compute', localId: 'guest' } } } })).toBeNull();
  });

  it('rotates the authored E2EE DEK to the current recipient census while retaining operational state', () => {
    const ownerSecret = new Uint8Array(32).fill(4);
    const formerSecret = new Uint8Array(32).fill(5);
    const newSecret = new Uint8Array(32).fill(6);
    const censusRecipient = (accountId: string, secret: Uint8Array, envelopeStatus: 'missing' | 'prepared') => {
      const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
      return {
        account: { kind: 'account' as const, accountId, firstName: accountId,
          lastName: null, username: accountId, avatarUrl: null },
        readiness: { status: 'available' as const, contentPublicKey: encodeBase64(publicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) },
        envelopeStatus,
      };
    };
    let nonce = 20;
    const randomBytes = (length: number) => new Uint8Array(length).fill(nonce++);
    const initial = preset.sealManagedMachinePresetContentV1({
      presetId: 'preset', mode: 'e2ee', content, randomBytes,
      recipientCensus: [
        censusRecipient('owner', ownerSecret, 'missing'),
        censusRecipient('former', formerSecret, 'missing'),
      ],
    });
    const preparedWrite = preset.replaceManagedMachinePresetPreparationV1({
      presetId: 'preset', mode: 'e2ee', content: initial.content, recipients: initial.recipients,
      accountId: 'owner', accountKey: ownerSecret, randomBytes, expectedOperationId: null, prepared,
    });
    if (!preparedWrite) throw new Error('fixture must retain prepared state');
    const projection = preset.projectManagedMachinePresetForRecipientV1({
      content: preparedWrite.content, recipients: initial.recipients, recipientAccountId: 'owner',
    });
    const authored = preset.replaceManagedMachinePresetAuthorContentV1({
      presetId: 'preset', mode: 'e2ee', projection, accountId: 'owner', accountKey: ownerSecret,
      content: { ...content, name: 'Edited preset' }, randomBytes,
      recipientCensus: [
        censusRecipient('owner', ownerSecret, 'prepared'),
        censusRecipient('new-member', newSecret, 'missing'),
      ],
    });
    if (!authored) throw new Error('authored replacement must succeed');
    const openDataKey = (encryptedDataKey: string, secret: Uint8Array) => openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(encryptedDataKey), recipientSecretKeyOrSeed: secret,
    });
    const initialOwner = initial.recipients.find(recipient => recipient.accountId === 'owner');
    const authoredOwner = authored.recipients.find(recipient => recipient.accountId === 'owner');
    if (!initialOwner || !authoredOwner) throw new Error('owner envelope missing');
    expect(openDataKey(authoredOwner.envelope.encryptedDataKey, ownerSecret))
      .not.toEqual(openDataKey(initialOwner.envelope.encryptedDataKey, ownerSecret));
    expect(preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode: 'e2ee',
      content: authored.content, recipients: authored.recipients,
      accountId: 'owner', accountKey: ownerSecret }))
      .toEqual({ ...content, name: 'Edited preset', prepared });
    expect(preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode: 'e2ee',
      content: authored.content, recipients: authored.recipients,
      accountId: 'new-member', accountKey: newSecret }))
      .toEqual({ ...content, name: 'Edited preset', prepared });
    expect(preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode: 'e2ee',
      content: authored.content, recipients: authored.recipients,
      accountId: 'former', accountKey: formerSecret })).toBeNull();
    expect(preset.openManagedMachinePresetContentV1({ presetId: 'preset', mode: 'e2ee',
      content: authored.content, recipients: initial.recipients,
      accountId: 'former', accountKey: formerSecret })).toBeNull();
  });
});
