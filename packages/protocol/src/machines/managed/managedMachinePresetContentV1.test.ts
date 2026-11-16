import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { openEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { computeContentPublicKeyFingerprint } from '../identity/contentPublicKeyFingerprint.js';
import { SavedSecretResourceEnvelopeCensusRecipientV1Schema, SavedSecretResourceRecipientEnvelopeV1Schema } from '../../account/settings/savedSecretCatalogV1.js';
import { ManagedConfigurationFactsV1Schema } from './managedConfigurationV1.js';
import * as managedPresetContent from './managedMachinePresetContentV1.js';
import { createManagedMachinePresetAcquireOverrideV1, createManagedMachinePresetEnrollmentIdentityOverrideV1,
  createManagedMachinePresetLaunchNameOverrideV1,
  createManagedMachinePresetResizeOverrideV1, createManagedMachinePresetSetupOverrideV1,
  createManagedMachinePresetSavedSecretSourceReferenceRewriteV1,
  createManagedMachinePresetSavedSecretReferenceRewriteV1,
  ManagedMachinePresetRecipientProjectionV1Schema,
  openManagedMachinePresetContentV1,
  openManagedMachinePresetRecipientProjectionV1, projectManagedMachinePresetForRecipientV1,
  readManagedMachinePresetContentOverrideForModeV1, readManagedMachinePresetLaunchNameOverrideForModeV1,
  replaceManagedMachinePresetPreparationV1,
  replaceManagedMachinePresetLaunchNameV1, replaceManagedMachinePresetResizeV1,
  replaceManagedMachinePresetSetupV1, resolveManagedMachinePresetAcquireOverrideV1,
  resolveManagedMachinePresetEnrollmentIdentityOverrideV1,
  resolveManagedMachinePresetLaunchNameOverrideV1,
  resolveManagedMachinePresetResizeOverrideV1,
  resolveManagedMachinePresetSetupOverrideV1,
  rewrapManagedMachinePresetRecipientsV1, rewriteManagedMachinePresetSavedSecretReferencesV1,
  transitionManagedMachinePresetContentEncryptionModeV1, sealManagedMachinePresetContentV1,
  ManagedMachinePresetContentV1Schema, ManagedMachinePresetEnvelopeV1Schema,
  ManagedMachinePresetRecipientV1Schema } from './managedMachinePresetContentV1.js';

const content = {
  v: 1 as const,
  name: 'Team guest',
  launch: {
    provider: { pluginId: 'custom.compute', localId: 'vm' },
    schemaVersion: 1,
    name: 'Guest',
    choices: { image: 'ubuntu' },
  },
  setup: { scripts: [{ body: 'echo setup', affects: 'none' as const }] },
  controllerDisplayName: 'Controller',
};

const reviewedFacts = ManagedConfigurationFactsV1Schema.parse({
  launch: content.launch,
  optionStatus: 'current',
  prerequisites: [],
  billing: { location: 'local', stoppedBilling: 'not-billed' },
  retentionCapabilities: { supportedIntents: ['delete'] },
  retention: { kind: 'until-delete' },
  wakeOnAcceptedMessage: false,
});

function randomBytesFactory(initialValue = 1): (length: number) => Uint8Array {
  let value = initialValue;
  return (length) => new Uint8Array(length).fill(value++);
}

function recipientCensus(accountId: string, secret: Uint8Array, envelopeStatus: 'prepared' | 'missing' | 'stale' | 'invalid' = 'missing') {
  const publicKey = tweetnacl.box.keyPair.fromSecretKey(secret).publicKey;
  return SavedSecretResourceEnvelopeCensusRecipientV1Schema.parse({
    account: { kind: 'account', accountId, firstName: accountId, lastName: null, username: accountId, avatarUrl: null },
    readiness: {
      status: 'available',
      contentPublicKey: encodeBase64(publicKey, 'base64'),
      contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey),
    },
    envelopeStatus,
  });
}

function unavailableRecipientCensus(accountId: string) {
  return SavedSecretResourceEnvelopeCensusRecipientV1Schema.parse({
    account: { kind: 'account', accountId, firstName: accountId, lastName: null, username: accountId, avatarUrl: null },
    readiness: { status: 'unavailable', reason: 'encryption_setup_required' },
    envelopeStatus: 'missing',
  });
}

