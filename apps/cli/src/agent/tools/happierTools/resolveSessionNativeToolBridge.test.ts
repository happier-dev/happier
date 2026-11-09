import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { z } from 'zod/mini';

import { isSessionAgentToolAvailable, resolveSessionNativeToolDescriptors } from './resolveSessionNativeToolBridge';
import { Session } from 'node:inspector';
import { HAPPIER_BUILT_IN_TOOL_NAMES } from './catalog';
import { listBuiltInHappierTools } from './listBuiltInHappierTools';
import { resolveActionsSettingsWithEnvironmentOverride } from '@/settings/actionsSettings';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { projectMcpToolInputJsonSchema } from '@/mcp/server/projectMcpToolInputJsonSchema';
import { projectSessionBoundActionToolInputSchema } from './actionToolContext';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

const originalActionsSettingsEnv = process.env.HAPPIER_ACTIONS_SETTINGS_V1;

beforeEach(() => {
  delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
});

afterEach(() => {
  if (originalActionsSettingsEnv === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = originalActionsSettingsEnv;
});

describe('isSessionAgentToolAvailable', () => {
  it('evaluates only the named tool, matching membership in the whole admitted catalog', async () => {
    const accountSettings = { actionsSettingsV1: { v: 1, actions: { 'session.title.set': { enabled: false } } } };
    const whole = (settings: Readonly<Record<string, unknown>>) => {
      const actionsSettings = resolveActionsSettingsWithEnvironmentOverride(settings);
      return listBuiltInHappierTools({
        surface: 'agent', actionsSettings,
        isActionEnabled: id => isActionEnabledByActionsSettings(id, actionsSettings, { surface: 'agent', placement: null }),
      }).map(tool => tool.name);
    };
    for (const settings of [{}, accountSettings]) {
      const listed = new Set(whole(settings));
      // Every candidate name, listed or not, must answer exactly as the full catalog does.
      for (const toolName of [...HAPPIER_BUILT_IN_TOOL_NAMES, 'no_such_tool']) {
        expect([toolName, isSessionAgentToolAvailable({ toolName, accountSettings: settings, codingPromptBehavior: undefined })])
          .toEqual([toolName, listed.has(toolName)]);
      }
    }

    const inspector = new Session();
    const post = <T,>(method: string, params?: Record<string, unknown>) => new Promise<T>((resolve, reject) => {
      inspector.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T));
    });
    inspector.connect();
    try {
      await post('Profiler.enable');
      await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
      await post('Profiler.takePreciseCoverage');
      isSessionAgentToolAvailable({ toolName: 'session_compact', accountSettings: {} });
      const coverage = await post<{ result: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> }>('Profiler.takePreciseCoverage');
      const evaluated = coverage.result.flatMap(script => script.functions)
        .filter(fn => fn.functionName === 'isDirectManualToolAvailable')
        .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);
      expect(evaluated).toBe(1);
    } finally {
      await post('Profiler.stopPreciseCoverage').catch(() => undefined);
      inspector.disconnect();
    }
  });
});

