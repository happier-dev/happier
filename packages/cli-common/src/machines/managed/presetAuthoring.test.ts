import { describe, expect, it } from 'vitest';
import * as managed from './index.js';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { openManagedMachinePresetContentV1, openManagedMachinePresetRecipientProjectionV1,
  replaceManagedMachinePresetPreparationV1, replaceManagedMachinePresetSetupV1,
  sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { HostReviewedChildrenPreparationRequestV1 } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { ManagedMachinePresetUpdateInputV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

const descriptor = {
  id: 'container', title: 'Container', icon: 'cube', resourceKind: 'container', schemaVersion: 1,
  platforms: ['linux'], prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
  retention: { supportedIntents: ['delete'] },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
  launchSchema: { type: 'object', properties: { source: { type: 'string', enum: ['image', 'file'] } },
    required: ['source'], additionalProperties: false },
  resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
  effectReview: { requiredWhen: { op: 'eq', path: 'source', value: 'file' } },
};
const effectReview = { kind: 'devcontainer' as const, reviewedEffectDigest: 'a'.repeat(64),
  effects: [{ scope: 'host' as const, kind: 'initialize' as const, title: 'Initialize workspace', details: ['Run authored setup'] }] };
const contribution = { pluginId: 'test.compute', localId: 'container' };
const plainCensus = { kind: 'ready' as const, contentEncryptionMode: 'plain' as const, recipients: [] };
const controller = { machineId: 'author-computer', installationId: 'author-installation' };

describe('preset author source review', () => {
  it('persists the captured carrier through the ordinary Save admission', async () => {
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: {
      v: 1, name: 'Team source', preparation: { enabled: false }, launch: { provider: contribution,
        schemaVersion: 1, name: 'Authored', choices: { source: 'file' } },
    } });
    const deps = { custody: { accountId: 'author', readWriterMode: async () => 'plain' as const,
      open: params => openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }), withE2eeAccountKey: () => null, readRecipientCensus: async () => plainCensus },
      readSelectedProvisioners: async () => [{ contribution, occurrenceId: 'installed', acquireExecutionTarget: 'daemon' as const,
        descriptor: MachineProvisionerContributionV1Schema.parse(descriptor) }], randomBytes: (length: number) => new Uint8Array(length),
    } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[1];
    let nativeOptions = 0;
    const executor = createActionExecutor({ prepareHostReviewedChildren: request => managed.prepareManagedMachinePresetAuthoringV1(request, deps),
      managedMachineAction: async ({ actionId }) => {
        expect(actionId).toBe('machines.provisioners.options');
        nativeOptions += 1;
        return { base: { launch: { source: 'file' }, effectReview },
          dimensions: { size: [], image: [], location: [], network: [], duration: [] } };
      },
      machinePresetAction: async ({ input }) => {
        expect(input).toHaveProperty('content.v.authorEffectReview', effectReview);
        return { kind: 'saved', preset: { ...input, revision: 1 } };
      },
    });
    const result = await executor.execute('machines.presets.create', { id: 'preset', homeId: 'home',
      owner: { kind: 'team', teamId: 'team' }, teamAcquireDelegated: true, contentEncryptionMode: 'plain',
      content: sealed.content, recipients: [], controller }, { surface: 'cli', authority: 'present_user',
      runtimeAccountId: 'author', serverId: 'home', actionCaller: { kind: 'host' },
      presentUserConfirmation: { actionId: 'machines.presets.create' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'saved' } });
    expect(nativeOptions).toBe(1);
  });
  it('rejects caller-supplied Save receipts and reuses only the canonical approval replay', async () => {
    const input = { id: 'preset', homeId: 'home', owner: { kind: 'team', teamId: 'team' },
      contentEncryptionMode: 'plain', recipients: [], controller, teamAcquireDelegated: true,
      content: { t: 'plain', v: { v: 1, name: 'Forged', authorEffectReview: effectReview,
        launch: { provider: contribution, schemaVersion: 1, name: 'Authored', choices: { source: 'file' } } } } };
    const deps = {
      custody: { accountId: 'author', readWriterMode: async () => 'plain' as const, open: params =>
        openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }), withE2eeAccountKey: () => null, readRecipientCensus: async () => plainCensus },
      readSelectedProvisioners: async () => [], randomBytes: (length: number) => new Uint8Array(length),
    } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[1];
    expect(await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.create', input,
      context: { runtimeAccountId: 'author' } }, deps)).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.create', input,
      context: { runtimeAccountId: 'author' }, approvalReplay: true }, deps)).toBeNull();
  });
  it('uses the saved fixed controller when a new source revision omits routing from its patch', async () => {
    const content = { v: 1 as const, name: 'Team preset', launch: { provider: contribution, schemaVersion: 1,
      name: 'Authored container', choices: { source: 'file' } } };
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content });
    const preset = { id: 'preset', homeId: 'home', revision: 4, owner: { kind: 'team', teamId: 'team' },
      contentEncryptionMode: 'plain', content: sealed.content, recipients: [], controller, teamAcquireDelegated: true };
    const nativeInputs: unknown[] = [];
    const prepared = await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.update',
      input: { id: 'preset', homeId: 'home', expectedRevision: 4, patch: { content: sealed.content } },
      context: { runtimeAccountId: 'author' }, invokeChild: async child => {
        if (child.action === 'machines.presets.get') return { ok: true, result: { kind: 'found', preset } };
        nativeInputs.push(child.input);
        if (!(child.input && typeof child.input === 'object' && 'controller' in child.input)) {
          return { ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' };
        }
        return { ok: true, result: { base: { launch: content.launch.choices, effectReview },
          dimensions: { size: [], image: [], location: [], network: [], duration: [] } } };
      },
    }, { custody: { accountId: 'author', readWriterMode: async () => 'plain' as const, open: params => openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }),
      withE2eeAccountKey: () => null, readRecipientCensus: async () => plainCensus }, readSelectedProvisioners: async () => [{ contribution,
      occurrenceId: 'installed', acquireExecutionTarget: 'daemon', descriptor: MachineProvisionerContributionV1Schema.parse(descriptor) }],
      randomBytes: length => new Uint8Array(length) });
    expect(prepared).not.toHaveProperty('ok');
    expect(nativeInputs).toEqual([{ homeId: 'home', contribution, controller, selectors: { source: 'file' } }]);
  });
  it('captures source effects before Save approval with Prepare off and leaves image saves native-free', async () => {
    for (const source of ['file', 'image'] as const) {
      const content = { v: 1 as const, name: 'Team preset', preparation: { enabled: false },
        launch: { provider: contribution, schemaVersion: 1, name: 'Authored container', choices: { source } } };
      const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content });
      const input = { id: 'preset', homeId: 'home', owner: { kind: 'team', teamId: 'team' },
        contentEncryptionMode: 'plain', content: sealed.content, recipients: [], controller, teamAcquireDelegated: true };
      const nativeInputs: unknown[] = [];
      // Only the installed native Action broker is substituted. Projection,
      // content opening, exact carrier capture, and member overrides remain real.
      const invokeChild: NonNullable<HostReviewedChildrenPreparationRequestV1['invokeChild']> = async child => {
        nativeInputs.push(child.input);
        return { ok: true, result: { base: { launch: { source }, effectReview },
          dimensions: { size: [], image: [], location: [], network: [], duration: [] } } };
      };
      const prepared = await managed.prepareManagedMachinePresetAuthoringV1({
        actionId: 'machines.presets.create', input, context: { runtimeAccountId: 'author' }, invokeChild,
      }, {
        custody: { accountId: 'author', readWriterMode: async () => 'plain' as const, open: params => openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }),
          withE2eeAccountKey: () => null, readRecipientCensus: async () => plainCensus },
        readSelectedProvisioners: async () => [{ contribution, occurrenceId: 'installed', acquireExecutionTarget: 'daemon',
          descriptor: MachineProvisionerContributionV1Schema.parse(descriptor) }],
        randomBytes: length => new Uint8Array(length).fill(7),
      });
      if (source === 'image') {
        expect(prepared).toMatchObject({ input: { configurationRevision: 0 } });
        expect(nativeInputs).toEqual([]);
        continue;
      }
      expect(prepared).not.toBeNull();
      if (!prepared || 'ok' in prepared) throw new Error(`Expected author review: ${JSON.stringify(prepared)}`);
      expect(prepared.approvalPreview).toMatchObject({ authorEffectReview: effectReview });
      const reviewedInput = prepared.input as typeof input;
      const opened = openManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: reviewedInput.content });
      expect(opened).toMatchObject({ preparation: { enabled: false }, authorEffectReview: effectReview });
      if (!opened) throw new Error('Expected authored content');
      expect(managed.readManagedOpaquePresetAcquireEffectDigestV1(opened)).toBe(effectReview.reviewedEffectDigest);
      expect(nativeInputs).toEqual([{ homeId: 'home', contribution, controller, selectors: { source: 'file' } }]);
    }
  });
});