describe('managed machine preset content envelope', () => {
  it('keeps Setup Retry facts encrypted under the existing snapshot key and refuses a wrong-mode rewrite', () => {
    const accountKey = new Uint8Array(32).fill(71);
    const randomBytes = randomBytesFactory(10);
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'bound-setup', mode: 'e2ee', content,
      recipientCensus: [recipientCensus('owner', accountKey)], randomBytes });
    const sourceFacts = { 'private-source': { pendingScripts: [1] } };
    const rewritten = replaceManagedMachinePresetLaunchNameV1({ presetId: 'bound-setup', mode: 'e2ee',
      content: sealed.content, recipients: sealed.recipients, accountId: 'owner', accountKey,
      launchName: content.launch.name, setupSourceFacts: sourceFacts, randomBytes });
    expect(rewritten?.t).toBe('encrypted');
    expect(JSON.stringify(rewritten)).not.toContain('private-source');
    expect(openManagedMachinePresetContentV1({ presetId: 'bound-setup', mode: 'e2ee', content: rewritten,
      recipients: sealed.recipients, accountId: 'owner', accountKey })).toMatchObject({ setupSourceFacts: sourceFacts });
    expect(replaceManagedMachinePresetLaunchNameV1({ presetId: 'bound-setup', mode: 'plain',
      content: sealed.content, launchName: content.launch.name, setupSourceFacts: sourceFacts })).toBeNull();
    expect(() => sealManagedMachinePresetContentV1({ presetId: 'author', mode: 'plain',
      content: { ...content, setupSourceFacts: sourceFacts } })).toThrow();
  });

  it('requires at least one private preset body alongside its name', () => {
    expect(ManagedMachinePresetContentV1Schema.safeParse({ v: 1, name: 'empty' }).success).toBe(false);
  });

  it('migrates a full retained preset body across Account modes without passing daemon fields through fresh author sealing', () => {
    const transition = Reflect.get(managedPresetContent, 'transitionManagedMachinePresetContentEncryptionModeV1');
    expect(transition).toBeTypeOf('function');
    if (typeof transition !== 'function') return;

    const snapshot = ManagedMachinePresetContentV1Schema.parse({
      ...content,
      enrollmentIdentity: {
        kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
        adminAccessAtCreation: 'ask', administrator: { username: 'private-migration-admin' },
      },
      reviewedFacts,
      setupSourceFacts: { 'private-source': { pendingScripts: [1] } },
      nativeResult: {
        kind: 'bound',
        resource: {
          contributionRef: content.launch.provider, schemaVersion: content.launch.schemaVersion,
          value: { namespace: 'private-migration-namespace', transport: 'private-migration-transport', backendId: 'private-migration-id' },
        },
      },
      observation: {
        observedAt: 123, availability: 'present', power: 'running',
        size: { cpuCores: 8 },
        nativeCause: { localCause: 'native_command_failed', command: 'create', exitCode: 1, stderr: '/private/migration/stderr' },
      },
      nativeControlResult: { kind: 'power', intent: 'start', result: { kind: 'confirmed' } },
      resize: { cpuCores: 16 },
    });
    const targetSecret = new Uint8Array(32).fill(81);
    const encrypted = transition({
      presetId: 'preset-mode-transition', fromMode: 'plain', toMode: 'e2ee',
      source: { content: { t: 'plain', v: snapshot }, recipientEnvelope: null },
      accountId: 'owner', targetContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(targetSecret).publicKey,
      randomBytes: randomBytesFactory(520),
    });
    expect(encrypted).not.toBeNull();
    expect(encrypted?.recipients).toHaveLength(1);
    expect(encrypted?.recipients[0]?.accountId).toBe('owner');
    expect(JSON.stringify(encrypted?.content)).not.toContain('private-migration-admin');
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-mode-transition', mode: 'e2ee', content: encrypted?.content,
      recipients: encrypted?.recipients ?? [], accountId: 'owner', accountKey: targetSecret,
    })).toEqual(snapshot);

    const sourceDataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(encrypted?.recipients[0]?.envelope.encryptedDataKey ?? ''),
      recipientSecretKeyOrSeed: targetSecret,
    });
    if (!sourceDataKey || !encrypted) throw new Error('Expected source data key');
    expect(transition({
      presetId: 'preset-mode-transition', fromMode: 'e2ee', toMode: 'plain',
      source: { content: encrypted.content, recipientEnvelope: encrypted.recipients[0]!.envelope },
      sourceDataKey: new Uint8Array(sourceDataKey.length).fill(99),
    })).toBeNull();
    expect(transition({
      presetId: 'preset-mode-transition', fromMode: 'e2ee', toMode: 'plain',
      source: { content: encrypted.content, recipientEnvelope: encrypted.recipients[0]!.envelope },
      sourceDataKey,
    })).toEqual({ content: { t: 'plain', v: snapshot }, recipients: [] });
    const rotated = transition({
      presetId: 'preset-mode-transition', fromMode: 'plain', toMode: 'e2ee',
      source: { content: { t: 'plain', v: snapshot }, recipientEnvelope: null },
      accountId: 'owner', targetContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(targetSecret).publicKey,
      randomBytes: randomBytesFactory(530),
    });
    const rotatedKey = rotated && openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(rotated.recipients[0]?.envelope.encryptedDataKey ?? ''),
      recipientSecretKeyOrSeed: targetSecret,
    });
    expect(rotatedKey).not.toEqual(sourceDataKey);
  });

  it('seals retained native facts without inventing a historical admission review', () => {
    const secret = new Uint8Array(32).fill(84);
    const retained = { ...content, nativeResult: { kind: 'bound', resource: {
      contributionRef: content.launch.provider, schemaVersion: content.launch.schemaVersion,
      value: { instance: 'retained-private-native' },
    } }, observation: { observedAt: 123, availability: 'present', power: 'running' } };
    const source = { content: { t: 'plain', v: retained }, recipientEnvelope: null };
    const encrypted = transitionManagedMachinePresetContentEncryptionModeV1({
      presetId: 'legacy-without-review', fromMode: 'plain', toMode: 'e2ee', source,
      accountId: 'owner', targetContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(secret).publicKey,
      randomBytes: randomBytesFactory(61),
    });
    expect(encrypted).not.toBeNull();
    if (!encrypted) throw new Error('Expected retained native seal');
    expect(JSON.stringify(encrypted)).not.toContain('retained-private-native');
    expect(openManagedMachinePresetContentV1({ presetId: 'legacy-without-review', mode: 'e2ee',
      content: encrypted.content, recipients: encrypted.recipients, accountId: 'owner', accountKey: secret,
    })).toEqual(retained);
    expect(transitionManagedMachinePresetContentEncryptionModeV1({
      presetId: 'legacy-without-review', fromMode: 'plain', toMode: 'plain', source,
    })).toEqual({ content: source.content, recipients: [] });
    expect(() => sealManagedMachinePresetContentV1({ presetId: 'legacy-without-review', mode: 'plain', content: retained }))
      .toThrow('managed_preset_author_native_result_forbidden');
  });
  it('rewrites promoted Saved Secret references through the private content owner without losing a retained snapshot', () => {
    const transition = Reflect.get(managedPresetContent, 'transitionManagedMachinePresetContentEncryptionModeV1');
    expect(transition).toBeTypeOf('function');
    if (typeof transition !== 'function') return;

    const rewrites = [{ personalSecretId: 'personal-token', resourceId: 'shared-token', resourceRevision: 1 }];
    const source = ManagedMachinePresetContentV1Schema.parse({
      ...content,
      setup: {
        ...content.setup,
        secretRefs: {
          v: 1,
          bindings: {
            TOKEN: { ref: 'personal-token' },
            UNTOUCHED: { ref: 'personal-unmapped' },
          },
        },
      },
    });
    const rewrittenSource = rewriteManagedMachinePresetSavedSecretReferencesV1({ content: source, rewrites });
    const expectedSource = ManagedMachinePresetContentV1Schema.parse({
      ...source,
      setup: {
        ...source.setup,
        secretRefs: {
          v: 1,
          bindings: {
            TOKEN: { ref: 'happier:shared-secret:v1:shared-token', revision: 1 },
            UNTOUCHED: { ref: 'personal-unmapped' },
          },
        },
      },
    });
    expect(rewrittenSource).toEqual(expectedSource);
    expect(rewriteManagedMachinePresetSavedSecretReferencesV1({
      content: source,
      rewrites: [{ personalSecretId: 'personal-token', resourceId: 'shared-token', resourceRevision: 0 }],
    })).toBeNull();

    const ownerSecret = new Uint8Array(32).fill(82);
    const formerSecret = new Uint8Array(32).fill(83);
    const newSecret = new Uint8Array(32).fill(84);
    const preparation = { enabled: true as const };
    const prepared = {
      operationId: 'promotion-prepare',
      binding: {
        presetRevision: 4,
        configuration: { launch: { provider: source.launch!.provider, schemaVersion: source.launch!.schemaVersion,
          choices: source.launch!.choices }, setup: source.setup },
        cliIdentity: 'home-payload:0.3:promotion',
      },
      status: 'building' as const,
    };
    const initialSourceWrite = sealManagedMachinePresetContentV1({
      presetId: 'preset-promoted-source',
      mode: 'e2ee',
      content: { ...source, preparation },
      recipientCensus: [recipientCensus('owner', ownerSecret), recipientCensus('former', formerSecret)],
      randomBytes: randomBytesFactory(540),
    });
    const retainedSourceWrite = replaceManagedMachinePresetPreparationV1({
      presetId: 'preset-promoted-source', mode: 'e2ee', content: initialSourceWrite.content,
      recipients: initialSourceWrite.recipients, accountId: 'owner', accountKey: ownerSecret,
      expectedOperationId: null, prepared, randomBytes: randomBytesFactory(541),
    });
    if (!retainedSourceWrite) throw new Error('Expected retained source fixture');
    const sourceRewrite = createManagedMachinePresetSavedSecretSourceReferenceRewriteV1({
      presetId: 'preset-promoted-source', mode: 'e2ee',
      projection: projectManagedMachinePresetForRecipientV1({ content: retainedSourceWrite.content,
        recipients: initialSourceWrite.recipients, recipientAccountId: 'owner' }),
      accountId: 'owner', accountKey: ownerSecret, rewrites,
      recipientCensus: [recipientCensus('owner', ownerSecret, 'prepared'), recipientCensus('new', newSecret)],
      randomBytes: randomBytesFactory(542),
    });
    expect(sourceRewrite).not.toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-promoted-source', mode: 'e2ee', content: sourceRewrite?.content,
      recipients: sourceRewrite?.recipients ?? [], accountId: 'owner', accountKey: ownerSecret,
    })).toEqual({ ...expectedSource, preparation, prepared });
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-promoted-source', mode: 'e2ee', content: sourceRewrite?.content,
      recipients: sourceRewrite?.recipients ?? [], accountId: 'new', accountKey: newSecret,
    })).toEqual({ ...expectedSource, preparation, prepared });
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-promoted-source', mode: 'e2ee', content: sourceRewrite?.content,
      recipients: initialSourceWrite.recipients, accountId: 'former', accountKey: formerSecret,
    })).toBeNull();

    const retained = ManagedMachinePresetContentV1Schema.parse({
      ...source,
      enrollmentIdentity: {
        kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
        adminAccessAtCreation: 'ask', administrator: { username: 'private-promotion-admin' },
      },
      reviewedFacts: {
        ...reviewedFacts,
        launch: source.launch,
      },
      nativeResult: {
        kind: 'bound',
        resource: {
          contributionRef: source.launch.provider, schemaVersion: source.launch.schemaVersion,
          value: { namespace: 'private-promotion-namespace', transport: 'private-promotion-transport', backendId: 'private-promotion-id' },
        },
      },
      observation: {
        observedAt: 456, availability: 'present', power: 'running', size: { cpuCores: 8 },
        nativeCause: { localCause: 'native_command_failed', command: 'create', exitCode: 1, stderr: '/private/promotion/stderr' },
      },
      nativeControlResult: { kind: 'power', intent: 'start', result: { kind: 'confirmed' } },
      resize: { cpuCores: 16 },
    });
    const storedSnapshot = transition({
      presetId: 'preset-promoted-snapshot', fromMode: 'plain', toMode: 'e2ee',
      source: { content: { t: 'plain', v: retained }, recipientEnvelope: null },
      accountId: 'owner', targetContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(ownerSecret).publicKey,
      randomBytes: randomBytesFactory(550),
    });
    if (!storedSnapshot) throw new Error('Expected encrypted retained snapshot');
    const projection = projectManagedMachinePresetForRecipientV1({
      content: storedSnapshot.content, recipients: storedSnapshot.recipients, recipientAccountId: 'owner',
    });
    const rewrittenSnapshot = createManagedMachinePresetSavedSecretReferenceRewriteV1({
      presetId: 'preset-promoted-snapshot', mode: 'e2ee', projection,
      accountId: 'owner', accountKey: ownerSecret, rewrites, randomBytes: randomBytesFactory(560),
    });
    expect(rewrittenSnapshot).not.toBeNull();
    expect(createManagedMachinePresetSavedSecretReferenceRewriteV1({
      presetId: 'preset-promoted-snapshot', mode: 'e2ee', projection,
      accountId: 'owner', accountKey: new Uint8Array(32).fill(83), rewrites, randomBytes: randomBytesFactory(570),
    })).toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-promoted-snapshot', mode: 'e2ee', content: rewrittenSnapshot?.content,
      recipients: storedSnapshot.recipients, accountId: 'owner', accountKey: ownerSecret,
    })).toEqual({
      ...retained,
      setup: expectedSource.setup,
    });
  });

  it('seals an acquire-only enrollment identity override and rejects every other private drift', () => {
    const enrollmentIdentity = {
      kind: 'dedicatedDaemonUser' as const,
      username: 'happier' as const,
      serviceMode: 'user' as const,
      role: 'server' as const,
      adminAccessAtCreation: 'ask' as const,
      administrator: { username: 'private-admin-user' },
    };

    expect(ManagedMachinePresetContentV1Schema.safeParse({ ...content, enrollmentIdentity }).success).toBe(true);
    const ownerSecret = new Uint8Array(32).fill(78);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-enrollment-identity',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(430),
    });
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-enrollment-identity',
      mode: 'e2ee',
      content: { ...content, enrollmentIdentity },
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(440),
    })).toThrow('managed_preset_author_enrollment_identity_forbidden');

    const projection = projectManagedMachinePresetForRecipientV1({
      content: sealed.content,
      recipients: sealed.recipients,
      recipientAccountId: 'owner',
    });
    const override = createManagedMachinePresetEnrollmentIdentityOverrideV1({
      presetId: 'preset-enrollment-identity',
      mode: 'e2ee',
      projection,
      accountId: 'owner',
      accountKey: ownerSecret,
      enrollmentIdentity,
      randomBytes: randomBytesFactory(450),
    });
    expect(override).not.toBeNull();
    expect(JSON.stringify(override)).not.toContain('private-admin-user');
    if (override === null) throw new Error('Expected encrypted enrollment-identity override');

    const baseContent = openManagedMachinePresetContentV1({
      presetId: 'preset-enrollment-identity', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    const overrideContent = openManagedMachinePresetContentV1({
      presetId: 'preset-enrollment-identity', mode: 'e2ee', content: override.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    expect(overrideContent).toEqual({ ...content, enrollmentIdentity });
    expect(resolveManagedMachinePresetEnrollmentIdentityOverrideV1({ baseContent, overrideContent })).toEqual(enrollmentIdentity);
    expect(resolveManagedMachinePresetEnrollmentIdentityOverrideV1({
      baseContent,
      overrideContent: { ...overrideContent!, launch: { ...overrideContent!.launch!, name: 'not permitted' } },
    })).toBeNull();

    const plain = sealManagedMachinePresetContentV1({
      presetId: 'preset-enrollment-identity-plain', mode: 'plain', content,
    });
    const plainProjection = projectManagedMachinePresetForRecipientV1({
      content: plain.content, recipients: plain.recipients, recipientAccountId: 'owner',
    });
    expect(createManagedMachinePresetEnrollmentIdentityOverrideV1({
      presetId: 'preset-enrollment-identity-plain', mode: 'plain', projection: plainProjection, enrollmentIdentity,
    })).toEqual({ content: { t: 'plain', v: { ...content, enrollmentIdentity } } });
  });

  it('composes private acquire name and enrollment identity in one same-DEK carrier', () => {
    const ownerSecret = new Uint8Array(32).fill(79);
    const enrollmentIdentity = {
      kind: 'dedicatedDaemonUser' as const,
      username: 'happier' as const,
      serviceMode: 'user' as const,
      role: 'deployTarget' as const,
      adminAccessAtCreation: 'ask' as const,
      administrator: { username: 'private-combined-admin' },
    };
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-combined-acquire-override', mode: 'e2ee', content,
      recipientCensus: [recipientCensus('owner', ownerSecret)], randomBytes: randomBytesFactory(460),
    });
    const projection = projectManagedMachinePresetForRecipientV1({
      content: sealed.content, recipients: sealed.recipients, recipientAccountId: 'owner',
    });
    const override = createManagedMachinePresetAcquireOverrideV1({
      presetId: 'preset-combined-acquire-override', mode: 'e2ee', projection,
      accountId: 'owner', accountKey: ownerSecret,
      launchName: 'private combined name', enrollmentIdentity, randomBytes: randomBytesFactory(470),
    });
    expect(override).not.toBeNull();
    expect(JSON.stringify(override)).not.toContain('private-combined-admin');
    if (override === null) throw new Error('Expected combined acquire override');
    const baseContent = openManagedMachinePresetContentV1({
      presetId: 'preset-combined-acquire-override', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    const overrideContent = openManagedMachinePresetContentV1({
      presetId: 'preset-combined-acquire-override', mode: 'e2ee', content: override.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    expect(resolveManagedMachinePresetAcquireOverrideV1({ baseContent, overrideContent })).toEqual({
      launchName: 'private combined name', enrollmentIdentity,
    });
    expect(resolveManagedMachinePresetAcquireOverrideV1({
      baseContent,
      overrideContent: { ...overrideContent!, setup: { scripts: [{ body: 'not permitted', affects: 'none' }] } },
    })).toBeNull();

    const setupOnly = { v: 1 as const, name: 'Setup only', setup: content.setup };
    const plainProjection = projectManagedMachinePresetForRecipientV1({
      content: { t: 'plain', v: setupOnly }, recipients: [], recipientAccountId: 'owner',
    });
    expect(createManagedMachinePresetAcquireOverrideV1({
      presetId: 'preset-identity-only', mode: 'plain', projection: plainProjection, enrollmentIdentity,
    })).toEqual({ content: { t: 'plain', v: { ...setupOnly, enrollmentIdentity } } });
  });

  it('round-trips plain preset content without recipient envelopes', () => {
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-plain',
      mode: 'plain',
      content,
    });

    expect(sealed).toEqual({
      content: { t: 'plain', v: content },
      recipients: [],
    });
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-plain',
      mode: 'plain',
      content: sealed.content,
    })).toEqual(content);
  });

  it('authenticates a daemon launch-name overlay and reseals under the existing DEK only', () => {
    const ownerSecret = new Uint8Array(32).fill(71);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-daemon-overlay',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(110),
    });

    const updated = replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-daemon-overlay',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      launchName: 'Bootstrap retry name',
      randomBytes: randomBytesFactory(140),
    });

    expect(updated).not.toBeNull();
    expect(updated).not.toEqual(sealed.content);
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-daemon-overlay',
      mode: 'e2ee',
      content: updated,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
    })).toEqual({
      ...content,
      launch: { ...content.launch, name: 'Bootstrap retry name' },
    });
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-daemon-overlay',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
    })).toEqual(content);
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'wrong-preset',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      launchName: 'Bootstrap retry name',
      randomBytes: randomBytesFactory(150),
    })).toBeNull();
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-daemon-overlay',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: new Uint8Array(32).fill(72),
      launchName: 'Bootstrap retry name',
      randomBytes: randomBytesFactory(160),
    })).toBeNull();
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-daemon-overlay',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      launchName: content.launch.name,
      randomBytes: randomBytesFactory(170),
    })).toEqual(sealed.content);

    const plain = sealManagedMachinePresetContentV1({
      presetId: 'preset-daemon-overlay-plain',
      mode: 'plain',
      content,
    });
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-daemon-overlay-plain',
      mode: 'plain',
      content: plain.content,
      launchName: 'Plain bootstrap retry name',
    })).toEqual({
      t: 'plain',
      v: { ...content, launch: { ...content.launch, name: 'Plain bootstrap retry name' } },
    });
  });

  it('seals an acquire-only launch override and immutable daemon review under the existing DEK', () => {
    const ownerSecret = new Uint8Array(32).fill(73);
    const reviewedFactsForRequestedName = ManagedConfigurationFactsV1Schema.parse({
      ...reviewedFacts,
      launch: { ...reviewedFacts.launch, name: 'Requested private name' },
    });
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-admitted-snapshot',
      mode: 'e2ee',
      content: { ...content, reviewedFacts },
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(190),
    })).toThrow('managed_preset_author_reviewed_facts_forbidden');

    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-admitted-snapshot',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(200),
    });
    const projection = projectManagedMachinePresetForRecipientV1({
      content: sealed.content,
      recipients: sealed.recipients,
      recipientAccountId: 'owner',
    });
    expect(projection.recipientEnvelope).not.toBeNull();
    expect(openManagedMachinePresetRecipientProjectionV1({
      presetId: 'preset-admitted-snapshot', mode: 'e2ee', projection,
      accountId: 'owner', accountKey: ownerSecret,
    })).toEqual(content);
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-admitted-snapshot', mode: 'e2ee', content: projection.content,
      recipients: [{ accountId: 'owner', envelope: projection.recipientEnvelope! }],
      accountId: 'owner', accountKey: ownerSecret, launchName: 'Requested private name', randomBytes: randomBytesFactory(205),
    })).not.toBeNull();
    const override = createManagedMachinePresetLaunchNameOverrideV1({
      presetId: 'preset-admitted-snapshot',
      mode: 'e2ee',
      projection,
      accountId: 'owner',
      accountKey: ownerSecret,
      launchName: 'Requested private name',
      randomBytes: randomBytesFactory(210),
    });

    expect(override).not.toBeNull();
    expect(readManagedMachinePresetContentOverrideForModeV1({ mode: 'e2ee', override })).toEqual(override);
    expect(readManagedMachinePresetLaunchNameOverrideForModeV1({ mode: 'e2ee', override })).toEqual(override);
    expect(readManagedMachinePresetLaunchNameOverrideForModeV1({ mode: 'plain', override })).toBeNull();
    if (override === null) throw new Error('Expected encrypted acquire name override');
    const baseContent = openManagedMachinePresetContentV1({
      presetId: 'preset-admitted-snapshot', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    const overrideContent = openManagedMachinePresetContentV1({
      presetId: 'preset-admitted-snapshot', mode: 'e2ee', content: override.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    expect(resolveManagedMachinePresetLaunchNameOverrideV1({ baseContent, overrideContent }))
      .toBe('Requested private name');
    expect(resolveManagedMachinePresetLaunchNameOverrideV1({
      baseContent,
      overrideContent: { ...overrideContent!, controllerDisplayName: 'Not permitted' },
    })).toBeNull();

    const admitted = replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-admitted-snapshot',
      mode: 'e2ee',
      content: override.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      launchName: 'Requested private name',
      reviewedFacts: reviewedFactsForRequestedName,
      randomBytes: randomBytesFactory(220),
    });
    expect(admitted).not.toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-admitted-snapshot', mode: 'e2ee', content: admitted, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    })).toEqual({
      ...content,
      launch: { ...content.launch, name: 'Requested private name' },
      reviewedFacts: reviewedFactsForRequestedName,
    });
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-admitted-snapshot',
      mode: 'e2ee',
      content: admitted,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      launchName: 'Requested private name',
      reviewedFacts: reviewedFactsForRequestedName,
      randomBytes: randomBytesFactory(230),
    })).toEqual(admitted);
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-admitted-snapshot',
      mode: 'e2ee',
      content: override.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      launchName: 'Requested private name',
      reviewedFacts,
      randomBytes: randomBytesFactory(240),
    })).toBeNull();
  });

  it('keeps a provider-native result in the admitted sealed snapshot and binds it to the reviewed launch', () => {
    const ownerSecret = new Uint8Array(32).fill(75);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-private-native-result',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(280),
    });
    const nativeResult = {
      kind: 'bound' as const,
      resource: {
        contributionRef: content.launch.provider,
        schemaVersion: content.launch.schemaVersion,
        value: { namespace: 'private-team-namespace', transport: 'private-transport', backendId: 'private-backend-id' },
      },
    };
    const observation = {
      observedAt: 123,
      availability: 'present' as const,
      power: 'running' as const,
      size: { cpuCores: 8, memoryBytes: 34_359_738_368 },
      prices: [{ amount: '12.34', currency: 'USD', unit: 'month', source: 'private-plan', observedAt: 123 }],
      nativeCause: { localCause: 'native_command_failed' as const, command: 'create' as const,
        exitCode: 1, stderr: '/private/namespace/backend' },
    };
    const snapshot = replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-private-native-result', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts, nativeResult, observation, randomBytes: randomBytesFactory(290),
    });
    expect(snapshot).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('private-backend-id');
    expect(JSON.stringify(snapshot)).not.toContain('/private/namespace/backend');
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-private-native-result', mode: 'e2ee', content: snapshot, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    })).toEqual({ ...content, reviewedFacts, nativeResult, observation });
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-private-native-result', mode: 'e2ee', content: snapshot, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts, nativeResult, observation, randomBytes: randomBytesFactory(300),
    })).toEqual(snapshot);
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-private-native-result', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts,
      nativeResult: { ...nativeResult, resource: { ...nativeResult.resource,
        contributionRef: { pluginId: 'other.compute', localId: 'vm' } } },
      randomBytes: randomBytesFactory(310),
    })).toBeNull();
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-private-native-result', mode: 'e2ee', content: { ...content, reviewedFacts, nativeResult },
      recipientCensus: [recipientCensus('owner', ownerSecret)], randomBytes: randomBytesFactory(320),
    })).toThrow('managed_preset_author_native_result_forbidden');
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-private-native-result', mode: 'e2ee', content: { ...content, reviewedFacts, observation },
      recipientCensus: [recipientCensus('owner', ownerSecret)], randomBytes: randomBytesFactory(330),
    })).toThrow('managed_preset_author_observation_forbidden');
  });

  it('keeps full provider control outcomes in the sealed snapshot and binds control references to the reviewed launch', () => {
    const ownerSecret = new Uint8Array(32).fill(77);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-private-control-result',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(380),
    });
    const nativeControlResult = {
      kind: 'rebuild' as const,
      result: {
        kind: 'bound' as const,
        resource: {
          contributionRef: content.launch.provider,
          schemaVersion: content.launch.schemaVersion,
          value: { namespace: 'private-rebuild-namespace', transport: 'private-rebuild-transport', backendId: 'private-rebuild-id' },
        },
      },
    };
    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-private-control-result-plain', mode: 'plain', content: { t: 'plain', v: content },
      launchName: content.launch.name, reviewedFacts, nativeControlResult,
    })).toEqual({ t: 'plain', v: { ...content, reviewedFacts, nativeControlResult } });
    const snapshot = replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-private-control-result', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts, nativeControlResult, randomBytes: randomBytesFactory(390),
    });
    expect(snapshot).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('private-rebuild-id');
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-private-control-result', mode: 'e2ee', content: snapshot, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    })).toEqual({ ...content, reviewedFacts, nativeControlResult });

    const diagnosticControlResult = {
      kind: 'rebuild' as const,
      result: {
        kind: 'unknown' as const,
        recovery: { reference: 'private-rebuild-reference', reason: 'native_result_unknown', consoleUrl: 'https://private-console.example/rebuild' },
        nativeCause: { localCause: 'native_command_failed' as const, command: 'restart' as const,
          exitCode: 1, stderr: '/private/rebuild/diagnostic' },
      },
    };
    const diagnosticSnapshot = replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-private-control-result', mode: 'e2ee', content: snapshot, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts, nativeControlResult: diagnosticControlResult, randomBytes: randomBytesFactory(400),
    });
    expect(JSON.stringify(diagnosticSnapshot)).not.toContain('/private/rebuild/diagnostic');
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-private-control-result', mode: 'e2ee', content: diagnosticSnapshot, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    })).toEqual({ ...content, reviewedFacts, nativeControlResult: diagnosticControlResult });

    expect(replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-private-control-result', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts,
      nativeControlResult: { kind: 'delete', result: { kind: 'accepted', nativeOperationRef: {
        contributionRef: { pluginId: 'other.compute', localId: 'vm' }, schemaVersion: content.launch.schemaVersion, value: { operationId: 'wrong-provider' },
      } } },
      randomBytes: randomBytesFactory(410),
    })).toBeNull();
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-private-control-result', mode: 'e2ee', content: { ...content, reviewedFacts, nativeControlResult },
      recipientCensus: [recipientCensus('owner', ownerSecret)], randomBytes: randomBytesFactory(420),
    })).toThrow('managed_preset_author_native_control_result_forbidden');
  });

  it('seals a setup-only acquire override under the existing DEK and rejects every other private drift', () => {
    const ownerSecret = new Uint8Array(32).fill(74);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-setup-override',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(250),
    });
    const admitted = replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-setup-override', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts, randomBytes: randomBytesFactory(255),
    });
    expect(admitted).not.toBeNull();
    const projection = projectManagedMachinePresetForRecipientV1({
      content: admitted!,
      recipients: sealed.recipients,
      recipientAccountId: 'owner',
    });
    const setup = { scripts: [{ body: 'echo edited setup', affects: 'none' as const }] };

    const override = createManagedMachinePresetSetupOverrideV1({
      presetId: 'preset-setup-override',
      mode: 'e2ee',
      projection,
      accountId: 'owner',
      accountKey: ownerSecret,
      setup,
      randomBytes: randomBytesFactory(260),
    });
    expect(override).not.toBeNull();
    if (override === null) throw new Error('Expected encrypted setup override');

    const baseContent = openManagedMachinePresetContentV1({
      presetId: 'preset-setup-override', mode: 'e2ee', content: admitted!, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    const overrideContent = openManagedMachinePresetContentV1({
      presetId: 'preset-setup-override', mode: 'e2ee', content: override.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    expect(overrideContent).toEqual({ ...content, setup, reviewedFacts });
    expect(resolveManagedMachinePresetSetupOverrideV1({ baseContent, overrideContent })).toEqual(setup);
    expect(resolveManagedMachinePresetSetupOverrideV1({
      baseContent,
      overrideContent: { ...overrideContent!, launch: { ...overrideContent!.launch!, name: 'not permitted' } },
    })).toBeNull();
    const { reviewedFacts: ignoredReviewedFacts, ...withoutReviewedFacts } = overrideContent!;
    expect(ignoredReviewedFacts).toEqual(reviewedFacts);
    expect(resolveManagedMachinePresetSetupOverrideV1({ baseContent, overrideContent: withoutReviewedFacts })).toBeNull();
    expect(resolveManagedMachinePresetSetupOverrideV1({
      baseContent,
      overrideContent: { ...overrideContent!, nativeResult: {
        kind: 'bound', resource: { contributionRef: content.launch.provider, schemaVersion: content.launch.schemaVersion,
          value: { privateBackend: 'not permitted' } },
      } },
    })).toBeNull();

    expect(replaceManagedMachinePresetSetupV1({
      presetId: 'preset-setup-override', mode: 'e2ee', content: projection.content,
      recipients: [{ accountId: 'owner', envelope: projection.recipientEnvelope! }],
      accountId: 'owner', accountKey: ownerSecret, setup, randomBytes: randomBytesFactory(270),
    })).not.toBeNull();
    expect(createManagedMachinePresetSetupOverrideV1({
      presetId: 'preset-setup-override', mode: 'plain', projection, setup,
    })).toBeNull();

    const plain = sealManagedMachinePresetContentV1({
      presetId: 'preset-setup-override-plain', mode: 'plain', content,
    });
    const plainProjection = projectManagedMachinePresetForRecipientV1({
      content: plain.content, recipients: plain.recipients, recipientAccountId: 'owner',
    });
    const plainOverride = createManagedMachinePresetSetupOverrideV1({
      presetId: 'preset-setup-override-plain', mode: 'plain', projection: plainProjection, setup,
    });
    expect(plainOverride).toEqual({ content: { t: 'plain', v: { ...content, setup } } });
  });

  it('seals a resize-only control override under the existing DEK and rejects every other private drift', () => {
    const ownerSecret = new Uint8Array(32).fill(76);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-resize-override',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(340),
    });
    const admitted = replaceManagedMachinePresetLaunchNameV1({
      presetId: 'preset-resize-override', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret, launchName: content.launch.name,
      reviewedFacts, randomBytes: randomBytesFactory(345),
    });
    expect(admitted).not.toBeNull();
    const projection = projectManagedMachinePresetForRecipientV1({
      content: admitted!, recipients: sealed.recipients, recipientAccountId: 'owner',
    });
    const size = { cpuCores: 8, memoryBytes: 34_359_738_368 };

    const override = createManagedMachinePresetResizeOverrideV1({
      presetId: 'preset-resize-override', mode: 'e2ee', projection,
      accountId: 'owner', accountKey: ownerSecret, size, randomBytes: randomBytesFactory(350),
    });
    expect(override).not.toBeNull();
    if (override === null) throw new Error('Expected encrypted resize override');

    const baseContent = openManagedMachinePresetContentV1({
      presetId: 'preset-resize-override', mode: 'e2ee', content: admitted!, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    const overrideContent = openManagedMachinePresetContentV1({
      presetId: 'preset-resize-override', mode: 'e2ee', content: override.content, recipients: sealed.recipients,
      accountId: 'owner', accountKey: ownerSecret,
    });
    expect(overrideContent).toEqual({ ...content, reviewedFacts, resize: size });
    expect(resolveManagedMachinePresetResizeOverrideV1({ baseContent, overrideContent })).toEqual(size);
    expect(resolveManagedMachinePresetResizeOverrideV1({
      baseContent,
      overrideContent: { ...overrideContent!, launch: { ...overrideContent!.launch!, name: 'not permitted' } },
    })).toBeNull();
    expect(resolveManagedMachinePresetResizeOverrideV1({
      baseContent,
      overrideContent: { ...overrideContent!, setup: { scripts: [{ body: 'not permitted', affects: 'none' }] } },
    })).toBeNull();

    expect(replaceManagedMachinePresetResizeV1({
      presetId: 'preset-resize-override', mode: 'e2ee', content: projection.content,
      recipients: [{ accountId: 'owner', envelope: projection.recipientEnvelope! }],
      accountId: 'owner', accountKey: ownerSecret, size, randomBytes: randomBytesFactory(360),
    })).not.toBeNull();
    expect(createManagedMachinePresetResizeOverrideV1({
      presetId: 'preset-resize-override', mode: 'plain', projection, size,
    })).toBeNull();

    const plain = sealManagedMachinePresetContentV1({
      presetId: 'preset-resize-override-plain', mode: 'plain', content,
    });
    const plainProjection = projectManagedMachinePresetForRecipientV1({
      content: plain.content, recipients: plain.recipients, recipientAccountId: 'owner',
    });
    expect(createManagedMachinePresetResizeOverrideV1({
      presetId: 'preset-resize-override-plain', mode: 'plain', projection: plainProjection, size,
    })).toEqual({ content: { t: 'plain', v: { ...content, resize: size } } });
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-resize-override', mode: 'e2ee', content: { ...content, resize: size },
      recipientCensus: [recipientCensus('owner', ownerSecret)], randomBytes: randomBytesFactory(370),
    })).toThrow('managed_preset_author_resize_forbidden');
  });

  it('exports one opaque storage envelope shape for preset and managed-machine projections', () => {
    const envelope = {
      // The server owns only this carrier; clients validate/open the private body.
      content: { t: 'plain' as const, v: { privateBody: 'not inspected by the envelope owner' } },
      recipients: [],
      controllerPoolId: 'c1d23348-62b4-4584-aeb2-3c8e312acc8c',
    };
    expect(ManagedMachinePresetEnvelopeV1Schema.parse(envelope)).toEqual(envelope);
    expect(ManagedMachinePresetEnvelopeV1Schema.safeParse({ ...envelope, machineId: 'not-a-recipient' }).success).toBe(false);
  });

  it('projects only the requesting Account envelope and opens through that projection', () => {
    const ownerSecret = new Uint8Array(32).fill(31);
    const memberSecret = new Uint8Array(32).fill(32);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-reader-projection',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret), recipientCensus('member', memberSecret)],
      randomBytes: randomBytesFactory(180),
    });
    const projection = projectManagedMachinePresetForRecipientV1({
      content: sealed.content,
      recipients: sealed.recipients,
      recipientAccountId: 'member',
    });

    expect(projection).toEqual({ content: sealed.content, recipientEnvelope: sealed.recipients[1]!.envelope });
    expect(projection).not.toHaveProperty('recipients');
    expect(openManagedMachinePresetRecipientProjectionV1({
      presetId: 'preset-reader-projection',
      mode: 'e2ee',
      projection,
      accountId: 'member',
      accountKey: memberSecret,
    })).toEqual(content);
    expect(projectManagedMachinePresetForRecipientV1({
      content: sealed.content,
      recipients: sealed.recipients,
      recipientAccountId: 'not-a-recipient',
    }).recipientEnvelope).toBeNull();
    expect(ManagedMachinePresetRecipientProjectionV1Schema.safeParse({
      content: { t: 'plain', v: { opaque: true } },
      recipientEnvelope: sealed.recipients[0]!.envelope,
    }).success).toBe(false);
  });

  it('seals one preset DEK to the complete server-owned Account census and drops an ex-member on fresh rewrap', () => {
    const ownerSecret = new Uint8Array(32).fill(3);
    const memberSecret = new Uint8Array(32).fill(4);
    const exMemberSecret = new Uint8Array(32).fill(5);
    const custodianSecret = new Uint8Array(32).fill(6);
    const owner = recipientCensus('owner', ownerSecret);
    const member = recipientCensus('member', memberSecret);
    const custodian = recipientCensus('custodian', custodianSecret);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content,
      recipientCensus: [owner, member, custodian],
      randomBytes: randomBytesFactory(),
    });

    expect(sealed.recipients.map(item => item.accountId)).toEqual(['owner', 'member', 'custodian']);
    expect(sealed.recipients.every(item => !('machineId' in item))).toBe(true);
    expect(SavedSecretResourceRecipientEnvelopeV1Schema.parse(sealed.recipients[0]!.envelope))
      .toEqual(sealed.recipients[0]!.envelope);
    const ownerDataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(sealed.recipients[0]!.envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: ownerSecret,
    });
    const memberDataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(sealed.recipients[1]!.envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: memberSecret,
    });
    const custodianDataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(sealed.recipients[2]!.envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: custodianSecret,
    });
    expect(ownerDataKey).not.toBeNull();
    expect(memberDataKey).toEqual(ownerDataKey);
    expect(custodianDataKey).toEqual(ownerDataKey);
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
    })).toEqual(content);
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'member',
      accountKey: memberSecret,
    })).toEqual(content);
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'custodian',
      accountKey: custodianSecret,
    })).toEqual(content);
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'ex-member',
      accountKey: exMemberSecret,
    })).toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'member',
      accountKey: exMemberSecret,
    })).toBeNull();

    const revisedContent = { ...content, name: 'Team guest revised' };
    const rewrapped = sealManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: revisedContent,
      recipientCensus: [owner, custodian],
      randomBytes: randomBytesFactory(40),
    });
    expect(rewrapped.recipients.map(item => item.accountId)).toEqual(['owner', 'custodian']);
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: rewrapped.content,
      recipients: rewrapped.recipients,
      accountId: 'member',
      accountKey: memberSecret,
    })).toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: rewrapped.content,
      recipients: sealed.recipients,
      accountId: 'member',
      accountKey: memberSecret,
    })).toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-e2ee',
      mode: 'e2ee',
      content: rewrapped.content,
      recipients: rewrapped.recipients,
      accountId: 'custodian',
      accountKey: custodianSecret,
    })).toEqual(revisedContent);
  });

  it('preserves prepared envelopes and rewraps only stale or newly admitted recipients', () => {
    const ownerSecret = new Uint8Array(32).fill(21);
    const formerMemberSecret = new Uint8Array(32).fill(22);
    const priorCustodianSecret = new Uint8Array(32).fill(23);
    const rotatedCustodianSecret = new Uint8Array(32).fill(25);
    const joinedMemberSecret = new Uint8Array(32).fill(24);
    const initial = sealManagedMachinePresetContentV1({
      presetId: 'preset-rewrap',
      mode: 'e2ee',
      content,
      recipientCensus: [
        recipientCensus('owner', ownerSecret),
        recipientCensus('former-member', formerMemberSecret),
        recipientCensus('custodian', priorCustodianSecret),
      ],
      randomBytes: randomBytesFactory(60),
    });
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-rewrap', mode: 'e2ee', content: initial.content, recipients: initial.recipients,
      accountId: 'former-member', accountKey: formerMemberSecret,
    })).toEqual(content);

    const unchanged = rewrapManagedMachinePresetRecipientsV1({
      recipients: initial.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      recipientCensus: [
        recipientCensus('owner', ownerSecret, 'prepared'),
        recipientCensus('former-member', formerMemberSecret, 'prepared'),
        recipientCensus('custodian', priorCustodianSecret, 'prepared'),
      ],
      randomBytes: randomBytesFactory(80),
    });
    expect(unchanged).toEqual(initial.recipients);

    const recipients = rewrapManagedMachinePresetRecipientsV1({
      recipients: initial.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
      recipientCensus: [
        recipientCensus('owner', ownerSecret, 'prepared'),
        recipientCensus('custodian', rotatedCustodianSecret, 'stale'),
        recipientCensus('joined-member', joinedMemberSecret),
      ],
      randomBytes: randomBytesFactory(90),
    });

    expect(recipients).not.toBeNull();
    if (recipients === null) throw new Error('Expected rewrapped preset recipients');
    expect(recipients.map(item => item.accountId)).toEqual(['owner', 'custodian', 'joined-member']);
    expect(recipients[0]!.envelope).toEqual(initial.recipients[0]!.envelope);
    expect(recipients[1]!.envelope).not.toEqual(initial.recipients[2]!.envelope);
    expect(openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(recipients[1]!.envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: rotatedCustodianSecret,
    })).not.toBeNull();
    expect(openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(recipients[1]!.envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: priorCustodianSecret,
    })).toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-rewrap', mode: 'e2ee', content: initial.content, recipients,
      accountId: 'joined-member', accountKey: joinedMemberSecret,
    })).toEqual(content);
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-rewrap', mode: 'e2ee', content: initial.content, recipients,
      accountId: 'former-member', accountKey: formerMemberSecret,
    })).toBeNull();
    expect(rewrapManagedMachinePresetRecipientsV1({
      recipients: initial.recipients,
      accountId: 'former-member',
      accountKey: formerMemberSecret,
      recipientCensus: [
        recipientCensus('owner', ownerSecret, 'prepared'),
        recipientCensus('custodian', rotatedCustodianSecret, 'stale'),
        recipientCensus('joined-member', joinedMemberSecret),
      ],
      randomBytes: randomBytesFactory(100),
    })).toBeNull();
  });

  it('refuses mode mismatches and ciphertext bound to another preset', () => {
    const ownerSecret = new Uint8Array(32).fill(7);
    const sealed = sealManagedMachinePresetContentV1({
      presetId: 'preset-bound',
      mode: 'e2ee',
      content,
      recipientCensus: [recipientCensus('owner', ownerSecret)],
      randomBytes: randomBytesFactory(),
    });

    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-bound',
      mode: 'plain',
      content: sealed.content,
    })).toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'preset-bound',
      mode: 'e2ee',
      content: { t: 'plain', v: content },
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
    })).toBeNull();
    expect(openManagedMachinePresetContentV1({
      presetId: 'different-preset',
      mode: 'e2ee',
      content: sealed.content,
      recipients: sealed.recipients,
      accountId: 'owner',
      accountKey: ownerSecret,
    })).toBeNull();
  });

  it('keeps recipient envelopes Account-scoped and refuses incomplete or duplicate canonical censuses', () => {
    const ownerSecret = new Uint8Array(32).fill(9);
    const owner = recipientCensus('owner', ownerSecret);
    expect(ManagedMachinePresetRecipientV1Schema.safeParse({
      accountId: 'owner',
      envelope: {
        encryptedDataKey: 'not-an-envelope',
        recipientContentPublicKeyFingerprint: 'not-a-fingerprint',
      },
      machineId: 'machine-1',
    }).success).toBe(false);
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-duplicate',
      mode: 'e2ee',
      content,
      recipientCensus: [owner, owner],
      randomBytes: randomBytesFactory(),
    })).toThrow('managed_preset_duplicate_recipient');
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-incomplete',
      mode: 'e2ee',
      content,
      recipientCensus: [owner, unavailableRecipientCensus('custodian')],
      randomBytes: randomBytesFactory(),
    })).toThrow('managed_preset_recipient_census_incomplete');
    expect(() => sealManagedMachinePresetContentV1({
      presetId: 'preset-stale-envelope',
      mode: 'e2ee',
      content,
      recipientCensus: [owner, recipientCensus('custodian', new Uint8Array(32).fill(10), 'prepared')],
      randomBytes: randomBytesFactory(),
    })).toThrow('managed_preset_recipient_census_incomplete');
  });
});