describe('resolveSessionNativeToolDescriptors', () => {
  it('omits the native extension inventory when built-in Happier tools are disabled', () => {
    expect(resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'restricted-session',
      happierToolsEnabled: false, memoryRecallGuidanceEnabled: true,
      sessionMemoryEnabled: true, isServerFeatureEnabled: () => true }).map(tool => tool.name)).toEqual([]);
  });

  it('applies shared exposure settings to admitted external daemon Action tools and fails closed on omission', () => {
    const pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[] = [{
      toolId: 'dev.leads-fixture/record-analysis',
      actionId: 'dev.leads-fixture/actions/record-analysis',
      name: 'leads_record_analysis',
      title: 'Record lead analysis',
      description: 'Record a structured lead analysis.',
      inputSchema: {
        type: 'object',
        properties: { leadId: { type: 'string' }, score: { type: 'number' } },
        required: ['leadId', 'score'],
        additionalProperties: false,
      },
      surfaces: ['agent'],
    }];
    const resolve = (catalog: readonly ProjectedPluginToolCatalogEntry[], accountSettings: Readonly<Record<string, unknown>> = {}) => resolveSessionNativeToolDescriptors({
      accountSettings, sessionId: 'embed-created-session', sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: false, pluginToolCatalog: catalog,
    });
    const directSettings = { actionsSettingsV1: { v: 1, actions: {
      'dev.leads-fixture/actions/record-analysis': { toolExposureModes: { agent: 'direct' } },
    } } };
    const authoredDirectCatalog = pluginToolCatalog.map(tool => ({ ...tool, toolExposure: { agent: 'direct' as const } }));
    expect(resolve(pluginToolCatalog).map(tool => tool.name)).not.toContain('leads_record_analysis');
    expect(resolve(pluginToolCatalog).map(tool => tool.name)).toContain('action_execute');
    expect(resolve(pluginToolCatalog, directSettings)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'leads_record_analysis', title: 'Record lead analysis' }),
    ]));
    expect(resolve(authoredDirectCatalog).map(tool => tool.name)).toContain('leads_record_analysis');
    expect(resolve(authoredDirectCatalog, { actionsSettingsV1: { v: 1, actions: {
      'dev.leads-fixture/actions/record-analysis': { toolExposureModes: { agent: 'discoverable_only' } },
    } } }).map(tool => tool.name)).not.toContain('leads_record_analysis');
    expect(resolve([], directSettings).map((tool) => tool.name)).not.toContain('leads_record_analysis');
  });

  it('reuses repeated Board input definitions in the native Agent descriptor', () => {
    const spec = getActionSpec('session.board.item.upsert');
    const example = spec.examples?.mcp?.argsExample;
    if (!example) throw new Error('Expected the canonical Board authoring example');
    const input: unknown = JSON.parse(example);
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    const tool = resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'session-1',
      memoryRecallGuidanceEnabled: false, isServerFeatureEnabled: () => true,
    }).find(candidate => candidate.name === 'session_board_item_upsert');
    if (!tool?.inputSchema || typeof tool.inputSchema !== 'object') throw new Error('Expected the native Board tool');
    const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);
    expect(validate(input)).toBe(true);
    expect(validate({ itemId: 'incomplete' })).toBe(false);
    const parser = projectSessionBoundActionToolInputSchema({ actionId: spec.id, inputSchema: spec.inputSchema,
      context: { defaultSessionId: 'session-1' } });
    if (!(parser instanceof z.core.$ZodType)) throw new Error('Expected the canonical Zod input producer');
    const inline = projectMcpToolInputJsonSchema(zodSchemaToJsonSchemaObject(parser, { reused: 'inline' }));
    expect(JSON.stringify(tool.inputSchema).length).toBeLessThan(JSON.stringify(inline).length);
  });

  it('advertises only provider-compatible object roots through the real native tool catalog', () => {
    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {}, sessionId: 'session-1', sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: true, sessionMemoryEnabled: true, isServerFeatureEnabled: () => true,
    });
    expect(tools.length).toBeGreaterThan(0);
    const incompatible = tools.flatMap((tool, index) => {
      const schema = tool.inputSchema;
      return !schema || typeof schema !== 'object' || Array.isArray(schema) || !('type' in schema) || schema.type !== 'object'
        || ['oneOf', 'anyOf', 'allOf'].some(key => key in schema)
        ? [{ index, name: tool.name }] : [];
    });
    expect(incompatible).toEqual([]);
  });

  it('omits memory writes when the host Session choice is off and restores only policy-admitted writes', () => {
    const accountSettings = {
      actionsSettingsV1: { v: 1, actions: {
        'memory.remember': { toolExposureModes: { agent: 'direct' } },
        'memory.update': { toolExposureModes: { agent: 'direct' } },
        'memory.forget': { toolExposureModes: { agent: 'direct' }, enabled: false },
      } },
    };
    const resolve = (sessionMemoryEnabled: boolean) => resolveSessionNativeToolDescriptors({
      accountSettings, sessionId: 'session-1', memoryRecallGuidanceEnabled: false,
      sessionMemoryEnabled,
    }).map((tool) => tool.name);
    for (const name of ['memory_remember', 'memory_update', 'memory_forget']) expect(resolve(false)).not.toContain(name);
    expect(resolve(false)).toContain('action_execute');
    expect(resolve(true)).toEqual(expect.arrayContaining(['memory_remember', 'memory_update']));
    expect(resolve(true)).not.toContain('memory_forget');
  });

  it('uses the canonical direct catalog and promotes memory only while recall guidance is active', () => {
    const base = resolveSessionNativeToolDescriptors({
      accountSettings: {},
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: false,
    });
    expect(base.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'change_title',
      'action_spec_search',
      'action_spec_get',
      'action_options_resolve',
      'action_execute',
    ]));
    expect(base.map((tool) => tool.name)).not.toContain('memory_search');

    const withMemory = resolveSessionNativeToolDescriptors({
      accountSettings: {},
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: true,
    });
    expect(withMemory.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'memory_search',
      'memory_get_window',
    ]));
    const search = withMemory.find((tool) => tool.name === 'memory_search');
    const window = withMemory.find((tool) => tool.name === 'memory_get_window');
    expect(search?.inputSchema).not.toMatchObject({ required: expect.arrayContaining(['machineId']) });
    if (!window?.inputSchema || typeof window.inputSchema !== 'object') throw new Error('Missing memory window schema');
    const validateWindow = new Ajv2020({ strict: false }).compile(window.inputSchema);
    // Presentation is a field union; cross-field requirements remain with the Action parser.
    expect(getActionSpec('memory.get_window').inputSchema.safeParse({ seqFrom: 1, seqTo: 2 }).success).toBe(false);
    expect(validateWindow({ sessionId: 'historical-session', seqFrom: 1, seqTo: 2 })).toBe(true);
    expect(validateWindow({ source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
      sourceItemId: 'message', cursor: 'older' })).toBe(true);
  });

  it('exposes the current-Session presentation Action to the real native Agent tool catalog', () => {
    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {},
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).toContain('session_presentation_apply');
  });

  it('projects settings parity and mounted tab opening into the real Session Agent tool catalog', () => {
    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {},
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'settings_list',
      'settings_get',
      'settings_set',
      'settings_reset',
      'workspace_tabs_open',
    ]));
  });

  it('admits Board tools only when the exact Home feature and shared Action policy both allow them', () => {
    const resolve = (overrides: Partial<Parameters<typeof resolveSessionNativeToolDescriptors>[0]> = {}) => (
      resolveSessionNativeToolDescriptors({
        accountSettings: {},
        profileId: null,
        sessionId: 'session-1',
        sessionMachineId: 'machine-1',
        memoryRecallGuidanceEnabled: false,
        ...overrides,
      }).map((tool) => tool.name)
    );
    const boardTools = [
      'session_board_get',
      'session_board_item_upsert',
      'session_board_item_remove',
      'session_board_layout_update',
    ];

    for (const names of [
      resolve(),
      resolve({ isServerFeatureEnabled: () => false }),
      resolve({ isServerFeatureEnabled: () => { throw new Error('malformed feature snapshot'); } }),
    ]) {
      expect(names).not.toEqual(expect.arrayContaining(boardTools));
      expect(names).toEqual(expect.arrayContaining(['change_title', 'session_presentation_apply']));
    }

    expect(resolve({ isServerFeatureEnabled: (featureId) => featureId === 'sessions.board' }))
      .toEqual(expect.arrayContaining(boardTools));

    expect(resolve({
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.board.get': { enabled: false },
          },
        },
      },
      isServerFeatureEnabled: (featureId) => featureId === 'sessions.board',
    })).not.toContain('session_board_get');
  });

  it('honors profile title disabling and explicit discoverable-only memory exposure', () => {
    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {
        codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'agent' },
        profiles: [{
          v: 2,
          id: 'focused',
          name: 'Focused',
          extraEnvironmentVariables: [],
          defaultPermissionModeByTargetKey: {},
          defaultPersistenceModeByTargetKey: {},
          compatibilityByTargetKey: {},
          codingPromptBehaviorOverrides: { sessionTitleUpdates: 'disabled' },
          createdAt: 1,
          updatedAt: 1,
        }],
        actionsSettingsV1: {
          v: 1,
          actions: {
            'memory.search': { toolExposureModes: { agent: 'discoverable_only' } },
          },
        },
      },
      profileId: 'focused',
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).not.toContain('change_title');
    expect(tools.map((tool) => tool.name)).not.toContain('memory_search');
    expect(tools.map((tool) => tool.name)).toContain('memory_get_window');
  });

  it('omits the title tool when its canonical action is disabled', () => {
    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: { 'session.title.set': { enabled: false } },
        },
      },
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).not.toContain('change_title');
  });

  it('uses the environment action policy override for native presentation', () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'memory.search': { toolExposureModes: { agent: 'discoverable_only' } },
      },
    });

    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'memory.search': { toolExposureModes: { agent: 'direct' } },
          },
        },
      },
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).not.toContain('memory_search');
  });
});
