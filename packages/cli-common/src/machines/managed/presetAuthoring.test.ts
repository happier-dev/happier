import { describe, expect, it } from 'vitest';
import * as managed from './index.js';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { openManagedMachinePresetContentV1, openManagedMachinePresetRecipientProjectionV1,
  sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { HostReviewedChildrenPreparationRequestV1 } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecutor } from '@happier-dev/protocol/actions';

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
const controller = { machineId: 'author-computer', installationId: 'author-installation' };

describe('preset author source review', () => {
  it('persists the captured carrier through the ordinary Save admission', async () => {
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: {
      v: 1, name: 'Team source', preparation: { enabled: false }, launch: { provider: contribution,
        schemaVersion: 1, name: 'Authored', choices: { source: 'file' } },
    } });
    const deps = { custody: { accountId: 'author',
      open: params => openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }), withE2eeAccountKey: () => null },
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
      custody: { accountId: 'author', open: params =>
        openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }), withE2eeAccountKey: () => null },
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
    }, { custody: { accountId: 'author', open: params => openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }),
      withE2eeAccountKey: () => null }, readSelectedProvisioners: async () => [{ contribution,
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
        custody: { accountId: 'author', open: params => openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }),
          withE2eeAccountKey: () => null },
        readSelectedProvisioners: async () => [{ contribution, occurrenceId: 'installed', acquireExecutionTarget: 'daemon',
          descriptor: MachineProvisionerContributionV1Schema.parse(descriptor) }],
        randomBytes: length => new Uint8Array(length).fill(7),
      });
      if (source === 'image') {
        expect(prepared).toBeNull();
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
