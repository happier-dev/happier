import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, createEmptyMachineSetupDesiredV1, getMachineSetupDesiredV1, mutateMachineSetupDesiredV1,
  type MachineMetadataFieldPortV1, type MachineSetupDesiredV1 } from '@happier-dev/protocol';
import { createMachineSetupPlanAction } from './machineSetupAction';
import { createCombinedMachineSetupActionDeps } from './composeMachineSetup';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { prepareManagedMachineSetupApplyInput } from '@happier-dev/cli-common/machines/managed';

function recipeCatalog(recipeId = 'fonts') {
  const pluginId = 'com.example.machine-tools';
  const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Tools',
    runtime: { apiVersion: 1 }, contributes: { machineRecipes: [{ id: recipeId, revision: '3', title: 'Fonts', software: true,
      inputSchema: { type: 'object', properties: { family: { type: 'string', enum: ['dejavu'] } }, required: ['family'], additionalProperties: false },
      steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
    }] } });
  return createResolvedContributionRegistry({ ...projectLoadedPluginContributes({ provenance: 'external', loadResult: {
    loadedPlugins: [{ pluginId, pluginRootPath: '/plugins/tools', manifestPath: '/plugins/tools/plugin.json', daemonEntryPath: null,
      devDaemonEntryPath: null, sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest }],
    diagnosticsByPluginId: {},
  } }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
}

describe('Machine setup current-copy plan entry', () => {
  it('returns a typed content refusal from combined preparation before asking for Setup approval', async () => {
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'guest', targets: [{
      homeId: 'home', machineId: 'guest', desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }],
      recipePlans: [], exclusions: [],
    }] });
    const deps = createCombinedMachineSetupActionDeps({ readDeps: createUnavailableActionTransportDeps,
      targetPlan: async () => { throw new Error('Prepared plan needs no second target read'); },
      readHostFacts: async () => { throw Object.assign(new Error('api_token_encryption_access_unavailable'),
        { code: 'content_unavailable' }); },
      orchestrationDirectory: '/review',
      startCombined: async () => { throw new Error('Preparation must not start work'); },
      waitForRun: async () => { throw new Error('Preparation must not wait for work'); },
      readInvocations: async () => { throw new Error('Preparation must not read child results'); },
    });
    expect(await deps.prepareMachineSetupApply!({ input, context: { actionRequestId: 'keyless-setup' } }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it.each(['admitted', 'unapproved'] as const)('keeps omitted exclusions at the %s native-leaf boundary without changing ordinary Plan', async admission => {
    let snapshotReads = 0;
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'guest', targets: [{
      homeId: 'home', machineId: 'guest', desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], recipePlans: [],
    }] });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'issued-creation', binding: {
      accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: 'home', machineId: 'guest', installationId: 'installation', actionId: 'machines.setup.apply',
      requestId: 'creation-apply', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'guest' },
      accountEncryptionMode: 'plain', managedContinuation: { managedId: 'managed', creationRequestId: 'creation',
        expectedIntentRevision: 0, controller: { machineId: 'controller', installationId: 'controller-installation' },
        acquireRequestEnvelopeDigest: 'b'.repeat(43) },
    } });
    const deps = createCombinedMachineSetupActionDeps({ readDeps: createUnavailableActionTransportDeps,
      targetPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest', apiMachine: {
        getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
          // Persisted Machine metadata is the boundary. Planning stays real.
          read: async () => { snapshotReads++; return { status: 'ready', metadata: {}, metadataVersion: 0 }; },
          compareAndSwap: async () => { throw new Error('Preparation cannot publish'); },
        }),
      } }),
      readHostFacts: async () => ({ machines: [{ machineId: 'guest', online: true }] }),
      orchestrationDirectory: '/review', startCombined: async () => { throw new Error('Preparation cannot start work'); },
      waitForRun: async () => { throw new Error('Preparation cannot wait for work'); },
      readInvocations: async () => { throw new Error('Preparation cannot read child results'); },
    });
    const prepare = deps.prepareMachineSetupApply;
    if (!prepare) throw new Error('Setup preparation required');
    expect(await prepare({ input, context: admission === 'admitted'
      ? { externalActionExecutionAuthorization: authorization, actionRequestId: 'creation-apply' }
      : { actionRequestId: 'unapproved-request' } }))
      .toMatchObject({ input, preview: { kind: 'machineSetup' } });
    expect(input.targets[0]).not.toHaveProperty('exclusions');
    // The exact issued native leaf is already admitted; an unmatched caller
    // still goes through the ordinary target Plan owner once.
    expect(snapshotReads).toBe(admission === 'admitted' ? 0 : 1);
  });
  it('distinguishes new apps from retained pin edits and legacy unknown apps using admitted current copies', async () => {
    const catalog = (itemId: string, version: string) => ({ kind: 'app' as const, definition: {
      name: itemId, project: { kind: 'existing' as const, projectSourceId: 'project' }, bindings: [],
      definition: { from: 'catalogApp' as const, templateRef: { sourceId: 'catalog', itemId, version,
        ref: { kind: 'version' as const, version } } },
    } });
    const legacy = { kind: 'app' as const, definition: { name: 'Legacy', project: { kind: 'existing' as const, projectSourceId: 'project' },
      definition: { from: 'compose' as const, document: 'services: {}', profiles: [], services: [] }, bindings: [] } };
    const authored = { ...legacy, authoredKey: 'authored-app', definition: { ...legacy.definition, name: 'Authored' } };
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: { ...createEmptyMachineSetupDesiredV1(),
        sources: [{ kind: 'direct', setup: { items: [catalog('dashboard', '1'), legacy, authored] } }] } }, metadataVersion: 1 }),
      compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
    });
    const sources = [{ kind: 'direct' as const, setup: { items: [catalog('dashboard', '2'), catalog('new-app', '1'), legacy,
      { ...authored, definition: { ...authored.definition, definition: { ...authored.definition.definition, document: 'services: {updated: {image: example}}' } } },
      { ...authored, authoredKey: 'new-authored-app' },
    ] } }];
    expect(await prepareMachineSetupPlanV1({ input: { homeId: 'home', machineId: 'guest', sources }, current }))
      .toMatchObject({ sources, appOrigins: [
        { sourceIndex: 0, itemIndex: 0, kind: 'retained' },
        { sourceIndex: 0, itemIndex: 1, kind: 'new' },
        { sourceIndex: 0, itemIndex: 2, kind: 'unknown' },
        { sourceIndex: 0, itemIndex: 3, kind: 'retained' },
        { sourceIndex: 0, itemIndex: 4, kind: 'new' },
      ] });
    expect(await prepareMachineSetupPlanV1({ current, input: { homeId: 'home', machineId: 'guest', sources: [
      { kind: 'direct', setup: { items: [catalog('dashboard', '2'), catalog('dashboard', '3')] } },
    ] } })).toMatchObject({ appOrigins: [
      { sourceIndex: 0, itemIndex: 0, kind: 'unknown' }, { sourceIndex: 0, itemIndex: 1, kind: 'unknown' },
    ] });
  });
  it('plans ready B and C after a positively classified offline A without inferring offline from a target refusal', async () => {
    const snapshotReads: string[] = [];
    const targets = ['a', 'b', 'c'].map(machineId => ({ homeId: 'home', machineId, mode: 'effects' as const }));
    const native = new Map(targets.map(target => [target.machineId, createMachineSetupPlanAction({ ...target,
      apiMachine: { getMachineSetupDesiredSnapshot: () => {
        snapshotReads.push(target.machineId);
        return getMachineSetupDesiredV1({
          read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
          compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
        });
      } },
    })]));
    let classifiedOffline = true;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createCombinedMachineSetupActionDeps({
      readDeps: createUnavailableActionTransportDeps, targetPlan: request => {
        if ('targets' in request.input) throw new Error('Only native target Plans reach this transport');
        return native.get(request.input.machineId)!(request);
      },
      readHostFacts: async () => ({ machines: targets.map(target => ({ machineId: target.machineId, online: target.machineId !== 'a' })),
        ...(classifiedOffline ? { offlineMachineIds: ['a'] } : {}) }),
      orchestrationDirectory: '/review', startCombined: async () => { throw new Error('Plan cannot start work'); },
      waitForRun: async () => { throw new Error('Plan cannot wait for work'); },
      readInvocations: async () => { throw new Error('Plan cannot read child results'); },
    }) });
    let repeatedAdmissionReads = 0;
    const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'review-proof', binding: {
      accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: 'home', machineId: 'b', installationId: 'installation', actionId: 'machines.setup.plan',
      requestId: 'review', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'b' },
      accountEncryptionMode: 'plain',
    } }), requesterHttpProjection: { accountId: 'actor', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://review.example.test',
      isCurrent: async () => { repeatedAdmissionReads++; return true; }, createRequestHeaders: async () => null } };
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'b', targets }, {
      surface: 'cli', authority: 'present_user', externalActionExecutionAuthorization: authorization,
    }))
      .toMatchObject({ ok: true, result: { targets: [
        { homeId: 'home', machineId: 'a', status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' },
        { homeId: 'home', machineId: 'b', plan: { desiredRevision: 0 } },
        { homeId: 'home', machineId: 'c', plan: { desiredRevision: 0 } },
      ], review: { machineId: 'b' } } });
    expect(snapshotReads).toEqual(['b', 'c']);
    expect(repeatedAdmissionReads).toBe(0);
    // A row that only lacks reachability is not a classified target refusal.
    // Without the owning presence fact, the real target Plan still decides it.
    classifiedOffline = false;
    native.delete('a');
    const refused = createMachineSetupPlanAction({ homeId: 'other-home', machineId: 'a', apiMachine: {
      getMachineSetupDesiredSnapshot: async () => { throw new Error('Rejected target cannot read content'); },
    } });
    native.set('a', refused);
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'b', targets }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
    expect(snapshotReads).toEqual(['b', 'c']);
  });
  it('retains target-owned sibling facts through Plan without copying them into managed creation input', async () => {
    const ref = { pluginId: 'com.example.machine-tools', recipeId: 'unavailable', revision: '1' };
    const item = { kind: 'softwareRecipe' as const, selection: { ref, inputs: {} } };
    const setup = { items: [item] };
    const key = createCanonicalJsonSigningInput(item);
    const creation = { preset: { id: 'preset', revision: 1 }, setup };
    const sources = [{ kind: 'accountPreset' as const, presetId: 'preset', presetRevision: 1, setup }, { kind: 'direct' as const, setup: {} }];
    const sourceFacts = { 'account:preset': { firstPresence: { [key]: 'absent' as const } } };
    const exclusions = [{ ref, reason: 'not_selected' as const }];
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: { version: 1, revision: 2, sources, exclusions, sourceFacts } }, metadataVersion: 2 }),
      compareAndSwap: async () => { throw new Error('Preparation cannot publish'); },
    });
    const target = { homeId: 'home', machineId: 'guest' };
    const readPlan: Parameters<typeof prepareManagedMachineSetupApplyInput>[0]['readPlan'] = async input => {
      const result = await prepareMachineSetupPlanV1({ input, current,
        readRecipes: async () => { throw new Error('Excluded current copies cannot demand catalog access'); } });
      expect(result).toMatchObject({ sourceFacts });
      return 'ok' in result ? result : { ok: true, result };
    };
    const prepared = await prepareManagedMachineSetupApplyInput({ target, creation, readPlan });
    expect(prepared).toMatchObject({ targets: [{ ...target, sources, desiredRevision: 2, recipePlans: [], exclusions }] });
    expect(prepared).not.toHaveProperty('targets.0.sourceFacts');
    expect(await prepareManagedMachineSetupApplyInput({ target, creation: { ...creation, setup: {} }, readPlan }))
      .toMatchObject({ ok: false, errorCode: 'plan_changed' });
  });
  it('keeps the full copied Preset while planning only the reviewed recipe slice at its original coordinates', async () => {
    const unavailableRef = { pluginId: 'com.example.machine-tools', recipeId: 'unavailable', revision: '1' };
    const fontRef = { ...unavailableRef, recipeId: 'fonts', revision: '3' };
    const app = { kind: 'app', definition: { name: 'Retained app', project: { kind: 'existing', projectSourceId: 'project' },
      definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] }, bindings: [] } };
    const sources = [{ kind: 'bundledPreset', ref: { pluginId: unavailableRef.pluginId, localId: 'private-box', revision: '1' }, setup: {
      scripts: [{ body: '\r\necho full copy\r\n', affects: 'none' }, { body: '' }], items: [
        { kind: 'setupRecipe', selection: { ref: unavailableRef, inputs: {} } }, app,
        { kind: 'softwareRecipe', selection: { ref: fontRef, inputs: { family: 'dejavu' } } },
      ],
    } }, { kind: 'direct', setup: {} }];
    const excluded = { ref: unavailableRef, reason: 'not_selected' };
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: unavailableRef.pluginId, version: '1.0.0', displayName: 'Tools', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: recipeCatalog().machineRecipes!.map(entry => ({ ...entry.definition, steps: [] })) },
    } }] });
    let catalogReads = 0;
    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest',
        apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
          read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
          compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
        }) }, runNative: async () => { throw new Error('Excluded and empty recipes cannot demand native work'); },
        acquirePluginRuntimeRegistryLease: () => { catalogReads++; return acquireAuthoritativePluginRuntimeRegistryLease({
          controller: runtime.controller, happyHomeDir: runtime.happyHomeDir,
        }); },
      }) });
      const input = { homeId: 'home', machineId: 'guest', mode: 'effects', sources };
      expect(await executor.execute('machines.setup.plan', { ...input,
        exclusions: [excluded, { ref: fontRef, reason: 'not_selected' }] }, { surface: 'cli', authority: 'present_user' }))
        .toMatchObject({ ok: true, result: { sources,
          exclusions: [excluded, { ref: fontRef, reason: 'not_selected' }], recipePlans: [],
        } });
      expect(catalogReads).toBe(0);
      const selected = await executor.execute('machines.setup.plan', { ...input, exclusions: [excluded] },
        { surface: 'cli', authority: 'present_user' });
      expect(selected).toMatchObject({ ok: true, result: { sources, exclusions: [excluded],
        recipePlans: [{ sourceIndex: 0, itemIndex: 2, plan: { basis: { selection: { ref: fontRef } }, steps: [] } }],
      } });
      if (!selected.ok || !selected.result || typeof selected.result !== 'object' || !('recipePlans' in selected.result))
        throw new Error('Expected the selected recipe plan');
      expect(selected.result.recipePlans).toHaveLength(1);
      expect(catalogReads).toBe(1);
      const conflict = { ...input, sources: [sources[0], { kind: 'direct', setup: { items: [{
        kind: 'softwareRecipe', selection: { ref: { ...fontRef, revision: '2' }, inputs: { family: 'dejavu' } },
      }] } }], exclusions: [excluded, { ref: fontRef, reason: 'not_selected' }] };
      expect(await executor.execute('machines.setup.plan', conflict, { surface: 'cli', authority: 'present_user' }))
        .toMatchObject({ ok: false, errorCode: 'machine_setup_conflict' });
      expect(catalogReads).toBe(1);
      for (const exclusions of [[{ ref: { ...fontRef, revision: 'unbound' }, reason: 'not_selected' }], [excluded, excluded]]) {
        expect(await executor.execute('machines.setup.plan', { ...input, exclusions }, { surface: 'cli', authority: 'present_user' }))
          .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      }
      expect(catalogReads).toBe(1);
    } finally { await runtime.dispose(); }
  });
  it('preserves retained exclusions when omitted and treats an explicit empty list as reviewed clearing', async () => {
    const ref = { pluginId: 'com.example.machine-tools', recipeId: 'unavailable', revision: '1' };
    const sources = [{ kind: 'direct', setup: { items: [{
      kind: 'setupRecipe', selection: { ref, inputs: {} },
    }] } }];
    const exclusions = [{ ref, reason: 'not_selected' }];
    let catalogReads = 0;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadata: { setup: { version: 1, revision: 4, sources, exclusions } }, metadataVersion: 0 }),
        compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
      }) }, runNative: async () => { throw new Error('Excluded recipe has no native demand'); },
      acquirePluginRuntimeRegistryLease: async () => { catalogReads++; throw new Error('Unavailable recipe catalog'); },
    }) });
    const input = { homeId: 'home', machineId: 'guest', mode: 'effects' };
    expect(await executor.execute('machines.setup.plan', input, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { sources, exclusions, recipePlans: [] } });
    expect(catalogReads).toBe(0);
    expect(await executor.execute('machines.setup.plan', { ...input, exclusions: [] }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'machine_recipe_unavailable' });
    expect(catalogReads).toBe(1);
  });
  it('keeps an excluded detached item in direct without inspecting its unselected removal offer', async () => {
    const ref = { pluginId: 'com.example.machine-tools', recipeId: 'unavailable', revision: '1' };
    const item = { kind: 'softwareRecipe' as const, selection: { ref, inputs: {} } };
    const itemKey = createCanonicalJsonSigningInput(item);
    const exclusions = [{ ref, reason: 'not_selected' as const }];
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: { version: 1, revision: 2, exclusions, sources: [
        { kind: 'accountPreset', presetId: 'detached', presetRevision: 1, setup: { items: [item] } },
        { kind: 'direct', setup: {} },
      ], sourceFacts: { 'account:detached': { firstPresence: { [itemKey]: 'absent' } } } } }, metadataVersion: 2 }),
      compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
    });
    let catalogReads = 0;
    const result = await prepareMachineSetupPlanV1({ current, input: { homeId: 'home', machineId: 'guest', mode: 'effects',
      sources: [{ kind: 'direct', setup: {} }], removeItemKeys: [] },
      readRecipes: async () => { catalogReads++; throw new Error('Retained excluded copies have no catalog demand'); },
      runNative: async () => { throw new Error('Unselected excluded removal has no native demand'); },
    });
    expect(result).toMatchObject({ exclusions, recipePlans: [], support: [],
      sources: [{ kind: 'direct', setup: { items: [item] } }],
      removalOffers: [{ itemKey, selected: false, status: 'notEligible', reason: 'needsCheck' }], removalPlans: [],
    });
    expect(catalogReads).toBe(0);
  });
  it('returns canonical ordered script bodies and siblings through the public effects Plan without native work', async () => {
    const sources = [{ kind: 'direct', setup: { scripts: [
      { body: 'echo first\r\n', affects: 'none', check: { executable: 'fixture-check', args: ['first'], unsatisfiedExitCodes: [1] } },
      { body: '' }, { body: 'echo second\n', affects: 'none' },
    ] } }];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
        compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
      }) }, runNative: async () => { throw new Error('Plan must not execute script checks or bodies'); },
      acquirePluginRuntimeRegistryLease: async () => { throw new Error('Script-only Plan has no recipe demand'); },
    }) });
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest', mode: 'effects', sources },
      { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: {
      sources, recipePlans: [], review: { administratorRequired: false, downtime: 'unknown' },
    } });
  });
  it.each(['abort', 'authority'] as const)('settles admitted native review when %s retires during the public host roster read', async reason => {
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseRead = resolve; });
    const controller = new AbortController();
    let current = true;
    const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'review-proof', binding: {
      accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: 'home', machineId: 'guest', installationId: 'installation', actionId: 'machines.setup.plan',
      requestId: 'review', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'guest' },
      accountEncryptionMode: 'plain',
    } }), requesterHttpProjection: { accountId: 'actor', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://review.example.test',
      isCurrent: async () => current, createRequestHeaders: async () => null } };
    const native = createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest', apiMachine: {
      getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
        compareAndSwap: async () => { throw new Error('Review cannot publish'); },
      }),
    } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createCombinedMachineSetupActionDeps({ targetPlan: native, readDeps: createUnavailableActionTransportDeps,
      readHostFacts: async () => { readStarted(); await held;
        if (reason === 'authority') throw Object.assign(new Error('The current machine inventory is unavailable.'), { code: 'machine_inventory_unavailable' });
        return { machines: [{ machineId: 'guest', online: true }] };
      },
      orchestrationDirectory: '/review',
      startCombined: async () => { throw new Error('Review cannot start work'); },
      waitForRun: async () => { throw new Error('Review cannot wait for work'); },
      readInvocations: async () => { throw new Error('Review cannot read child results'); },
    }) });
    const pending = executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest', mode: 'effects' },
      { surface: 'cli', authority: 'present_user', signal: controller.signal, externalActionExecutionAuthorization: authorization });
    await started;
    if (reason === 'abort') controller.abort(); else current = false;
    releaseRead();
    expect(await pending).toMatchObject(reason === 'abort' ? { ok: false, errorCode: 'cancelled' }
      : { ok: true, result: { desiredRevision: 0, review: { target: { homeId: 'home', machineId: 'guest' } } } });
  });
  it('projects public scalar effects host choices through the same combined host owner and leaves current reads inert', async () => {
    let rosterReads = 0;
    let rosterUnavailable = false;
    let guestOnline = true;
    const native = createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest', apiMachine: {
      getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
        compareAndSwap: async () => { throw new Error('Review cannot publish'); },
      }),
    } });
    const deps = createCombinedMachineSetupActionDeps({ targetPlan: native, readDeps: createUnavailableActionTransportDeps,
      // The incumbent captured Account roster is the network boundary; host choice remains real.
      readHostFacts: async () => { rosterReads++; if (rosterUnavailable) throw new Error('Account roster network unavailable'); return { machines: [
        { machineId: 'guest', online: guestOnline }, { machineId: 'other', online: false },
      ] }; },
      orchestrationDirectory: '/review',
      startCombined: async () => { throw new Error('Review cannot start work'); },
      waitForRun: async () => { throw new Error('Review cannot wait for work'); },
      readInvocations: async () => { throw new Error('Review cannot read child results'); },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const target = { homeId: 'home', machineId: 'guest' };
    await executor.execute('machines.setup.plan', target, { surface: 'cli', authority: 'present_user' });
    expect(rosterReads).toBe(0);
    expect(await executor.execute('machines.setup.plan', { ...target, mode: 'effects' }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { review: { target, host: { machineId: 'guest', machines: [
        { machineId: 'guest', online: true }, { machineId: 'other', online: false },
      ] } } } });
    expect(rosterReads).toBe(1);
    rosterUnavailable = true;
    const withoutRoster = await executor.execute('machines.setup.plan', { ...target, mode: 'effects' }, { surface: 'cli', authority: 'present_user' });
    expect(withoutRoster).toMatchObject({ ok: true, result: { review: { target, administratorRequired: false, downtime: 'none' } } });
    expect(withoutRoster).not.toHaveProperty('result.review.host');
    expect(rosterReads).toBe(2);
    rosterUnavailable = false;
    guestOnline = false;
    expect(await executor.execute('machines.setup.plan', { ...target, mode: 'effects' }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { review: { target, host: { machineId: null, machines: [
        { machineId: 'guest', online: false }, { machineId: 'other', online: false },
      ] } } } });
  });
  it('publishes exact target review facts only for explicit effects without pretending to inspect arbitrary scripts', async () => {
    const desired = createEmptyMachineSetupDesiredV1();
    let reads = 0;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => { reads++; return { status: 'ready', metadata: { setup: desired }, metadataVersion: 0 }; },
        compareAndSwap: async () => { throw new Error('Review cannot publish'); },
      }) },
      runNative: async () => { throw new Error('Native-free review cannot probe'); },
      acquirePluginRuntimeRegistryLease: async () => { throw new Error('Native-free review cannot load recipes'); },
    }) });
    const target = { homeId: 'home', machineId: 'guest' };
    expect(await executor.execute('machines.setup.plan', target, { surface: 'cli', authority: 'present_user' }))
      .not.toHaveProperty('result.review');
    expect(await executor.execute('machines.setup.plan', { ...target, mode: 'effects' }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { review: { target, administratorRequired: false, downtime: 'none' } } });
    for (const [setupScriptAffects, downtime] of [['dockerEngine', 'possible'], ['none', 'unknown'], [undefined, 'unknown']] as const) {
      expect(await executor.execute('machines.setup.plan', { ...target, mode: 'effects', sources: [
        { kind: 'direct', setup: { scripts: [{ body: 'echo retained\r\n', ...(setupScriptAffects ? { affects: setupScriptAffects } : {}) }],  } },
      ] }, { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: {
        review: { target, administratorRequired: false, downtime },
      } });
    }
    expect(await executor.execute('machines.setup.plan', { ...target, mode: 'effects', sources: [
      { kind: 'direct', setup: { items: [{ kind: 'app', definition: {
        name: 'Uninspected app', project: { kind: 'existing', projectSourceId: 'project' },
        definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] }, bindings: [],
      } }] } },
    ] }, { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: {
      support: [{ sourceIndex: 0, itemIndex: 0, status: 'unsupported' }],
      review: { target, administratorRequired: null, downtime: 'unknown' },
    } });
    for (const setupScriptAffects of ['none', 'dockerEngine'] as const) {
      expect(await executor.execute('machines.setup.plan', { ...target, mode: 'effects', sources: [
        { kind: 'direct', setup: { scripts: [{ body: 'echo retained\r\n', affects: setupScriptAffects, check: { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1], requiredFacts: [{ kind: 'administrator' }] } }],

        } },
      ] }, { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: {
        review: { target, administratorRequired: null, downtime: 'unknown' },
      } });
    }
    expect(reads).toBe(8);
  });
  it('rejects a reviewed repository outside its declared root at input admission before native reads', async () => {
    const registry = recipeCatalog();
    const entry = Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById)[0]!;
    const definition = { ...entry.definition, steps: [], inputSchema: { type: 'object' as const,
      properties: { root: { type: 'string' as const }, repository: { type: 'string' as const } },
      required: ['root', 'repository'], additionalProperties: false },
      inputConstraints: [{ kind: 'pathWithin' as const, path: 'repository', root: 'root' }],
    };
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
    });
    let nativeReads = 0;
    for (const repository of ['/srv/jail2/repository', '/srv/jail', '/srv/jail/../outside', '/srv/jail/child/../../outside', '/srv/jail\\outside']) {
      const result = await prepareMachineSetupPlanV1({ current,
        input: { homeId: 'home', machineId: 'guest', sources: [{ kind: 'direct', setup: { items: [{
          kind: 'softwareRecipe', selection: { ref: { pluginId: entry.pluginId, recipeId: definition.id, revision: definition.revision },
            inputs: { root: '/srv/jail', repository } },
        }] } }] },
        readRecipes: async () => [{ ...entry, definition }],
        runNative: async () => { nativeReads++; throw new Error('Invalid inputs cannot reach native reads'); },
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
    }
    const valid = await prepareMachineSetupPlanV1({ current,
      input: { homeId: 'home', machineId: 'guest', sources: [{ kind: 'direct', setup: { items: [{
        kind: 'softwareRecipe', selection: { ref: { pluginId: entry.pluginId, recipeId: definition.id, revision: definition.revision },
          inputs: { root: '/srv/jail', repository: '/srv/jail/repository' } },
      }] } }] }, readRecipes: async () => [{ ...entry, definition }],
      runNative: async () => { nativeReads++; throw new Error('An empty recipe has no native probes'); },
    });
    expect(valid).toMatchObject({ support: [{ status: 'satisfied' }], recipePlans: [{ plan: { steps: [] } }] });
    expect(nativeReads).toBe(0);
  });

  it('keeps retained-copy reads inert but prepares exact effects when explicitly requested', async () => {
    const sources = [{ kind: 'direct' as const, setup: { items: [{
      kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '3' },
        inputs: { family: 'dejavu' } },
    }] } }];
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: { ...createEmptyMachineSetupDesiredV1(), sources } }, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
    });
    const registry = recipeCatalog();
    let catalogReads = 0;
    let nativeReads = 0;
    const params = { current, input: { homeId: 'home', machineId: 'guest', sources },
      readRecipes: async () => { catalogReads++; return Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById); },
      runNative: async () => { nativeReads++; return { code: 0, stdout: '', stderr: '' }; },
    };
    expect(await prepareMachineSetupPlanV1(params)).not.toHaveProperty('recipePlans');
    expect([catalogReads, nativeReads]).toEqual([0, 0]);
    expect(await prepareMachineSetupPlanV1({ ...params, input: { ...params.input, mode: 'effects' } }))
      .toMatchObject({ desiredRevision: 0, sources, recipePlans: [{ sourceIndex: 0, itemIndex: 0,
        plan: { basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0, selection: sources[0]!.setup.items[0]!.selection } } }] });
    expect(catalogReads).toBe(1);
    expect(nativeReads).toBeGreaterThan(0);
    const empty = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
    });
    expect(await prepareMachineSetupPlanV1({ input: { homeId: 'home', machineId: 'guest', mode: 'effects' }, current: empty }))
      .toMatchObject({ desiredRevision: 0, recipePlans: [] });
  });
  it('admits a managed child current read but never a proposed-source read under that creation proof', async () => {
    let reads = 0;
    const plan = createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => { reads++; return { status: 'ready', metadata: {}, metadataVersion: 0 }; },
        compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
      }) } });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'existing-managed-child-proof', binding: {
      accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: 'home', machineId: 'guest', installationId: 'installation', actionId: 'machines.setup.plan',
      requestId: 'creation', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'guest' },
      accountEncryptionMode: 'plain', managedContinuation: { managedId: 'managed', creationRequestId: 'creation',
        expectedIntentRevision: 0, controller: { machineId: 'controller', installationId: 'controller-installation' },
        acquireRequestEnvelopeDigest: 'b'.repeat(43) },
    } });
    const context = { surface: 'rpc' as const, externalActionExecutionAuthorization: authorization };
    const input = { homeId: 'home', machineId: 'guest' };
    expect(await plan({ input: { ...input, sources: createEmptyMachineSetupDesiredV1().sources }, context }))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(reads).toBe(0);
    expect(await plan({ input, context })).toMatchObject({ desiredRevision: 0 });
    expect(reads).toBe(1);
  });
  it('refuses a declared recipe whose physical source is not admitted by the receiving runtime', async () => {
    const source = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {},
      manifest: { schemaVersion: 2, id: 'com.example.machine-tools', version: '1.0.0', displayName: 'Tools',
        runtime: { apiVersion: 1 }, contributes: { machineRecipes: recipeCatalog().machineRecipes!.map(entry => entry.definition) } },
    }] });
    try {
      // The declaration exists physically in another owner Home, not as a
      // trusted generation in this receiver. Real source admission decides that.
      const receiver = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
        contributes: source.registry.contributes, pluginIds: [],
      } });
      try {
        expect(receiver.registry.contributes.machineRecipes).toEqual(expect.arrayContaining([
          expect.objectContaining({ pluginId: 'com.example.machine-tools' }),
        ]));
        expect(Object.values(buildPluginProjectionFamilyV2({ registry: receiver.registry.contributes,
          generation: receiver.registry.generation }, machineRecipesProjectionFamily).entriesById))
          .not.toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: 'com.example.machine-tools' })]));
        const plan = createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
          apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
            read: async () => ({ status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 0 }),
            compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
          }) },
          acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({
            controller: receiver.controller, happyHomeDir: receiver.happyHomeDir,
          }),
        });
        expect(await plan({ input: MachineSetupPlanInputV1Schema.parse({ homeId: 'home', machineId: 'guest', sources: [
          { kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
            ref: { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '3' }, inputs: { family: 'dejavu' },
          } }] } },
        ] }), context: { surface: 'cli', authority: 'present_user' } }))
          .toMatchObject({ ok: false, errorCode: 'machine_recipe_unavailable' });
      } finally { await receiver.dispose(); }
    } finally { await source.dispose(); }
  });

  it('admits new software selections only at the catalog exact revision and closed input schema', async () => {
    const pluginId = 'com.example.machine-tools';
    const registry = recipeCatalog();
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
    });
    const input = (revision: string, inputs: unknown) => MachineSetupPlanInputV1Schema.parse({ homeId: 'home', machineId: 'guest',
      sources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
        ref: { pluginId, recipeId: 'fonts', revision }, inputs,
      } }] } }],
    });
    const params = { input: input('3', { family: 'dejavu' }), current, readRecipes: async () => Object.values(
      buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById) };
    expect(await prepareMachineSetupPlanV1(params)).toMatchObject({ sources: params.input.sources });
    expect(await prepareMachineSetupPlanV1({ ...params, input: input('2', { family: 'dejavu' }) }))
      .toMatchObject({ ok: false, errorCode: 'machine_recipe_unavailable' });
    expect(await prepareMachineSetupPlanV1({ ...params, input: input('3', { family: 'unreviewed', secret: 'not-allowed' }) }))
      .toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
  });

  it('retains an unavailable saved item within its direct source when adding a newly admitted item', async () => {
    const retained = { kind: 'softwareRecipe' as const, selection: {
      ref: { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '2' }, inputs: { family: 'dejavu' },
    } };
    const added = { ...retained, selection: { ...retained.selection, ref: { ...retained.selection.ref, recipeId: 'other-fonts', revision: '3' } } };
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: { version: 1, revision: 2, exclusions: [], sources: [
        { kind: 'direct', setup: { items: [retained] } },
      ] } }, metadataVersion: 2 }),
      compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
    });
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'home', machineId: 'guest', sources: [
      { kind: 'direct', setup: { items: [retained, added] } },
    ] });
    const registry = recipeCatalog('other-fonts');
    const readRecipes = async () => Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById);
    expect(await prepareMachineSetupPlanV1({ input, current, readRecipes })).toMatchObject({ sources: input.sources });
    // The copy cannot be transferred to a different source identity to bypass admission.
    expect(await prepareMachineSetupPlanV1({ current, readRecipes, input: { ...input, sources: [
      { kind: 'accountPreset', presetId: 'different-authority', presetRevision: 1, setup: { items: [retained] } },
      { kind: 'direct', setup: {} },
    ] } })).toMatchObject({ ok: false, errorCode: 'machine_recipe_unavailable' });
    const transfer = { ...input, removeItemKeys: [], sources: [
      { kind: 'accountPreset' as const, presetId: 'different-authority', presetRevision: 1, setup: { items: [retained] } },
      { kind: 'direct' as const, setup: {} },
    ] };
    expect(await prepareMachineSetupPlanV1({ current, readRecipes, input: transfer }))
      .toMatchObject({ ok: false, errorCode: 'machine_recipe_unavailable' });
  });

  it('keeps a detached unavailable item in direct without granting caller-selected transfers another origin', async () => {
    const oldItem = { kind: 'softwareRecipe' as const, selection: {
      ref: { pluginId: 'com.example.machine-tools', recipeId: 'old-fonts', revision: '2' }, inputs: { family: 'dejavu' },
    } };
    const added = { ...oldItem, selection: { ...oldItem.selection, ref: { ...oldItem.selection.ref, recipeId: 'fonts', revision: '3' } } };
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: { version: 1, revision: 2, exclusions: [], sources: [
        { kind: 'bundledPreset', ref: { pluginId: 'com.example.machine-tools', localId: 'old', revision: '1' }, setup: { items: [oldItem] } },
        { kind: 'direct', setup: {} },
      ] } }, metadataVersion: 2 }),
      compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
    });
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'home', machineId: 'guest', sources: [
      { kind: 'direct', setup: { items: [added] } },
    ] });
    const registry = recipeCatalog();
    const readRecipes = async () => Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById);
    expect(await prepareMachineSetupPlanV1({ input, current, readRecipes })).toMatchObject({ sources: [
      { kind: 'direct', setup: { items: [added, oldItem] } },
    ] });
    let reads = 0;
    const unchanged = { ...input, sources: [{ kind: 'direct' as const, setup: {} }],
      mode: 'effects' as const, removeItemKeys: [] };
    const reviewed = await prepareMachineSetupPlanV1({ input: unchanged, current, readRecipes: async () => { reads++; return []; } });
    expect(reviewed).toMatchObject({ removeItemKeys: [], sources: [{ kind: 'direct', setup: { items: [oldItem] } }], recipePlans: [], support: [] });
    if ('ok' in reviewed) throw new Error('Expected canonical default-kept copies');
    const rechecked = { ...unchanged, sources: reviewed.sources };
    expect(await prepareMachineSetupPlanV1({ input: rechecked, current, readRecipes: async () => { reads++; return []; } }))
      .toMatchObject({ removeItemKeys: [], sources: reviewed.sources, recipePlans: [], support: [] });
    const noMode = { homeId: input.homeId, machineId: input.machineId, sources: unchanged.sources, removeItemKeys: [] };
    expect(await prepareMachineSetupPlanV1({ input: noMode, current, readRecipes: async () => { reads++; return []; } }))
      .toMatchObject({ removeItemKeys: [], sources: [{ kind: 'direct', setup: { items: [oldItem] } }], support: [] });
    expect(reads).toBe(0);
    expect(input.sources?.[0]?.setup.items).toEqual([added]);
    expect(await prepareMachineSetupPlanV1({ current, readRecipes, input: { ...input, sources: [
      { kind: 'accountPreset', presetId: 'different-authority', presetRevision: 1, setup: { items: [oldItem] } },
      { kind: 'direct', setup: { items: [added] } },
    ] } })).toMatchObject({ ok: false, errorCode: 'machine_recipe_unavailable' });
  });

  it.each(['authority', 'cancel'] as const)('keeps captured new-selection review under Home withdrawal but cancels locally (%s)', async reason => {
    let releaseStarted!: () => void;
    let settleRelease!: () => void;
    const releasing = new Promise<void>(resolve => { releaseStarted = resolve; });
    const heldRelease = new Promise<void>(resolve => { settleRelease = resolve; });
    const controller = new AbortController();
    let current = true;
    let metadataReads = 0;
    let leaseAcquisitions = 0;
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {},
      manifest: { schemaVersion: 2, id: 'com.example.machine-tools', version: '1.0.0', displayName: 'Tools',
        runtime: { apiVersion: 1 }, contributes: { machineRecipes: recipeCatalog().machineRecipes!.map(entry => entry.definition) } },
    }] });
    try {
    const plan = createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => { metadataReads++; return { status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 0 }; },
        compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
      }) },
      acquirePluginRuntimeRegistryLease: async () => {
        leaseAcquisitions++;
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ controller: runtime.controller, happyHomeDir: runtime.happyHomeDir });
        const release = lease.release.bind(lease);
        // Scheduling only: the actual admitted lease still settles through its
        // controller, so no internal registry/lifecycle behavior is substituted.
        vi.spyOn(lease, 'release').mockImplementation(async () => {
          releaseStarted();
          await heldRelease;
          await release();
        });
        return lease;
      },
    });
    const sources = [
      { kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
        ref: { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '3' }, inputs: { family: 'dejavu' },
      } }] } },
    ];
    const request: Parameters<typeof plan>[0] = { input: MachineSetupPlanInputV1Schema.parse({ homeId: 'home', machineId: 'guest', sources }),
      context: { surface: 'cli', authority: 'present_user', signal: controller.signal,
      machineAdmission: { actorAccountId: 'actor', custodianAccountId: 'owner', machineId: 'guest', installationId: 'installation',
        role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => current } };
    const pending = plan(request);
    await releasing;
    if (reason === 'cancel') controller.abort(); else current = false;
    settleRelease();
    if (reason === 'cancel') {
      expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled' });
    } else {
      // Only the already-consumed Home admission changed; the actual admitted
      // recipe lease was released normally and the captured read may finish.
      expect(await pending).toMatchObject({ desiredRevision: 0, sources,
        recipePlans: [{ sourceIndex: 0, itemIndex: 0 }] });
      expect(await plan(request)).toMatchObject({ ok: false, errorCode: 'machine_admission_changed' });
    }
    expect(metadataReads).toBe(1);
    expect(leaseAcquisitions).toBe(1);
    } finally { settleRelease(); await runtime.dispose(); }
  });

  it('completes captured saved copies after Home withdrawal and refuses the next Plan before reading metadata', async () => {
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseRead = resolve; });
    let current = true;
    let writes = 0;
    let reads = 0;
    const port: MachineMetadataFieldPortV1 = {
      read: async () => {
        reads++;
        readStarted();
        await held;
        return { status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 1 };
      },
      compareAndSwap: async () => { writes++; throw new Error('Planning cannot publish'); },
    };
    const plan = createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1(port) } });
    const request: Parameters<typeof plan>[0] = { input: { homeId: 'home', machineId: 'guest' }, context: {
      surface: 'cli', authority: 'present_user', machineAdmission: {
        actorAccountId: 'actor', custodianAccountId: 'owner', machineId: 'guest', installationId: 'installation',
        role: 'manage', encryptionMode: 'plain',
      }, verifyMachineAdmissionCurrent: async () => current,
    } };
    const pending = plan(request);
    await started;
    current = false;
    releaseRead();
    expect(await pending).toMatchObject({ desiredRevision: 0, sources: createEmptyMachineSetupDesiredV1().sources, support: [] });
    expect(await plan(request)).toEqual({ ok: false, errorCode: 'machine_admission_changed', error: 'machine_admission_changed' });
    expect(reads).toBe(1);
    expect(writes).toBe(0);
  });

  it('loads current copies after the first successful desired write without a stale direct fence', async () => {
    let metadata: Record<string, unknown> = { setup: createEmptyMachineSetupDesiredV1() };
    let metadataVersion = 0;
    const port: MachineMetadataFieldPortV1 = {
      read: async () => ({ status: 'ready', metadata, metadataVersion }),
      compareAndSwap: async input => {
        metadata = input.metadata;
        metadataVersion++;
        return { status: 'applied', metadata, metadataVersion };
      },
    };
    expect(await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 0, exclusions: [],
      sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo ready\r\n' }] } }],
    }, port)).toMatchObject({ status: 'applied' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1(port) } }) });
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest' },
      { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: {
      desiredRevision: 1, sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo ready\r\n' }] } }],
    } });
    expect(metadataVersion).toBe(1);
  });

  it('reads exact saved copies through the real Action entry without any publication or native work', async () => {
    const desired: MachineSetupDesiredV1 = { version: 1, revision: 2, exclusions: [], sources: [
      { kind: 'accountPreset', presetId: 'retained', presetRevision: 1,
        setup: { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' }],  } },
      { kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
        ref: { pluginId: 'example.machine', recipeId: 'fonts', revision: '1' }, inputs: {} } }] } },
    ] };
    let reads = 0;
    let writes = 0;
    let nativeReads = 0;
    const port: MachineMetadataFieldPortV1 = {
      read: async () => { reads++; return { status: 'ready', metadata: { setup: desired }, metadataVersion: 7 }; },
      compareAndSwap: async () => { writes++; throw new Error('Planning cannot publish'); },
    };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1(port) },
      runNative: async () => { nativeReads++; throw new Error('Saved-copy reads cannot demand native facts'); },
    }) });
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest' },
      { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: {
      desiredRevision: 2, sources: desired.sources, exclusions: [],
      support: [{ sourceIndex: 1, itemIndex: 0, status: 'unsupported', reason: 'required_fact_unavailable' }],
    } });
    expect(reads).toBe(1);
    expect(writes).toBe(0);
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest', sources: desired.sources },
      { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: { sources: desired.sources } });
    expect(reads).toBe(2);
    expect(await executor.execute('machines.setup.plan', { homeId: 'other', machineId: 'guest' },
      { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'target_mismatch' });
    expect(reads).toBe(2);
    expect(await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest',
      sources: createEmptyMachineSetupDesiredV1().sources }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { desiredRevision: 2, sources: createEmptyMachineSetupDesiredV1().sources } });
    expect(writes).toBe(0);
    expect(nativeReads).toBe(0);
  });

  it('keeps locked and invalid content distinct from an omitted desired value', async () => {
    let opened = false;
    const port: MachineMetadataFieldPortV1 = {
      read: async () => opened ? { status: 'ready', metadata: { setup: null }, metadataVersion: 1 } : { status: 'locked' },
      compareAndSwap: async () => { throw new Error('Planning cannot publish'); },
    };
    const plan = createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1(port) } });
    const request = { input: { homeId: 'home', machineId: 'guest' }, context: { surface: 'cli' as const, authority: 'present_user' as const } };
    expect(await plan(request)).toMatchObject({ ok: false, errorCode: 'machine_setup_content_locked' });
    opened = true;
    expect(await plan(request)).toMatchObject({ ok: false, errorCode: 'machine_setup_content_invalid' });
  });
});
