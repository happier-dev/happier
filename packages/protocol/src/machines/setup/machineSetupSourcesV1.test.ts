import { describe, expect, it, vi } from 'vitest';
import type { MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';
import { MachineSetupApplyInputV1Schema, readMachineSetupPlanChildInputV1 } from '../managed/actionsV1.js';
import {
  createEmptyMachineSetupDesiredV1,
  getMachineSetupDesiredV1,
  MachineSetupDesiredV1Schema,
  MachineSetupSourceV1Schema,
  mutateMachineSetupDesiredV1,
  machineSetupItemKeyV1, machineSetupSourceOriginKeyV1, projectMachineSetupSourceChangeExecutionV1,
  type MachineSetupSourceEntryV1, type MachineSetupSourceV1,
} from './machineSetupSourcesV1.js';
import { mergeMachineSetupsV1 } from '../managed/machineSetupV1.js';

function publicationPort(initial: unknown) {
  // Raw persisted transport is the boundary; the field reader/CAS policy stays real.
  let stored: Record<string, unknown> = { host: 'retained-host', setup: initial };
  let metadataVersion = 8;
  const compareAndSwap = vi.fn<MachineMetadataFieldPortV1['compareAndSwap']>(async input => {
    if (input.expectedMetadataVersion !== metadataVersion) {
      return { status: 'conflict', metadata: stored, metadataVersion };
    }
    stored = input.metadata;
    metadataVersion += 1;
    return { status: 'applied', metadata: stored, metadataVersion };
  });
  const port: MachineMetadataFieldPortV1 = {
    read: async () => ({ status: 'ready', metadata: stored, metadataVersion }),
    compareAndSwap,
  };
  return { port, compareAndSwap, readStored: () => stored };
}

describe('Machine setup saved-copy publication', () => {
  it.each(['direct', 'accountPreset', 'bundledPreset'] as const)('projects confirmed script recovery for %s without changing saved copies', kind => {
    const setup = { scripts: [{ body: 'printf FIRST' }, { body: 'exit 23' }, { body: 'printf THIRD' }] };
    const source: MachineSetupSourceEntryV1 = kind === 'direct' ? { kind, setup }
      : kind === 'accountPreset' ? { kind, presetId: 'preset', presetRevision: 1, setup }
        : { kind, ref: { pluginId: 'fixture.scripts', localId: 'scripts', revision: '1' }, setup };
    const sources: MachineSetupSourceV1 = kind === 'direct' ? [source] : [source, { kind: 'direct', setup: {} }];
    const currentSourceFacts = { [machineSetupSourceOriginKeyV1(source)]: { pendingScripts: [1, 2] } };
    const project = (proposed: MachineSetupSourceV1, mode: 'update' | 'recovery') => {
      const merged = mergeMachineSetupsV1(proposed.map(source => source.setup));
      if (!merged.ok) throw new Error(merged.errorCode);
      const result = projectMachineSetupSourceChangeExecutionV1(sources, proposed, merged.setup, [], { currentSourceFacts, mode });
      if (!result.ok) throw new Error(result.errorCode);
      return result.sources[0]!.scripts?.map(script => script.body);
    };
    for (const mode of ['update', 'recovery'] as const) {
      expect(project(sources, mode)).toEqual(['', 'exit 23', 'printf THIRD']);
      expect(project(sources.map((source, index) => index ? source : { ...source, setup: { scripts: [
        setup.scripts[0]!, { body: 'printf FIXED' }, setup.scripts[2]!,
      ] } }), mode)).toEqual(['', 'printf FIXED', 'printf THIRD']);
      expect(project(sources.map((source, index) => index ? source : { ...source, setup: { scripts: [
        { body: 'printf CHANGED-FIRST' }, ...setup.scripts.slice(1),
      ] } }), mode)).toEqual(['printf CHANGED-FIRST', 'exit 23', 'printf THIRD']);
      expect(project(sources.map((source, index) => index ? source : { ...source, setup: { ...source.setup,
        toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' },
      } }), mode)).toEqual(setup.scripts.map(script => script.body));
    }
    const fixed = sources.map((source, index) => index ? source : { ...source, setup: { scripts: [
      setup.scripts[0]!, { body: 'printf FIXED' }, setup.scripts[2]!,
    ] } });
    const fixedMerged = mergeMachineSetupsV1(fixed.map(source => source.setup));
    if (!fixedMerged.ok) throw new Error(fixedMerged.errorCode);
    // A previously completed later step remains complete when only the failed step is repaired.
    const settledLaterStep = projectMachineSetupSourceChangeExecutionV1(sources, fixed, fixedMerged.setup, [], {
      currentSourceFacts: { [machineSetupSourceOriginKeyV1(source)]: { pendingScripts: [1] } }, mode: 'recovery',
    });
    expect(settledLaterStep).toMatchObject({ ok: true, sources: [{ scripts: [
      { body: '' }, { body: 'printf FIXED' }, { body: '' },
    ] }, ...sources.slice(1).map(source => source.setup)] });
    expect(sources[0]!.setup).toEqual(setup);
    const merged = mergeMachineSetupsV1(sources.map(source => source.setup));
    if (!merged.ok) throw new Error(merged.errorCode);
    expect(projectMachineSetupSourceChangeExecutionV1(sources, sources, merged.setup, [], { mode: 'recovery' }))
      .toMatchObject({ ok: true, sources: sources.map(source => source.setup) });
  });
  it('retains target-authored unfinished scripts outside full saved copies', async () => {
    const sources = [{ kind: 'direct' as const, setup: { scripts: [
      { body: 'printf FIRST' }, { body: 'exit 23' }, { body: 'printf THIRD' },
    ] } }];
    const boundary = publicationPort(createEmptyMachineSetupDesiredV1());
    const observedSourceFacts = { direct: { firstPresence: {}, pendingScripts: [1, 2] } };
    expect(await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 0, sources, exclusions: [],
      observedSourceFacts }, boundary.port)).toMatchObject({ status: 'applied', policy: {
        sources, sourceFacts: { direct: { pendingScripts: [1, 2] } },
      } });
    expect(await getMachineSetupDesiredV1(boundary.port)).toMatchObject({ status: 'ready', policy: {
      sources, sourceFacts: { direct: { pendingScripts: [1, 2] } },
    } });
    expect(MachineSetupApplyInputV1Schema.safeParse({ homeId: 'home', machineId: 'machine',
      desiredRevision: 1, sources, exclusions: [], recipePlans: [], sourceFacts: observedSourceFacts }).success).toBe(false);
    const completed = await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 1, sources, exclusions: [],
      observedSourceFacts: { direct: { pendingScripts: [] } } }, boundary.port);
    expect(completed).toMatchObject({ status: 'applied', policy: { revision: 2, sources } });
    if (completed.status !== 'applied') throw new Error('Expected completed script facts to settle');
    expect(completed.policy.sourceFacts).toBeUndefined();
  });
  it('retains native app correspondence across a catalog pin edit without treating the pin as app identity', async () => {
    const intent = { name: 'Dashboard', project: { kind: 'existing' as const, projectSourceId: 'project' }, bindings: [],
      definition: { from: 'catalogApp' as const, templateRef: { sourceId: 'catalog', itemId: 'dashboard', version: '1',
        ref: { kind: 'version' as const, version: '1' } } } };
    const reference = { intent, homeId: 'home', runId: '8702d93d-4f09-49ae-bfc8-16f21a30e68f',
      sourceKey: '$root', blockId: 'actual-accepted-app', actionId: 'deployments.deploy' as const };
    const sources = [{ kind: 'direct' as const, setup: { items: [{ kind: 'app' as const, definition: intent }] } }];
    const sourceFacts = { direct: { acceptedAppRuns: [reference] } };
    const boundary = publicationPort({ ...createEmptyMachineSetupDesiredV1(), sources, sourceFacts });
    const changed = { ...intent, definition: { ...intent.definition,
      templateRef: { ...intent.definition.templateRef, version: '2', ref: { kind: 'version' as const, version: '2' } } } };
    expect(await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 0, exclusions: [],
      sources: [{ kind: 'direct', setup: { items: [{ kind: 'app', definition: changed }] } }] }, boundary.port))
      .toMatchObject({ status: 'applied', policy: { sourceFacts } });
    expect(boundary.readStored().setup).toMatchObject({ sourceFacts });
  });
  it('retains fresh target facts outside certified source copies through unchanged and changed Apply CAS', async () => {
    const intent = { name: 'Existing app', project: { kind: 'existing' as const, projectSourceId: 'project' },
      definition: { from: 'compose' as const, document: 'services: {}', profiles: [], services: [] }, bindings: [] };
    const item = { kind: 'softwareRecipe' as const, selection: {
      ref: { pluginId: 'fixture.tools', recipeId: 'package', revision: '1' }, inputs: {},
    } };
    const accepted = { intent, homeId: 'home', runId: '8702d93d-4f09-49ae-bfc8-16f21a30e68f',
      sourceKey: '$root', blockId: 'actual-accepted-child', actionId: 'deployments.deploy' as const };
    const sourceFacts = { direct: { firstPresence: { [machineSetupItemKeyV1(item)]: 'absent' as const }, acceptedAppRuns: [accepted] } };
    const initial = { ...createEmptyMachineSetupDesiredV1(), sources: createEmptyMachineSetupDesiredV1().sources.map(source => ({
      ...source, setup: { items: [item, { kind: 'app' as const, definition: intent }] },
    })), sourceFacts };
    const boundary = publicationPort(initial);
    expect(await getMachineSetupDesiredV1(boundary.port)).toMatchObject({ status: 'ready', policy: { sources: initial.sources, sourceFacts } });
    expect(await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 0,
      sources: initial.sources, exclusions: [] }, boundary.port)).toMatchObject({ status: 'unchanged', policy: { sourceFacts } });
    expect(boundary.compareAndSwap).not.toHaveBeenCalled();
    const changed = await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 0,
      sources: initial.sources.map(source => ({ ...source, setup: { ...source.setup, scripts: [{ body: 'echo changed' }] } })),
      exclusions: [] }, boundary.port);
    expect(changed).toMatchObject({ status: 'applied', policy: { revision: 1, sourceFacts } });
    expect(boundary.compareAndSwap).toHaveBeenCalledTimes(1);
    expect(boundary.readStored().setup).toMatchObject({ sourceFacts });
  });

  it('drops source-embedded caller facts on stored read without a legacy Boolean reader or row rewrite', async () => {
    const intent = { name: 'App', project: { kind: 'existing' as const, projectSourceId: 'project' },
      definition: { from: 'compose' as const, document: 'services: {}', profiles: [], services: [] }, bindings: [] };
    const injected = { intent, homeId: 'foreign-home', runId: '8702d93d-4f09-49ae-bfc8-16f21a30e68f',
      sourceKey: '$root', blockId: 'forged-child', actionId: 'deployments.deploy' as const };
    const base = createEmptyMachineSetupDesiredV1();
    const stored = { ...base, sources: base.sources.map(source => ({ ...source,
      alreadyPresentAtFirstApply: { forged: false, legacy: true }, acceptedAppRuns: [injected],
    })) };
    const boundary = publicationPort(stored);
    const result = await getMachineSetupDesiredV1(boundary.port);
    expect(result).toMatchObject({ status: 'ready', policy: { sources: base.sources } });
    if (result.status !== 'ready') throw new Error('Expected a readable content-only source');
    expect(result.policy.sources[0]).not.toHaveProperty('alreadyPresentAtFirstApply');
    expect(result.policy.sources[0]).not.toHaveProperty('acceptedAppRuns');
    expect(result.policy).not.toHaveProperty('sourceFacts');
    expect(MachineSetupDesiredV1Schema.safeParse(stored).success).toBe(false);
    expect(boundary.compareAndSwap).not.toHaveBeenCalled();
    expect(boundary.readStored().setup).toBe(stored);
  });

  it('keeps the review revision on desired setup rather than its direct source copy', () => {
    const sources = [{ kind: 'direct', setup: {} }];
    expect(MachineSetupSourceV1Schema.parse(sources)).toEqual(sources);
    expect(MachineSetupSourceV1Schema.safeParse([{ ...sources[0], expectedDesiredRevision: 0 }]).success).toBe(false);
  });
  it('records native first absence for new items but never promotes an incumbent unknown item', async () => {
    const item = { kind: 'softwareRecipe' as const, selection: {
      ref: { pluginId: 'fixture.tools', recipeId: 'package', revision: '1' }, inputs: {},
    } };
    const base = createEmptyMachineSetupDesiredV1();
    const sources = base.sources.map(source => ({ ...source, setup: { items: [item] } }));
    const sourceFacts = { direct: { firstPresence: { [machineSetupItemKeyV1(item)]: 'absent' as const } } };
    const input = { expectedDesiredRevision: 0, sources, exclusions: [], observedSourceFacts: sourceFacts };
    const fresh = publicationPort(base);
    expect(await mutateMachineSetupDesiredV1(input, fresh.port)).toMatchObject({ status: 'applied', policy: { sourceFacts } });
    const unknown = publicationPort({ ...base, sources });
    const unchanged = await mutateMachineSetupDesiredV1(input, unknown.port);
    expect(unchanged.status).toBe('unchanged');
    if (unchanged.status !== 'unchanged') throw new Error('An existing unknown item cannot acquire native provenance later');
    expect(unchanged.policy).not.toHaveProperty('sourceFacts');
    expect(unknown.compareAndSwap).not.toHaveBeenCalled();
  });
  it('reads retained singular attachment copies in order without rewriting Machine metadata', async () => {
    const stored = { version: 1, revision: 7, exclusions: [], sources: [
      { kind: 'accountPreset', presetId: 'preset', presetRevision: 4,
        setup: { setupScript: 'echo account\r\n', setupScriptAffects: 'none' } },
      { kind: 'bundledPreset', ref: { pluginId: 'fixture.setup', localId: 'tools', revision: '1' },
        setup: { setupScript: '' } },
      { kind: 'direct', setup: {} },
    ] };
    const compareAndSwap = vi.fn<MachineMetadataFieldPortV1['compareAndSwap']>();
    const result = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: stored }, metadataVersion: 9 }), compareAndSwap,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected retained saved copies');
    expect(result.policy).toEqual({ ...stored, sources: [
      { ...stored.sources[0], setup: { scripts: [{ body: 'echo account\r\n', affects: 'none' }] } },
      { ...stored.sources[1], setup: { scripts: [{ body: '' }] } },
      stored.sources[2],
    ] });
    expect(compareAndSwap).not.toHaveBeenCalled();
    expect(stored.sources[0]?.setup).toHaveProperty('setupScript', 'echo account\r\n');
  });
  it('derives only exact read-only target plans from combined Plan or reviewed Apply roots', () => {
    const current = { homeId: 'home', machineId: 'target' };
    const proposed = { ...current, mode: 'effects' as const, sources: createEmptyMachineSetupDesiredV1().sources };
    const plan = { homeId: 'home', machineId: 'host', targets: [current, { ...proposed, machineId: 'other' }] };
    const read = (rootActionId: string, rootInput: unknown, input: unknown = current, machineId = 'target') =>
      readMachineSetupPlanChildInputV1({ rootActionId, rootInput, machineId, input });
    expect(read('machines.setup.plan', plan)).toEqual(current);
    expect(read('machines.setup.plan', { ...plan, targets: [{ ...current, appChildren: [] }] })).toBeNull();
    expect(read('machines.setup.plan', { ...plan, targets: [{ ...current, appChildren: [] }] },
      { ...current, appChildren: [] })).toEqual({ ...current, appChildren: [] });
    expect(read('machines.setup.plan', plan, { ...proposed, machineId: 'other' }, 'other')).toEqual({ ...proposed, machineId: 'other' });
    const apply = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'host', targets: [
      { ...current, sources: proposed.sources, desiredRevision: 0, recipePlans: [] },
    ] });
    expect(read('machines.setup.apply', apply, proposed)).toEqual(proposed);
    const appChildren = [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.templates.instantiate', input: {
      mode: 'apply', serverId: 'home', machineId: 'target', projectSourceId: 'project',
      templateRef: { sourceId: 'catalog', itemId: 'app', version: '1',
        ref: { kind: 'version', version: '1' } },
      environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target' },
      target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [],
      deploy: { requestKey: 'deploy-app' },
    } }];
    const reviewedTarget = { ...proposed, appChildren };
    const reviewedApply = { ...apply, targets: [{ ...apply.targets[0], appChildren }] };
    expect(read('machines.setup.plan', { ...plan, targets: [reviewedTarget] }, reviewedTarget)).toEqual(reviewedTarget);
    expect(read('machines.setup.apply', reviewedApply, reviewedTarget)).toEqual(reviewedTarget);
    expect(read('machines.setup.apply', reviewedApply, proposed)).toBeNull();
    const changedApp = { ...reviewedTarget, appChildren: [{ ...appChildren[0], input: {
      ...appChildren[0]!.input, target: { kind: 'new', installationId: 'other-installation' },
    } }] };
    expect(read('machines.setup.plan', { ...plan, targets: [reviewedTarget] }, changedApp)).toBeNull();
    expect(read('machines.setup.apply', reviewedApply, changedApp)).toBeNull();
    expect(read('machines.setup.apply', apply)).toBeNull();
    expect(read('machines.setup.plan', plan, { ...current, homeId: 'other-home' })).toBeNull();
    expect(read('machines.setup.plan', plan, { ...current, mode: 'check' })).toBeNull();
    expect(read('machines.setup.plan', current)).toBeNull();
    expect(read('machines.setup.apply', apply, { ...proposed, sources: [{ kind: 'direct', setup: { scripts: [{ body: 'unreviewed' }] } }] })).toBeNull();
  });
  it('publishes no revision or transport write for equal saved copies while fencing stale review', async () => {
    const desired = createEmptyMachineSetupDesiredV1();
    const boundary = publicationPort(desired);
    const unchanged = await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 0,
      sources: desired.sources, exclusions: desired.exclusions }, boundary.port);
    expect(unchanged).toMatchObject({ status: 'unchanged', policy: desired, metadataVersion: 8 });
    expect(boundary.compareAndSwap).not.toHaveBeenCalled();
    expect(boundary.readStored().setup).toBe(desired);

    const stale = await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 1,
      sources: desired.sources, exclusions: desired.exclusions }, boundary.port);
    expect(stale).toMatchObject({ status: 'conflict', policy: desired, metadataVersion: 8 });
    expect(boundary.compareAndSwap).not.toHaveBeenCalled();
  });

  it('writes changed copies once, preserves siblings and makes the next current-copy apply a no-op', async () => {
    const boundary = publicationPort(createEmptyMachineSetupDesiredV1());
    const applied = await mutateMachineSetupDesiredV1({ expectedDesiredRevision: 0,
      sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo retained\r\n' }] } }],
      exclusions: [] }, boundary.port);
    expect(applied).toMatchObject({ status: 'applied', policy: { revision: 1,
      sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo retained\r\n' }] } }],
    }, metadataVersion: 9 });
    expect(boundary.readStored().host).toBe('retained-host');
    const current = await getMachineSetupDesiredV1(boundary.port);
    expect(current.status).toBe('ready');
    if (current.status !== 'ready') throw new Error('Expected current saved copies');
    const replay = await mutateMachineSetupDesiredV1({ expectedDesiredRevision: current.policy.revision,
      sources: current.policy.sources, exclusions: current.policy.exclusions }, boundary.port);
    expect(replay).toMatchObject({ status: 'unchanged', policy: current.policy, metadataVersion: 9 });
    expect(boundary.compareAndSwap).toHaveBeenCalledTimes(1);
  });

  it('does not turn unavailable or malformed content into an empty setup', async () => {
    const unavailable: MachineMetadataFieldPortV1 = {
      read: async () => ({ status: 'locked' }),
      compareAndSwap: async () => { throw new Error('No write is admitted'); },
    };
    expect(await getMachineSetupDesiredV1(unavailable)).toEqual({ status: 'locked' });
    expect(await getMachineSetupDesiredV1({ ...unavailable,
      read: async () => ({ status: 'ready', metadata: { setup: null }, metadataVersion: 1 }),
    })).toEqual({ status: 'invalid' });
  });
});
