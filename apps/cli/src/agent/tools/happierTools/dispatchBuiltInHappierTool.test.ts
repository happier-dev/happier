import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import {
  ActionsSettingsV1Schema,
  ActionDefinitionV1Schema,
  createActionExecutor,
  SessionSpawnNewInputV2Schema,
  projectSessionSpawnNewActionInputV2,
} from '@happier-dev/protocol';

import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from './createChangeTitleToolHandler';

import { listBuiltInHappierTools } from './listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';
import type { HappierBuiltInToolDispatchResult } from './types';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';

const directMcpExecutionSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
  'review.start': { toolExposureModes: { mcp: 'direct' } },
  'execution.run.start': { toolExposureModes: { mcp: 'direct' } },
} });

function ok(result: unknown): HappierBuiltInToolDispatchResult {
  return { ok: true, result };
}

function unsupported(): HappierBuiltInToolDispatchResult {
  return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
}

function expectActionDisabled(result: HappierBuiltInToolDispatchResult): void {
  expect(result).toMatchObject({
    ok: false,
    errorCode: 'action_disabled',
    error: 'Action is disabled',
  });
}

describe('built-in Happier tools', () => {
  it.each([
    { cancelled: false, expectedCode: 'unsupported_action' },
    { cancelled: true, expectedCode: 'cancelled' },
  ])('preserves the real title Action outcome (cancelled=$cancelled)', async ({ cancelled, expectedCode }) => {
    // Keep Action admission and title dispatch real; no metadata transport is
    // installed in this host, so an uncancelled call is explicitly unsupported.
    const executor = createActionExecutor(createUnavailableActionTransportDeps());
    const controller = new AbortController();
    if (cancelled) controller.abort();
    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title', args: { title: 'New title' }, sessionId: 'sess-1',
      signal: controller.signal,
      deps: {
        changeTitle: createChangeTitleToolHandler({ executor, surface: 'agent' }),
        executeActionByToolName: createActionToolExecutorBridge({ executor, surface: 'agent' }).executeActionByToolName,
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: expectedCode });
  });

  it('lists the default session-agent direct bootstrap tools from the shared catalog', () => {
    const names = listBuiltInHappierTools().map((tool) => tool.name);

    expect(names).toContain('change_title');
    expect(names).toContain('action_spec_search');
    expect(names).toContain('action_spec_get');
    expect(names).toContain('action_options_resolve');
    expect(names).toContain('action_execute');
    expect(names).toContain('plugins_reload');
    expect(names).not.toContain('review_start');
    expect(names).not.toContain('subagents_plan_start');
    expect(names).not.toContain('subagents_delegate_start');
  });

  it('dispatches change_title through the injected title updater', async () => {
    const changeTitle = vi.fn(async (_sessionId: string, title: string) => ({ success: true, title }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      deps: {
        changeTitle,
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(changeTitle).toHaveBeenCalledWith('sess-1', 'New title');
    expect(result).toEqual({ ok: true, result: { success: true, title: 'New title' } });
  });

  it('surfaces change_title failures as tool errors', async () => {
    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: false, error: 'update failed' }),
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'change_title_failed',
      error: 'update failed',
    });
  });

  it('rejects change_title when the equivalent session.title.set action is disabled', async () => {
    const changeTitle = vi.fn(async () => ({ success: true, title: 'New title' }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle,
        executeActionByToolName: async () => unsupported(),
        isActionEnabled: (id) => id !== 'session.title.set',
      },
    });

    expectActionDisabled(result);
    expect(changeTitle).not.toHaveBeenCalled();
  });

  it('rejects change_title when session title updates are discoverable-only', async () => {
    const changeTitle = vi.fn(async () => ({ success: true, title: 'New title' }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'change_title',
      args: { title: 'New title' },
      sessionId: 'sess-1',
      surface: 'agent',
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'session.title.set': {
            toolExposureModes: { agent: 'discoverable_only' },
          },
        },
      }),
      deps: {
        changeTitle,
        executeActionByToolName: async () => unsupported(),
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown built-in Happier tool: change_title',
    });
    expect(changeTitle).not.toHaveBeenCalled();
  });

  it('uses canonical Action executor discovery and projects Session-bound schemas', async () => {
    const { executeActionByToolName } = createActionToolExecutorBridge({
      surface: 'agent',
      executor: createActionExecutor(createUnavailableActionTransportDeps()),
    });
    const readCompleteInputSchema = async (result: unknown) => {
      // The real Action discovery boundary returns the canonical named-section
      // projection. Fetch its definitions before compiling its local references.
      const root = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(result);
      const definition = ActionDefinitionV1Schema.parse(root.actionSpec);
      const definitions: Record<string, unknown> = {};
      for (const section of (root.schemaSections ?? []).filter(section => section.path.startsWith('/inputSchema/'))) {
        const fetched = await dispatchBuiltInHappierTool({ toolName: 'action_spec_get',
          args: { id: definition.id, schemaPath: section.path }, sessionId: 'sess-1',
          deps: { changeTitle: async () => ({ success: true }), executeActionByToolName } });
        if (!fetched.ok) throw new Error(`Action section unavailable: ${fetched.errorCode}`);
        const response = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(fetched.result);
        if (!response.schemaSection) throw new Error('Action discovery omitted its requested schema section');
        expect(response.schemaSection.path).toBe(section.path);
        const name = section.path.split('/').at(-1)!.replace(/~1/g, '/').replace(/~0/g, '~');
        definitions[name] = response.schemaSection.schema;
      }
      return { ...definition.inputSchema, ...(Object.keys(definitions).length ? { definitions } : {}) };
    };
    const draftResult = await dispatchBuiltInHappierTool({ toolName: 'action_spec_get',
      args: { id: 'template.draft' }, sessionId: 'sess-1',
      deps: { changeTitle: async () => ({ success: true }), executeActionByToolName } });
    expect(draftResult.ok, JSON.stringify(draftResult)).toBe(true);
    if (!draftResult.ok) throw new Error(`Expected draft discovery: ${draftResult.errorCode}`);
    const draftDefinition = ActionDefinitionV1Schema.parse(
      PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(draftResult.result).actionSpec);
    const validateDraft = new Ajv({ strict: false, validateFormats: false }).compile(await readCompleteInputSchema(draftResult.result));
    const draftInput = { sourceSessionRef: { serverId: 'home', sessionId: 'sess-1' },
      content: { v: 1, identity: { name: 'Helper', description: 'Reusable helper' },
        instructions: { markdown: 'Help with work.' }, memoryRules: [], skills: [],
        needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
    expect(validateDraft(draftInput), JSON.stringify(validateDraft.errors)).toBe(true);
    expect(validateDraft({ ...draftInput, expectedRevision: { headerVersion: 1, bodyVersion: 1 } })).toBe(false);
    expect(draftDefinition.inputHints?.fields.some(field => field.path.startsWith('expectedRevision'))).toBe(false);

    const listResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_search',
      args: { query: 'review' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(listResult.ok, JSON.stringify(listResult)).toBe(true);
    if (!listResult.ok) {
      throw new Error(`expected action_spec_search to succeed: ${listResult.errorCode}`);
    }
    expect(Array.isArray((listResult.result as { actionSpecs?: unknown }).actionSpecs)).toBe(true);
    expect((listResult.result as { actionSpecs: Array<{ id: string }> }).actionSpecs.some((spec) => spec.id === 'session.mode.set')).toBe(false);

    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'subagents.plan.start' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    if (!getResult.ok) throw new Error('Expected plan Action discovery');
    const planDefinition = ActionDefinitionV1Schema.parse((getResult.result as { actionSpec: unknown }).actionSpec);
    expect(planDefinition).toMatchObject({ id: 'subagents.plan.start', kindVersion: 1 });
    if (!planDefinition.inputSchema) throw new Error('Expected plan input schema');
    const validatePlan = new Ajv({ strict: false, validateFormats: false }).compile(await readCompleteInputSchema(getResult.result));
    const planInput = { backendTargetKeys: [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })],
      instructions: 'Plan the workspace change.' };
    expect(validatePlan(planInput), JSON.stringify(validatePlan.errors)).toBe(true);
    expect(validatePlan({ ...planInput, backendTargetKeys: [] })).toBe(false);
    expect(validatePlan({ ...planInput, backendTargetKeys: [42] })).toBe(false);

    const spawnGetResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'session.spawn_new' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(spawnGetResult.ok).toBe(true);
    if (!spawnGetResult.ok) throw new Error('Expected spawn Action discovery');
    const definition = ActionDefinitionV1Schema.parse((spawnGetResult.result as { actionSpec: unknown }).actionSpec);
    expect(definition.kindVersion).toBe(1);
    if (!definition.inputSchema) throw new Error('Expected spawn input schema');
    // Exercise the published schema, including references, rather than requiring inline serialization.
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(await readCompleteInputSchema(spawnGetResult.result));
    const input = projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId: 'active', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/workspace/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      organizationPlacement: { folderId: null, tagIds: [] },
      agentSessionStartupInstructionsV1: { v: 1, id: 'fixture.instructions', revision: 1, instructions: 'Inspect the workspace.' },
    }));
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...input, executionTarget: { ...input.executionTarget, serverId: 'x'.repeat(192) } })).toBe(false);
    expect(validate({ ...input, organizationPlacement: { sectionId: null, tagIds: Array.from({ length: 501 }, (_, i) => `tag-${i}`) } })).toBe(false);
    for (const revision of [0, 2_147_483_648]) {
      expect(validate({ ...input, agentSessionStartupInstructionsV1: { ...input.agentSessionStartupInstructionsV1, revision } })).toBe(false);
    }
  });

  it('routes Action discovery through the canonical executor so contributed Actions are visible', async () => {
    const contributedSummary = {
      id: 'plugin:happier.example/action:memory.search',
      title: 'Search memory',
      description: 'Search plugin-owned memory.',
    };
    const executeActionByToolName = vi.fn(async (toolName: string) => {
      if (toolName === 'action_spec_search') {
        return ok({ actionSpecs: [contributedSummary] });
      }
      return unsupported();
    });

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_search',
      args: { query: 'memory' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: { actionSpecs: [contributedSummary] },
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_spec_search',
      { query: 'memory' },
      'sess-1',
    );
  });

  it('routes Action options through the canonical Action executor', async () => {
    const executeActionByToolName = vi.fn(async () => ok({
      actionId: 'subagents.plan.start',
      fieldPath: 'backendTargetKeys',
      optionsSourceId: 'execution.backends.enabled',
      options: [{ value: 'agent:codex', label: 'Codex' }],
    }));
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { actionId: 'subagents.plan.start', fieldPath: 'backendTargetKeys' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
        options: [{ value: 'agent:codex', label: 'Codex' }],
      },
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_options_resolve',
      { actionId: 'subagents.plan.start', fieldPath: 'backendTargetKeys' },
      'sess-1',
    );
  });

  it('preserves V2 session spawn option context through the agent/MCP discovery tool', async () => {
    const executeActionByToolName = vi.fn(async () => ok({
      actionId: 'session.spawn_new',
      fieldPath: 'modelSelection',
      optionsSourceId: 'agents.models.available',
      options: [],
    }));
    const sessionSpawnOptionContext = {
      executionTarget: { serverId: 'local', machineId: 'm1' },
      directory: '/repo',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'claude-opus-4-8' },
      },
    } as const;

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: {
        actionId: 'session.spawn_new',
        fieldPath: 'modelSelection',
        ...sessionSpawnOptionContext,
      },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: 'session.spawn_new',
        fieldPath: 'modelSelection',
        optionsSourceId: 'agents.models.available',
        options: [],
      },
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_options_resolve',
      {
        actionId: 'session.spawn_new',
        fieldPath: 'modelSelection',
        ...sessionSpawnOptionContext,
      },
      'sess-1',
    );
  });

  it('resolves canonical Action options on the CLI surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({
      actionId: null,
      fieldPath: null,
      optionsSourceId: 'session.modes.available',
      options: [{ value: 'plan', label: 'Plan' }],
    }));
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { optionsSourceId: 'session.modes.available' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [{ value: 'plan', label: 'Plan' }],
      },
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_options_resolve',
      { optionsSourceId: 'session.modes.available' },
      'sess-1',
    );
  });

  it('resolves action options directly from an optionsSourceId', async () => {
    const executeActionByToolName = vi.fn(async () => ok({
      actionId: null,
      fieldPath: null,
      optionsSourceId: 'session.modes.available',
      options: [{ value: 'plan', label: 'Plan' }],
    }));
    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_options_resolve',
      args: { optionsSourceId: 'session.modes.available' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [{ value: 'plan', label: 'Plan' }],
      },
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_options_resolve',
      { optionsSourceId: 'session.modes.available' },
      'sess-1',
    );
  });

  it('rejects disabled action specs through the shared policy hook', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'review.start' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({
          ok: false,
          errorCode: 'action_disabled',
          error: 'Action is disabled',
          details: {
            actionId: 'review.start',
            surface: 'agent',
            reason: 'disabled_by_policy',
          },
        }),
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expectActionDisabled(getResult);
  });

  it('does not expose non-MCP action specs through the shared discovery tools', async () => {
    const getResult = await dispatchBuiltInHappierTool({
      toolName: 'action_spec_get',
      args: { id: 'ui.voice_global.reset' },
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({
          ok: false,
          errorCode: 'action_disabled',
          error: 'Action is disabled',
          details: {
            actionId: 'ui.voice_global.reset',
            surface: 'mcp',
            reason: 'unsupported_surface',
          },
        }),
      },
    });

    expect(getResult).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: {
        actionId: 'ui.voice_global.reset',
        surface: 'mcp',
        reason: 'unsupported_surface',
      },
    });
  });

  it('dispatches action-backed tools through the shared action executor hook on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'review_start',
      args: { instructions: 'Check this' },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: directMcpExecutionSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('review_start', { instructions: 'Check this' }, 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: { toolName: 'review_start', args: { instructions: 'Check this' }, defaultSessionId: 'sess-1' },
    });
  });

  it('rejects disabled action-backed tools before execution', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'review_start',
      args: { instructions: 'Check this' },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects action-backed tools when the action is unavailable on the current surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'search_conversations',
      args: { query: { q: 'needle' } },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  describe('action_execute through the real tool bridge', () => {
    const composed = (input: Readonly<{ isActionEnabled?: (id: string) => boolean; surface?: 'cli' | 'agent';
      actionsSettings?: ReturnType<typeof ActionsSettingsV1Schema.parse> }> = {}) => {
      const execute = vi.fn(async () => ({ ok: true as const, result: { executed: true } }));
      const bridge = createActionToolExecutorBridge({ executor: { execute } as never, surface: input.surface ?? 'agent',
        isActionEnabled: input.isActionEnabled, getActionsSettings: () => input.actionsSettings ?? null });
      const dispatch = (actionId: string, actionInput: unknown) => dispatchBuiltInHappierTool({
        toolName: 'action_execute', args: { actionId, input: actionInput }, sessionId: 'sess-1',
        surface: input.surface, actionsSettings: input.actionsSettings,
        deps: { changeTitle: async () => ({ success: true }), isActionEnabled: input.isActionEnabled,
          executeActionByToolName: bridge.executeActionByToolName },
      });
      return { execute, dispatch };
    };

    it('admits an enabled target with one availability decision', async () => {
      const isActionEnabled = vi.fn((_id: string) => true);
      const { execute, dispatch } = composed({ isActionEnabled });
      isActionEnabled.mockClear();
      await expect(dispatch('review.start', { sessionId: 'sess-1' })).resolves.toMatchObject({ ok: true });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(isActionEnabled.mock.calls.filter(([id]) => id === 'review.start')).toHaveLength(1);
    });

    it('refuses a disabled target before execution', async () => {
      const { execute, dispatch } = composed({ isActionEnabled: (id) => id !== 'review.start' });
      expectActionDisabled(await dispatch('review.start', { sessionId: 'sess-1' }));
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses a target unavailable on the current surface', async () => {
      const { execute, dispatch } = composed({ surface: 'cli' });
      await expect(dispatch('account.plugins.data.erase', { pluginId: 'example.plugin' })).resolves.toMatchObject({
        ok: false, errorCode: 'action_disabled', error: 'Action is disabled',
        details: { actionId: 'account.plugins.data.erase', surface: 'cli', reason: 'unsupported_surface' },
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses a target disabled by explicit action settings', async () => {
      const { execute, dispatch } = composed({ actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'subagents.plan.start': { disabledSurfaces: ['agent'] } } }) });
      expectActionDisabled(await dispatch('subagents.plan.start', { backendTargetKeys: ['agent:codex'], instructions: 'Plan.' }));
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it('dispatches action_execute through the shared action executor hook', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'action_execute',
      args: { actionId: 'review.start', input: { sessionId: 'sess-1', instructions: 'Check this', engineIds: ['claude'] } },
      sessionId: 'sess-1',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith(
      'action_execute',
      { actionId: 'review.start', input: { sessionId: 'sess-1', instructions: 'Check this', engineIds: ['claude'] } },
      'sess-1',
    );
    expect(result).toEqual({
      ok: true,
      result: {
        toolName: 'action_execute',
        args: { actionId: 'review.start', input: { sessionId: 'sess-1', instructions: 'Check this', engineIds: ['claude'] } },
        defaultSessionId: 'sess-1',
      },
    });
  });

  it('dispatches plugins_reload through the generated canonical Action tool', async () => {
    const canonicalPendingReview = {
      ok: false,
      kind: 'plugins_reload',
      outcome: 'reviewRequired',
      pendingReview: {
        kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
        pendingChangeId: 'pending-1',
      },
    } as const;
    const executeActionByToolName = vi.fn(async (): Promise<HappierBuiltInToolDispatchResult> => ok(canonicalPendingReview));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'plugins_reload',
      args: { pluginId: 'acme.dev.plugin' },
      sessionId: 'sess-1',
      surface: 'cli',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith(
      'plugins_reload',
      { pluginId: 'acme.dev.plugin' },
      'sess-1',
    );
    expect(result).toEqual({
      ok: true,
      result: canonicalPendingReview,
    });
  });

  it('rejects discoverable-only first-party direct tool calls on the session-agent surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
      },
      sessionId: 'sess-1',
      surface: 'agent',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown built-in Happier tool: execution_run_start',
    });
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('dispatches execution_run_start through the shared action executor hook on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: directMcpExecutionSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', {
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: {
        toolName: 'execution_run_start',
        args: expect.objectContaining({
          intent: 'review',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          instructions: 'Review.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        }),
        defaultSessionId: 'sess-1',
      },
    });
  });

  it('routes delegate execution_run_start through the shared action executor on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'delegate',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Delegate.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: directMcpExecutionSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', expect.objectContaining({
      instructions: 'Delegate.',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      intent: 'delegate',
      permissionMode: 'workspace_write',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }), 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'execution_run_start' }),
    });
  });

  it('routes voice_agent execution_run_start through the shared action executor on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'voice_agent',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Start voice agent.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: directMcpExecutionSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', expect.objectContaining({
      instructions: 'Start voice agent.',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      intent: 'voice_agent',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    }), 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'execution_run_start' }),
    });
  });

  it('routes plan execution_run_start through the shared action executor on external MCP', async () => {
    const executeActionByToolName = vi.fn(
      async (toolName: string, args: unknown, defaultSessionId: string): Promise<HappierBuiltInToolDispatchResult> =>
        ok({ toolName, args, defaultSessionId }),
    );

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'plan',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        instructions: 'Plan.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: directMcpExecutionSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(executeActionByToolName).toHaveBeenCalledWith('execution_run_start', expect.objectContaining({
      instructions: 'Plan.',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      intent: 'plan',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }), 'sess-1');
    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({ toolName: 'execution_run_start' }),
    });
  });

  it('rejects execution_run_start when the equivalent action is disabled by policy', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review this task.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: directMcpExecutionSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
        isActionEnabled: (id) => id !== 'review.start',
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('rejects execution_run_start when explicit action settings disable the equivalent action', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ unreachable: true }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'execution.run.start': { toolExposureModes: { mcp: 'direct' } },
        'review.start': {
          disabledSurfaces: ['mcp'],
        },
      },
    });

    const result = await dispatchBuiltInHappierTool({
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review this task.',
      },
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expectActionDisabled(result);
    expect(executeActionByToolName).not.toHaveBeenCalled();
  });

  it('dispatches action-backed tools that are only surfaced on the agent surface', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ ok: true }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            agent: 'direct',
          },
        },
      },
    });

    const result = await dispatchBuiltInHappierTool({
      toolName: 'session_list',
      args: { limit: 10 },
      sessionId: 'sess-1',
      surface: 'agent',
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual(ok({ ok: true }));
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_list',
      { limit: 10 },
      'sess-1',
    );
  });

  it('passes approval origin metadata to action-backed tool execution', async () => {
    const executeActionByToolName = vi.fn(async () => ok({ ok: true }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            agent: 'direct',
          },
        },
      },
    });
    const approvalOrigin = {
      kind: 'transcript_tool_call' as const,
      sessionId: 'sess-1',
      toolCallId: 'tool-1',
      toolName: 'session_list',
      toolInput: { limit: 10 },
    };

    const result = await dispatchBuiltInHappierTool({
      toolName: 'session_list',
      args: { limit: 10 },
      sessionId: 'sess-1',
      surface: 'agent',
      approvalOrigin,
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(result).toEqual(ok({ ok: true }));
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_list',
      { limit: 10 },
      'sess-1',
      { approvalOrigin },
    );
  });

});
