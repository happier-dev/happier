import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { PluginProjectedMachineRecipeEntryV1Schema } from '../daemon/contributionRegistryProjection.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';

const ref = { pluginId: 'com.example.software', recipeId: 'fonts', revision: '3' };
const selected = PluginProjectedMachineRecipeEntryV1Schema.parse({
  id: `${ref.pluginId}/${ref.recipeId}`, pluginId: ref.pluginId, pluginVersion: '1.0.0',
  definition: { id: ref.recipeId, revision: ref.revision, title: 'Fonts', software: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    steps: [{ id: 'install', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
    removeSteps: [{ id: 'remove', kind: 'package', state: 'absent', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
  },
});
const context = { surface: 'cli', authority: 'present_user', serverId: 'caller-home' } as const;
const draftInput = { homeId: 'reviewed-home', machineId: 'reviewed-machine' };
const planField = 'sources.0.setup.items.0.selection.ref';

function createDeps(machineRecipesRead: NonNullable<ActionExecutorDeps['machineRecipesRead']>): ActionExecutorDeps {
  // These are unavailable host transport boundaries. Any unexpected effect or
  // unrelated inventory read must fail rather than mask the real resolver path.
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected host transport'); };
  return {
    executionRunStart: unavailable, executionRunList: unavailable, executionRunGet: unavailable,
    detachedExecutionRunSend: unavailable, executionRunStop: unavailable, executionRunAction: unavailable,
    executionRunWait: unavailable, sessionOpen: unavailable, sessionFork: unavailable,
    sessionRollback: unavailable, sessionSpawnNew: unavailable, pathsListRecent: unavailable,
    machinesList: unavailable, serversList: unavailable, reviewEnginesList: unavailable,
    agentsBackendsList: unavailable, agentsModelsList: unavailable, sessionSendMessage: unavailable,
    sessionPermissionRespond: unavailable, sessionUserActionAnswer: unavailable, sessionModeSet: unavailable,
    sessionModesList: unavailable, sessionTargetPrimarySet: unavailable, sessionTargetTrackedSet: unavailable,
    sessionList: unavailable, sessionActivityGet: unavailable, sessionRecentMessagesGet: unavailable,
    resetGlobalVoiceAgent: unavailable, machineRecipesRead,
  };
}

describe('Action executor Machine recipe options', () => {
  it('presents declared Setup recipes alongside Software without admitting them to Software browsing', async () => {
    const { software: _software, ...definition } = selected.definition;
    const setup = PluginProjectedMachineRecipeEntryV1Schema.parse({ ...selected, id: `${ref.pluginId}/ssh`,
      definition: { ...definition, id: 'ssh', title: 'SSH hardening', icon: 'shield',
        description: 'Configure secure access.' } });
    const executor = createActionExecutor(createDeps(async request => {
      expect(request).toEqual({ offerings: true });
      return { entries: [setup, selected] };
    }));
    const result = await executor.execute('action.options.resolve', {
      optionsSourceId: 'machines.setup.recipes.available', draftInput: {},
    }, context);
    expect(result).toMatchObject({ ok: true, result: { options: [
      { value: { ...ref, recipeId: 'ssh' }, label: 'SSH hardening', icon: 'shield', description: 'Configure secure access.' },
      { value: ref, label: 'Fonts' },
    ] } });
    if (!result.ok) throw new Error('Expected declared recipes');
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).options).toHaveLength(2);
  });

  it('browses inert native offerings without a Machine or target support claims', async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    let reads = 0;
    const { software: _software, ...setupDefinition } = selected.definition;
    const executor = createActionExecutor(createDeps(async request => {
      reads++;
      expect(request).toEqual({ offerings: true });
      return { entries: [{ ...selected, definition: { ...selected.definition,
        title: { key: 'fonts.title', fallback: 'Fonts' }, icon: 'file', description: 'Readable screenshots.' } },
        PluginProjectedMachineRecipeEntryV1Schema.parse({ ...selected, id: `${ref.pluginId}/setup`,
          definition: { ...setupDefinition, id: 'setup' } })] };
    }));
    const result = await executor.execute('action.options.resolve', {
      optionsSourceId: 'machines.setup.software.available', draftInput: {},
    }, context);
    expect(result).toMatchObject({ ok: true, result: { options: [
      { value: ref, label: 'Fonts', icon: 'file', description: 'Readable screenshots.' },
      { value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' }, label: 'Node.js' },
      { value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' }, label: 'Python' },
    ] } });
    if (!result.ok) throw new Error('Expected inert offerings');
    const output = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result);
    expect(output.options).toHaveLength(3);
    expect(output).not.toHaveProperty('machineRecipeDetails');
    expect(output.options.every(option => option.disabled === undefined)).toBe(true);
    // One open reads one declaration family; the finite read schedules no idle work.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(1);
  });

  it('keeps partial target operands and Plan recipe fields target-bound', async () => {
    let reads = 0;
    const executor = createActionExecutor(createDeps(async () => { reads++; return { entries: [selected] }; }));
    for (const draft of [{ homeId: 'home' }, { machineId: 'machine' }]) {
      expect(await executor.execute('action.options.resolve', {
        optionsSourceId: 'machines.setup.software.available', draftInput: draft,
      }, context)).toMatchObject({ ok: false, errorCode: 'missing_option_dependency' });
    }
    expect(await executor.execute('action.options.resolve', {
      actionId: 'machines.setup.plan', fieldPath: planField, draftInput: {},
    }, context)).toMatchObject({ ok: false, errorCode: 'missing_option_dependency' });
    expect(reads).toBe(0);
  });

  it.each([
    ['machines.setup.plan', planField],
    ['machines.setup.apply', 'targets.0.sources.0.setup.items.0.selection.ref'],
  ] as const)('keeps the outer field authoritative over untrusted draft content for %s', async (actionId, fieldPath) => {
    const executor = createActionExecutor(createDeps(async request => {
      expect(request).toEqual({ ...draftInput, recipeRefs: [ref] });
      return { entries: [selected] };
    }));
    const reviewedDraft = actionId === 'machines.setup.apply'
      ? { homeId: 'host-home', machineId: 'combined-host', targets: [{ ...draftInput,
          desiredRevision: 0, recipePlans: [], sources: [{ kind: 'direct', setup: {} }] }] }
      : draftInput;
    const request = { actionId, fieldPath: ` ${fieldPath} `,
      draftInput: { ...reviewedDraft, fieldPath: 'untrusted.other.field' }, values: [ref] };
    expect(await executor.execute('action.options.resolve', request, context)).toMatchObject({ ok: true, result: {
      fieldPath, options: [{ value: ref }],
    } });
    // A recipe-ref field cannot be redirected into the broader toolchain source.
    expect(await executor.execute('action.options.resolve', { ...request,
      values: [{ kind: 'toolchain', adapterId: 'mise', tool: 'node' }],
    }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('does not let a draft fieldPath narrow a direct software-source request', async () => {
    const executor = createActionExecutor(createDeps(async request => {
      expect(request).toEqual({ ...draftInput, recipeRefs: [] });
      return { entries: [], target: { platform: 'linux', arch: 'x64' } };
    }));
    const node = { kind: 'toolchain', adapterId: 'mise', tool: 'node' };
    const result = await executor.execute('action.options.resolve', {
      actionId: 'machines.setup.plan', optionsSourceId: 'machines.setup.software.available',
      draftInput: { ...draftInput, fieldPath: planField }, values: [node],
    }, context);
    expect(result).toMatchObject({ ok: true, result: { fieldPath: null,
      options: [expect.objectContaining({ value: node })],
    } });
    if (!result.ok) throw new Error('Expected direct software choices');
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result)).not.toHaveProperty('machineRecipeDetails');
  });

  it('carries only exact selected recipe details through the public Plan options result', async () => {
    const other = PluginProjectedMachineRecipeEntryV1Schema.parse({ ...selected, id: `${ref.pluginId}/other`,
      definition: { ...selected.definition, id: 'other' } });
    const executor = createActionExecutor(createDeps(async request => {
      expect(request.homeId).toBe(draftInput.homeId);
      expect(request.machineId).toBe(draftInput.machineId);
      return { entries: [selected, other] };
    }));
    const request = { actionId: 'machines.setup.plan', fieldPath: planField, draftInput };
    const result = await executor.execute('action.options.resolve', { ...request, values: [ref] }, context);
    expect(result).toMatchObject({ ok: true, result: { machineRecipeDetails: [selected] } });
    if (!result.ok) throw new Error('Expected selected recipe details');
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result)).toEqual({
      actionId: request.actionId, fieldPath: planField, optionsSourceId: 'machines.setup.software.available',
      options: [{ value: ref, label: 'Fonts', version: selected.pluginVersion }], machineRecipeDetails: [selected],
    });
    const browse = await executor.execute('action.options.resolve', request, context);
    expect(browse.ok).toBe(true);
    if (!browse.ok) throw new Error('Expected recipe choices');
    expect(browse.result).not.toHaveProperty('machineRecipeDetails');
    expect(await executor.execute('action.options.resolve', { ...request, values: [{ ...ref, revision: 'missing' }] }, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable' });
  });
});
