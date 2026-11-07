import { describe, expect, it } from 'vitest';

import { ACTION_IDS } from './actionIds.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { getActionSpec, listActionCliCommandDeclarations, PLUGIN_INVOCABLE_ACTION_IDS, PUBLIC_ACTION_IDS, resolveActionExecutionPlacementForInput } from './actionSpecs.js';
import { MachinePublishedMetadataV1Schema, StoredMachinePublishedMetadataV1Schema } from '../machines/machinePublishedContentV1.js';

const reads = ['machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options',
  'machines.managed.list', 'machines.managed.get', 'machines.managed.birth.get', 'machines.managed.inspect'] as const;
const effects = ['machines.managed.acquire', 'machines.managed.bootstrap.retry', 'machines.managed.cancel',
  'machines.managed.power.set', 'machines.managed.retention.update', 'machines.managed.delete',
  'machines.managed.controller.update', 'machines.managed.retire'] as const;

describe('managed Machine host Action contracts', () => {
  it('preserves native Delete admission alongside Account-owned deletion', () => {
    const spec = getActionSpec('machines.managed.delete');
    const input = spec.inputSchema.parse({ homeId: 'home', managedId: 'managed', expectedRevision: 1,
      when: 'now', intent: 'delete', reviewedDependencies: true });
    expect(resolveActionExecutionPlacementForInput(spec, input)).toBe('account');
    expect(spec.executionPlacements).toEqual(expect.arrayContaining(['account', 'machine']));
  });

  it('reviews exact update scope without setup operands and exposes dangerous target-native apply', () => {
    const plan = getActionSpec('machines.setup.plan');
    expect(plan.inputSchema.safeParse({ homeId: 'home', machineId: 'machine', updates: { scope: 'security' } }).success).toBe(true);
    expect(plan.inputSchema.safeParse({ homeId: 'home', machineId: 'machine', updates: { scope: 'all' }, sources: [] }).success).toBe(false);
    const id = ACTION_IDS.find(id => String(id) === 'machines.setup.updates.apply');
    expect(id).toBeDefined();
    if (!id) return;
    expect(getActionSpec(id)).toMatchObject({ executionPlacement: 'machine', safety: 'danger',
      approvalScope: 'machine', bindings: { rpcMethod: 'machines.setup.updates.apply' },
      approvalPolicy: { uiConfirmation: 'policy' } });
  });
  it('admits retained power, inspection and installation retry at the Account host while preserving installed execution', () => {
    for (const actionId of ['machines.managed.power.set', 'machines.managed.inspect', 'machines.managed.bootstrap.retry'] as const) {
      const spec = getActionSpec(actionId);
      const input = spec.inputSchema.parse({ homeId: 'home', managedId: 'managed',
        ...(actionId === 'machines.managed.power.set' ? { expectedRevision: 1, when: 'now', intent: 'start' }
          : actionId === 'machines.managed.bootstrap.retry' ? { expectedIntentRevision: 1 }
          : {}),
      });
      expect(resolveActionExecutionPlacementForInput(spec, input)).toBe('account');
      expect(spec.executionPlacements).toEqual(expect.arrayContaining(['account', 'machine']));
    }
  });

  it('places portable provisioner discovery and reviewed acquire in the invoking Account host, preserving selected native execution', () => {
    const controller = { machineId: 'own-native', installationId: 'installation' };
    for (const actionId of ['machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options'] as const) {
      const spec = getActionSpec(actionId);
      expect(resolveActionExecutionPlacementForInput(spec, { homeId: 'home' })).toBe('account');
      expect(resolveActionExecutionPlacementForInput(spec, { homeId: 'home', controller })).toBe('machine');
    }
    const acquire = getActionSpec('machines.managed.acquire');
    for (const selection of [{ kind: 'one-off', homeId: 'home' }, { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 }]) {
      expect(resolveActionExecutionPlacementForInput(acquire, { selection })).toBe('account');
      const native = selection.kind === 'one-off' ? { selection: { ...selection, controller } } : { selection, controller };
      expect(resolveActionExecutionPlacementForInput(acquire, native)).toBe('machine');
    }
  });

  it('declares setup Remove as an exact-machine dangerous Action that asks by default', () => {
    const actionId = ACTION_IDS.find(id => String(id) === 'machines.setup.remove');
    expect(actionId).toBeDefined();
    if (!actionId) throw new Error('Declared setup Remove is unavailable');
    const spec = getActionSpec(actionId);
    const input = { homeId: 'home', machineId: 'guest', sources: [{ kind: 'direct', setup: {}}],
      desiredRevision: 2, removeItemKeys: ['owned-item'], removalPlans: [] };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec).toMatchObject({ safety: 'danger', executionPlacement: 'machine', sideEffectClass: 'danger',
      approvalScope: 'machine', surfaces: { ui: true, cli: true, agent: true, mcp: true } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context: { surface: 'agent' } }).required).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, administrator: true }).success).toBe(false);
  });

  it('installs only an exact accepted credential binding through the ordinary reviewed machine Action', () => {
    const actionId = ACTION_IDS.find(id => String(id) === 'machines.managed.credentials.install');
    expect(actionId).toBeDefined();
    if (!actionId) throw new Error('Native credential install Action is unavailable');
    const spec = getActionSpec(actionId);
    const input = { homeId: 'home', managedId: 'sandbox', sessionId: 'session', bindingKey: 'binding',
      expectedResourceRevision: 3, expectedSourceRevision: 'source-3', expectedProviderTicket: 'opaque-ticket' };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.parse({ ...input, operation: 'release' })).toEqual({ ...input, operation: 'release' });
    expect(spec.inputSchema.safeParse({ ...input, operation: 'recompute_all' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, headers: { Authorization: 'secret' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, controller: 'other' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ homeId: 'home', managedId: 'sandbox' }).success).toBe(false);
    expect(spec).toMatchObject({ safety: 'danger', executionPlacement: 'machine', sideEffectClass: 'danger',
      surfaces: { ui: true, cli: true, agent: true, mcp: true } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context: { surface: 'agent' } }).required).toBe(true);
  });
  it('admits shared managed inventory reads only with a host-stamped plugin caller', () => {
    expect(getActionSpec('machines.managed.list')).toMatchObject({
      surfaces: { plugin: true }, pluginCallerPolicy: { kind: 'caller' },
    });
  });
  it('admits exact managed list selectors without relaxing the closed Account request', () => {
    const spec = getActionSpec('machines.managed.list');
    for (const selection of [{ presetId: 'preset' }, { enrolledMachineId: 'guest' }, { presetId: 'preset', enrolledMachineId: 'guest' }]) {
      const input = { homeId: 'home', archived: true, ...selection };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(resolveActionExecutionPlacementForInput(spec, input)).toBe('account');
    }
    expect(spec.inputSchema.parse({ homeId: 'home' })).toEqual({ homeId: 'home' });
    expect(spec.inputSchema.safeParse({ homeId: 'home', presetId: '' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ homeId: 'home', enrolledMachineId: '' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ homeId: 'home', arbitraryFilter: 'all' }).success).toBe(false);
  });
  it('routes birth reads through the ordinary Account server transport', () => {
    expect(getActionSpec('machines.managed.birth.get')).toMatchObject({
      executionPlacement: 'account', sideEffectClass: 'read',
      serverTransport: { method: 'POST', path: '/v1/machines/managed/actions/birth.get' },
    });
  });
  it('admits one reviewed full target list and keeps singleton setup on the identical public shape', () => {
    const spec = getActionSpec('machines.setup.apply');
    const target = { homeId: 'home', machineId: 'guest', desiredRevision: 0, recipePlans: [],
      sources: [{ kind: 'direct', setup: {} }] };
    const input = { homeId: 'home', machineId: 'host', targets: [target, { ...target, machineId: 'second' }] };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, targets: [target] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, targets: [target, target] }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ homeId: 'home', machineId: 'guest', sources: target.sources }).success).toBe(false);
  });
  it('loads a Machine setup plan without a mutation and binds the structured software ref choice', () => {
    const spec = getActionSpec('machines.setup.plan');
    const current = { homeId: 'home', machineId: 'guest' };
    expect(spec.inputSchema.parse(current)).toEqual(current);
    expect(spec).toMatchObject({ sideEffectClass: 'read', executionPlacement: 'machine' });
    expect(spec.inputHints?.fields).toContainEqual(expect.objectContaining({ path: 'sources.0.setup.items.0.selection.ref', optionsSourceId: 'machines.setup.software.available' }));
    const direct = { kind: 'direct', setup: { items: [{ kind: 'softwareRecipe',
      selection: { ref: { pluginId: 'example.machine', recipeId: 'jq', revision: '1' }, inputs: {} } }] } };
    expect(spec.inputSchema.safeParse({ ...current, sources: [direct] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...current, sources: [{ ...direct, setup: { items: [{ kind: 'softwareRecipe',
      selection: { ref: { recipeId: 'jq' }, inputs: {} } }] } }] }).success).toBe(false);
  });
  it('retains closed effects review facts on scalar and combined Plan results without making them execution authority', () => {
    const output = getActionSpec('machines.setup.plan').outputSchema!;
    const review = { target: { homeId: 'home', machineId: 'guest' }, administratorRequired: null, downtime: 'unknown',
      host: { machineId: 'host', machines: [{ machineId: 'host', online: true }] } };
    const plan = { desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }],
      support: [], exclusions: [], recipePlans: [], review };
    expect(output.parse(plan)).toEqual(plan);
    const combined = { targets: [{ homeId: 'home', machineId: 'guest', plan }], review: review.host };
    expect(output.parse(combined)).toEqual(combined);
    for (const invalid of [{ ...review, authority: 'root' }, { ...review, downtime: 'safe' },
      { ...review, target: { ...review.target, installationId: 'unreviewed' } },
      { ...review, host: { ...review.host, preferred: true } }]) {
      expect(output.safeParse({ ...plan, review: invalid }).success).toBe(false);
    }
  });
  it('admits canonical prepared app candidates on scalar and combined target Plans', () => {
    const child = { sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy', input: {
      serverId: 'home', environmentId: 'environment', expectedRevision: 1, targetLinkId: 'runtime',
      expectedTargetLinkRevision: 1, requestKey: 'deploy', contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1,
    } };
    const target = { homeId: 'home', machineId: 'guest', mode: 'effects', appChildren: [child] };
    const spec = getActionSpec('machines.setup.plan');
    expect(spec.inputSchema.safeParse({ homeId: 'home', machineId: 'host', targets: [target] }).success).toBe(true);
    expect(spec.inputSchema.parse(target)).toEqual(target);
    for (const invalidChild of [{ ...child, actionId: 'machines.managed.acquire' },
      { ...child, controller: 'unreviewed' }]) {
      const invalidTarget = { ...target, appChildren: [invalidChild] };
      expect(spec.inputSchema.safeParse(invalidTarget).success).toBe(false);
      expect(spec.inputSchema.safeParse({ homeId: 'home', machineId: 'host', targets: [invalidTarget] }).success).toBe(false);
    }
  });
  it('admits exact ordered setup source copies and rejects unreviewed nested authority', () => {
    const spec = getActionSpec('machines.setup.apply');
    const sources = [{ kind: 'accountPreset', presetId: 'preset', presetRevision: 4, setup: { scripts: [{ body: 'echo retained' }] } },
      { kind: 'direct', setup: {}}];
    const target = { homeId: 'home', machineId: 'guest', sources, desiredRevision: 0, recipePlans: [] };
    const input = { homeId: 'home', machineId: 'guest', targets: [target] };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.parse(input)).toEqual(input);
    const metadata = { host: 'guest', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/happier',
      happyHomeDir: '/home/happier/.happier', setup: { version: 1, revision: 0, sources, exclusions: [] } };
    expect(MachinePublishedMetadataV1Schema.parse(metadata)).toEqual(metadata);
    expect(StoredMachinePublishedMetadataV1Schema.parse(metadata)).toEqual(metadata);
    const retainedSources = [{ ...sources[0], setup: { setupScript: 'echo retained' } }, sources[1]];
    const retainedMetadata = { ...metadata, setup: { ...metadata.setup, sources: retainedSources } };
    expect(StoredMachinePublishedMetadataV1Schema.parse(retainedMetadata)).toEqual(metadata);
    expect(MachinePublishedMetadataV1Schema.safeParse(retainedMetadata).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, targets: [{ ...target, sources: retainedSources }] }).success).toBe(false);
    expect(MachinePublishedMetadataV1Schema.safeParse({ ...metadata, setup: { ...metadata.setup, appRefs: ['not-desired'] } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, targets: [{ ...target, sources: [{ ...sources[0], controller: 'foreign' }, sources[1]] }] }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, targets: [{ ...target, sources: [sources[1], sources[1]] }] }).success).toBe(false);
  });
  it('requires approval before applying the exact preset environment on an existing machine', () => {
    const spec = getActionSpec('machines.setup.apply');
    expect(spec.inputSchema.safeParse({ homeId: 'home', machineId: 'guest', presetId: 'preset', presetRevision: 4 }).success).toBe(false);
    const input = { homeId: 'home', machineId: 'guest', targets: [{ homeId: 'home', machineId: 'guest', desiredRevision: 0, recipePlans: [], sources: [
      { kind: 'accountPreset', presetId: 'preset', presetRevision: 4, setup: { scripts: [{ body: 'echo retained' }] } },
      { kind: 'direct', setup: {} },
    ] }] };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, environment: { scripts: [{ body: 'unreviewed' }] } }).success).toBe(false);
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine',
      surfaces: { ui: true, cli: true, agent: true, mcp: true }, operation: { version: 1, visibility: 'activity' } });
    expect(resolveActionApprovalRouting({ actionId: 'machines.setup.apply', spec, input,
      context: { surface: 'agent' } }).required).toBe(true);
  });
  it('makes skipping setup an explicit confirmed mutation of the same creation row', () => {
    const spec = getActionSpec('machines.managed.setup.skip');
    expect(spec.inputSchema.parse({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 4 }))
      .toEqual({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 4 });
    expect(spec).toMatchObject({ executionPlacement: 'account', sideEffectClass: 'danger' });
    expect(resolveActionApprovalRouting({ actionId: 'machines.managed.setup.skip', spec,
      context: { surface: 'agent' } }).required).toBe(true);
  });
  it('accepts known-offline creation without manufacturing a daemon operation', () => {
    const output = getActionSpec('machines.managed.acquire').outputSchema;
    expect(output.parse({ managedId: 'waiting' })).toEqual({ managedId: 'waiting' });
    expect(output.parse({ managedId: 'running', operation: { operationId: 'real-daemon-operation' } }))
      .toEqual({ managedId: 'running', operation: { operationId: 'real-daemon-operation' } });
    expect(output.safeParse({ operation: { operationId: 'fake-operation' } }).success).toBe(false);
  });
  it('places admitted-creation cancellation on the Account without losing its danger or operation contract', () => {
    const spec = getActionSpec('machines.managed.cancel');
    const input = spec.inputSchema.parse({ homeId: 'home', managedId: 'waiting', expectedIntentRevision: 0 });
    expect(resolveActionExecutionPlacementForInput(spec, input)).toBe('account');
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger',
      operation: { version: 1, visibility: 'activity', progress: 'reported' },
      serverTransport: { method: 'POST', path: '/v1/machines/managed/actions/cancel' },
    });
    expect(resolveActionApprovalRouting({ actionId: 'machines.managed.cancel', spec, input,
      context: { surface: 'ui', authority: 'present_user' },
    })).toMatchObject({ required: true, flow: 'deferred' });
  });
  it('requires immediate currentness and permits only selected deferred stop/delete inputs', () => {
    const power = getActionSpec('machines.managed.power.set').inputSchema;
    const target = { homeId: 'home', managedId: 'retained' };
    expect(power.safeParse({ ...target, when: 'now', intent: 'stop' }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'now', expectedRevision: 2, intent: 'stop', afterMs: 1 }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'after-idle', intent: 'start' }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'after-idle', intent: 'stop', afterMs: 0 }).success).toBe(false);
    expect(power.safeParse({ ...target, when: 'after-idle', intent: 'stop', afterMs: 17 }).success).toBe(true);
    const deletion = getActionSpec('machines.managed.delete').inputSchema;
    expect(deletion.safeParse({ ...target, when: 'after-idle', intent: 'delete', reviewedDependencies: true }).success).toBe(true);
    expect(deletion.safeParse({ ...target, when: 'after-idle', intent: 'stop', reviewedDependencies: true }).success).toBe(false);
  });
  it('admits reviewed managed-resource disposition only on Account deletion', () => {
    const input = { accountId: 'account', managedResourceDispositions: [{ managedId: 'retained', expectedIntentRevision: 2, expectedAllocation: 'may-exist', responsibility: 'manual' }] };
    expect(getActionSpec('home.accounts.delete').inputSchema.safeParse(input).success).toBe(true);
    expect(getActionSpec('home.accounts.disable').inputSchema.safeParse(input).success).toBe(false);
  });
  it('exposes discovery, recovery and reviewed creation through the canonical headless surfaces', () => {
    const commands = new Map(listActionCliCommandDeclarations().map(({ spec, binding }) => [spec.id, binding.path]));
    for (const actionId of [...reads, ...effects]) {
      expect(ACTION_IDS).toContain(actionId);
      expect(PUBLIC_ACTION_IDS).toContain(actionId);
      expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain(actionId);
      expect(getActionSpec(actionId)).toMatchObject({
        surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true },
        bindings: { rpcMethod: actionId },
        executionPlacement: ['machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options', 'machines.managed.acquire',
          'machines.managed.list', 'machines.managed.get', 'machines.managed.birth.get', 'machines.managed.cancel', 'machines.managed.power.set',
          'machines.managed.inspect', 'machines.managed.bootstrap.retry', 'machines.managed.delete'].includes(actionId)
          ? 'account' : 'machine',
      });
      expect(commands.get(actionId)).toEqual(actionId.split('.'));
    }
    for (const actionId of reads) expect(getActionSpec(actionId).sideEffectClass).toBe('read');
    for (const actionId of effects) {
      const spec = getActionSpec(actionId);
      expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger', operation: {
        version: 1, visibility: 'activity', progress: 'reported',
      } });
      expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent' } }).required).toBe(true);
    }
  });
});