describe('preset authored configuration counter', () => {
  // Owner ruling 2026-11-16: public reuse identity is a change counter, never a content digest.
  it.each(['plain', 'e2ee'] as const)('advances only launch/setup changes through real %s custody', async mode => {
    const accountKey = new Uint8Array(32).fill(13);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const recipientCensus = [{ account: { kind: 'account' as const, accountId: 'author', name: null, firstName: 'Author',
      lastName: null, username: 'author', avatarUrl: null }, readiness: { status: 'available' as const,
      contentPublicKey: encodeBase64(publicKey), contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) },
      envelopeStatus: 'missing' as const }];
    let nonce = 30;
    const randomBytes = (length: number) => new Uint8Array(length).fill(nonce++);
    const seal = (content: ManagedMachinePresetContentV1) => mode === 'plain'
      ? sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content })
      : sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content, recipientCensus, randomBytes });
    const original = { v: 1 as const, name: 'Original', preparation: { enabled: false },
      launch: { provider: contribution, schemaVersion: 1, name: 'Guest', choices: { source: 'image' } },
      setup: { scripts: [{ body: 'echo initial', affects: 'none' as const }] } };
    const initial = seal(original);
    const preset = { id: 'preset', homeId: 'home', revision: 9, configurationRevision: 4,
      owner: { kind: 'account' as const, accountId: 'author' }, contentEncryptionMode: mode,
      ...initial };
    const deps = { custody: { accountId: 'author', readWriterMode: async () => mode, open: params => params.mode === 'plain'
      ? openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' })
      : openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'e2ee', accountId: 'author', accountKey }),
      withE2eeAccountKey: operation => operation({ accountId: 'author', accountKey }),
      readRecipientCensus: async () => ({ kind: 'ready' as const, contentEncryptionMode: mode, recipients: recipientCensus }) },
      readSelectedProvisioners: async () => [{ contribution, occurrenceId: 'installed', acquireExecutionTarget: 'daemon' as const,
        descriptor: MachineProvisionerContributionV1Schema.parse(descriptor) }], randomBytes,
    } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[1];
    const cases: Array<readonly [ManagedMachinePresetContentV1, number]> = [
      [{ ...original, name: 'Renamed', launch: { ...original.launch, name: 'Display rename' },
        preparation: { enabled: true } }, 4],
      [{ ...original, launch: { ...original.launch, choices: { source: 'file' } } }, 5],
      [{ ...original, setup: { scripts: [{ body: 'echo edited', affects: 'none' as const }] } }, 5],
    ];
    for (const [next, expected] of cases) {
      const write = seal(next);
      let reads = 0;
      const prepared = await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.update',
        input: { id: 'preset', homeId: 'home', expectedRevision: 9,
          patch: { ...write, contentEncryptionMode: mode, configurationRevision: 88, setupRevision: 88 } }, context: { runtimeAccountId: 'author' },
        invokeChild: async child => {
          if (child.action === 'machines.presets.get') { reads += 1; return { ok: true, result: { kind: 'found', preset } }; }
          return { ok: true, result: { base: { launch: { source: 'file' }, effectReview },
            dimensions: { size: [], image: [], location: [], network: [], duration: [] } } };
        } }, deps);
      if (!prepared || 'ok' in prepared) throw new Error(`Expected counter write: ${JSON.stringify(prepared)}`);
      const captured = ManagedMachinePresetUpdateInputV1Schema.parse(prepared.input);
      expect(captured.patch.configurationRevision).toBe(expected);
      // A Machine setup notice must ignore launch edits and display/preparation metadata.
      expect(captured.patch).toHaveProperty('setupRevision', next.setup === original.setup ? 0 : 1);
      expect(reads).toBe(1);
      expect(captured.patch).not.toHaveProperty('configurationDigest');
      expect(await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.update',
        input: captured, context: { runtimeAccountId: 'author' }, approvalReplay: true }, deps)).toBeNull();
      if (prepared.approvalPreview !== undefined) {
        if (!captured.patch.content) throw new Error('Expected captured source carrier');
        const changedSetup = { scripts: [{ body: 'echo later', affects: 'none' as const }] };
        const source = { presetId: 'preset', content: captured.patch.content };
        const edited = mode === 'plain' ? replaceManagedMachinePresetSetupV1({ ...source, mode, setup: changedSetup })
          : replaceManagedMachinePresetSetupV1({ ...source, mode, recipients: captured.patch.recipients ?? [],
            accountId: 'author', accountKey, randomBytes, setup: changedSetup });
        if (!edited) throw new Error('Expected source carrier setup edit');
        for (const [carrier, revision] of [[captured.patch.content, 5], [edited, 6]] as const) {
          expect(await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.update',
            input: { id: 'preset', homeId: 'home', expectedRevision: 10, patch: { content: carrier } },
            context: { runtimeAccountId: 'author' }, invokeChild: async child => {
              expect(child.action).toBe('machines.presets.get');
              return { ok: true, result: { kind: 'found', preset: { ...preset, revision: 10, configurationRevision: 5,
                content: captured.patch.content, recipients: captured.patch.recipients ?? [] } } };
            } }, deps)).toMatchObject({ input: { patch: { configurationRevision: revision } } });
        }
      }
    }
    const { name: _guestName, ...launch } = original.launch;
    const preparation = { presetId: 'preset', content: initial.content, expectedOperationId: null,
      prepared: { operationId: 'prepare', status: 'building' as const,
        binding: { configuration: { launch, setup: original.setup }, cliIdentity: 'home:0.3:payload', credentialConfigurations: [] } } };
    const operational = mode === 'plain' ? replaceManagedMachinePresetPreparationV1({ ...preparation, mode })
      : replaceManagedMachinePresetPreparationV1({ ...preparation, mode, recipients: initial.recipients,
        accountId: 'author', accountKey, randomBytes });
    if (!operational) throw new Error('Expected operational preparation write');
    expect(await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.update',
      input: { id: 'preset', homeId: 'home', expectedRevision: 9, patch: { content: operational.content } },
      context: { runtimeAccountId: 'author' }, invokeChild: async () => ({ ok: true,
        result: { kind: 'found', preset } }) }, deps)).toMatchObject({ input: { patch: { configurationRevision: 4 } } });
  });

  it('starts new and legacy setup-only presets at zero and advances setup edits', async () => {
    const content = { v: 1 as const, name: 'Setup only', setup: { scripts: [{ body: 'echo setup', affects: 'none' as const }] } };
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content });
    const deps = { custody: { accountId: 'author', readWriterMode: async () => 'plain' as const, open: params =>
      openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }), withE2eeAccountKey: () => null, readRecipientCensus: async () => plainCensus },
      readSelectedProvisioners: async () => [], randomBytes: (length: number) => new Uint8Array(length),
    } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[1];
    const create = { id: 'preset', homeId: 'home', owner: { kind: 'account' as const, accountId: 'author' },
      contentEncryptionMode: 'plain' as const, ...sealed };
    expect(await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.create', input: create,
      context: { runtimeAccountId: 'author' } }, deps)).toMatchObject({ input: { configurationRevision: 0 } });
    const cases: Array<readonly [ManagedMachinePresetContentV1, number]> = [[content, 0], [{ ...content,
      setup: { scripts: [{ body: 'echo changed', affects: 'none' as const }] } }, 1]];
    for (const [next, expected] of cases) {
      expect(await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.update',
        input: { id: 'preset', homeId: 'home', expectedRevision: 7,
          patch: sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: next }) },
        context: { runtimeAccountId: 'author' }, invokeChild: async () => ({ ok: true,
          result: { kind: 'found', preset: { ...create, revision: 7 } } }) }, deps))
        .toMatchObject({ input: { patch: { configurationRevision: expected } } });
    }
  });

  it('preserves explicit setup counters through ordinary Update admission', async () => {
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: {
      v: 1, name: 'Setup', setup: { scripts: [{ body: 'echo setup', affects: 'none' }] },
    } });
    const deps = { custody: { accountId: 'author', readWriterMode: async () => 'plain' as const, open: params =>
      openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }), withE2eeAccountKey: () => null, readRecipientCensus: async () => plainCensus },
      readSelectedProvisioners: async () => [], randomBytes: (length: number) => new Uint8Array(length),
    } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[1];
    // Network persistence is the boundary: authoring and Action admission remain real.
    let persistedPatch: unknown;
    const executor = createActionExecutor({
      prepareHostReviewedChildren: request => managed.prepareManagedMachinePresetAuthoringV1(request, deps),
      machinePresetAction: async ({ input }) => {
        const update = ManagedMachinePresetUpdateInputV1Schema.parse(input);
        persistedPatch = update.patch;
        return { kind: 'saved', preset: { id: 'preset', homeId: 'home', revision: 2,
          owner: { kind: 'account', accountId: 'author' }, contentEncryptionMode: 'plain',
          ...sealed, setupRevision: update.patch.setupRevision } };
      },
    });
    const result = await executor.execute('machines.presets.update', {
      id: 'preset', homeId: 'home', expectedRevision: 1, patch: { setupRevision: 3 },
    }, { surface: 'cli', authority: 'present_user', runtimeAccountId: 'author', serverId: 'home',
      actionCaller: { kind: 'host' }, presentUserConfirmation: { actionId: 'machines.presets.update' } });
    expect(persistedPatch).toEqual({ setupRevision: 3 });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'saved', preset: { setupRevision: 3 } } });
  });

  it('fails closed when the incumbent is unavailable and strips counter edits from Keep-only patches', async () => {
    const deps = { custody: { accountId: 'author', readWriterMode: async () => 'plain' as const, open: params =>
      openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }), withE2eeAccountKey: () => null, readRecipientCensus: async () => plainCensus },
      readSelectedProvisioners: async () => [], randomBytes: (length: number) => new Uint8Array(length),
    } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[1];
    const request = { actionId: 'machines.presets.update', input: { id: 'preset', homeId: 'home', expectedRevision: 7,
      patch: { retention: { kind: 'until-delete' }, configurationRevision: 88 } }, context: { runtimeAccountId: 'author' } } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[0];
    expect(await managed.prepareManagedMachinePresetAuthoringV1(request, deps)).toMatchObject({
      input: { patch: { retention: { kind: 'until-delete' } } } });
    const prepared = await managed.prepareManagedMachinePresetAuthoringV1(request, deps);
    if (!prepared || 'ok' in prepared) throw new Error('Expected normalized Keep write');
    expect(ManagedMachinePresetUpdateInputV1Schema.parse(prepared.input).patch).not.toHaveProperty('configurationRevision');
    const content = { t: 'plain', v: { v: 1, name: 'Setup', setup: { scripts: [{ body: 'echo setup', affects: 'none' }] } } };
    expect(await managed.prepareManagedMachinePresetAuthoringV1({ ...request, input: { ...request.input, patch: { content } },
      invokeChild: async () => ({ ok: true, result: { kind: 'found', preset: { id: 'preset', homeId: 'home', revision: 7,
        owner: { kind: 'account', accountId: 'author' }, contentEncryptionMode: 'plain',
        content: { t: 'plain', v: { invalidPrivateBody: true } }, recipients: [] } } }) }, deps))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
});

describe('preset author draft sealing', () => {
  // An agent invokes Save with a plaintext draft; the persisted Account mode, reported by the
  // host and confirmed by the recipient census, decides the stored arm.
  const accountKey = new Uint8Array(32).fill(21);
  const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
  const recipientCensus = [{ account: { kind: 'account' as const, accountId: 'author', name: null, firstName: null,
    lastName: null, username: null, avatarUrl: null }, readiness: { status: 'available' as const,
    contentPublicKey: encodeBase64(publicKey), contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) },
    envelopeStatus: 'missing' as const }];
  const owner = { kind: 'account' as const, accountId: 'author' };
  const draft = { v: 1 as const, name: 'Agent draft', setup: { scripts: [
    { body: 'echo one', affects: 'none' as const }, { body: 'echo two', affects: 'none' as const }] } };
  const censusInputs: unknown[] = [];
  let nonce = 50;
  const deps = { custody: { accountId: 'author', readWriterMode: async () => 'e2ee' as const,
    open: params => params.mode === 'plain' ? openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' })
      : openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'e2ee', accountId: 'author', accountKey }),
    withE2eeAccountKey: operation => operation({ accountId: 'author', accountKey }),
    readRecipientCensus: async input => { censusInputs.push(input); return { kind: 'ready', contentEncryptionMode: 'e2ee', recipients: recipientCensus }; } },
    readSelectedProvisioners: async () => [], randomBytes: (length: number) => new Uint8Array(length).fill(nonce++),
  } satisfies Parameters<typeof managed.prepareManagedMachinePresetAuthoringV1>[1];
  const openE2ee = (carrier: { content: unknown; recipients: readonly { accountId: string; envelope: unknown }[] }) =>
    openManagedMachinePresetRecipientProjectionV1({ presetId: 'preset', mode: 'e2ee', accountId: 'author', accountKey,
      projection: { content: carrier.content,
        recipientEnvelope: carrier.recipients.find(recipient => recipient.accountId === 'author')?.envelope ?? null } });

  it('seals a plaintext create draft for an E2EE Account before Save review', async () => {
    const prepared = await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.create',
      input: { id: 'preset', homeId: 'home', owner, contentEncryptionMode: 'plain', content: { t: 'plain', v: draft }, recipients: [] },
      context: { runtimeAccountId: 'author' } }, deps);
    if (!prepared || 'ok' in prepared) throw new Error(`Expected sealed Save: ${JSON.stringify(prepared)}`);
    const input = prepared.input as { contentEncryptionMode: string; content: { t: string }; recipients: { accountId: string; envelope: unknown }[] };
    expect(input).toMatchObject({ contentEncryptionMode: 'e2ee', content: { t: 'encrypted' }, configurationRevision: 0 });
    expect(input.recipients.map(recipient => recipient.accountId)).toEqual(['author']);
    expect(openE2ee(input)).toEqual(draft);
    expect(censusInputs.at(-1)).toEqual({ homeId: 'home', owner });
  });

  it('refuses a plain census for an E2EE Account before preparing the Save carrier', async () => {
    const custody = { ...deps.custody,
      readRecipientCensus: async () => plainCensus };
    const prepared = await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.create',
      input: { id: 'preset', homeId: 'home', owner, contentEncryptionMode: 'plain', content: { t: 'plain', v: draft }, recipients: [] },
      context: { runtimeAccountId: 'author' } }, { ...deps, custody });
    expect(prepared).toMatchObject({ ok: false, errorCode: 'account_mode_mismatch' });
  });

  it('seals a plaintext update draft against the E2EE incumbent and advances its setup revision', async () => {
    const incumbent = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'e2ee', content: draft,
      recipientCensus, randomBytes: length => new Uint8Array(length).fill(3) });
    const next = { ...draft, setup: { scripts: [...draft.setup.scripts, { body: 'echo three', affects: 'none' as const }] } };
    const prepared = await managed.prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.update',
      input: { id: 'preset', homeId: 'home', expectedRevision: 2, patch: { content: { t: 'plain', v: next } } },
      context: { runtimeAccountId: 'author' }, invokeChild: async () => ({ ok: true, result: { kind: 'found', preset: {
        id: 'preset', homeId: 'home', revision: 2, owner, contentEncryptionMode: 'e2ee', ...incumbent } } }) }, deps);
    if (!prepared || 'ok' in prepared) throw new Error(`Expected sealed update: ${JSON.stringify(prepared)}`);
    const { patch } = ManagedMachinePresetUpdateInputV1Schema.parse(prepared.input);
    expect(patch).toMatchObject({ contentEncryptionMode: 'e2ee', content: { t: 'encrypted' }, setupRevision: 1 });
    expect(openE2ee({ content: patch.content, recipients: patch.recipients ?? [] })).toEqual(next);
    expect(censusInputs.at(-1)).toEqual({ homeId: 'home', presetId: 'preset', owner });
  });
});
