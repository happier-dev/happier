import { describe, expect, it } from 'vitest';

import { searchSerializedActionSpecsForSurface } from './actionCatalog.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isRuntimeActionIdV1 } from './actionIds.js';
import {
  isRuntimeActionExecutorReal,
  resolveRuntimeActionSurfaces,
} from './surfaces.js';
import {
  ActionSpecSchema,
  INTERNAL_ACTION_IDS,
  INTERNAL_ACTION_REASONS,
  PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_REASONS,
  getActionSpec,
  listActionSpecs,
  resolveActionSdkMethodName,
} from './actionSpecs.js';
import {
  ACTION_SURFACE_POLICIES,
  getActionSurfacePolicy,
  listActionSurfacePolicies,
  resolveActionSurfaceAvailability,
} from './actionSurfaceAvailability.js';
import {
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';

describe('actionToolExposure', () => {
  it('defaults first-party agent action-backed tools to discoverable-only unless allow-listed', () => {
    for (const id of ['review.start', 'subagents.delegate.start', 'execution.run.start', 'session.status.get'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
      expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    }
  });

  it('keeps agent action discovery and reload specs directly exposed', () => {
    for (const id of ['action.spec.search', 'action.spec.get', 'action.options.resolve', 'plugins.reload'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'agent')).toBe('direct');
      expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(true);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    }
  });

  it('keeps external mcp and cli direct by default', () => {
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'mcp')).toBe('direct');
    expect(resolveActionToolExposureMode(spec, 'cli')).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(true);
    expect(isActionDirectToolExposedOn(spec, 'cli')).toBe(true);
  });

  it('applies sparse per-surface settings overrides', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          toolExposureModes: {
            agent: 'direct',
            mcp: 'discoverable_only',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'agent', { settings })).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'agent', { settings })).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'mcp', { settings })).toBe('discoverable_only');
    expect(isActionDirectToolExposedOn(spec, 'mcp', { settings })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp', { settings })).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'cli', { settings })).toBe('direct');
  });

  it('keeps disabled actions neither direct nor discoverable', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          disabledSurfaces: ['agent'],
          toolExposureModes: {
            agent: 'direct',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(isActionDirectToolExposedOn(spec, 'agent', { settings })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'agent', { settings })).toBe(false);
  });

  it('returns structured first-party availability reasons for settings, surface, and policy denials', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.title.set': {
          disabledSurfaces: ['agent'],
        },
      },
    });

    expect(resolveActionSurfaceAvailability({
      actionId: 'session.spawn_new',
      surface: 'agent',
    })).toEqual(expect.objectContaining({
      available: true,
      reason: 'available',
      actionId: 'session.spawn_new',
      surface: 'agent',
      defaultToolExposureMode: 'discoverable_only',
      effectiveToolExposureMode: 'discoverable_only',
    }));
    expect(resolveActionSurfaceAvailability({
      actionId: 'session.title.set',
      surface: 'agent',
      settings,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'disabled_by_settings',
      settingsState: 'disabled',
    }));
    expect(resolveActionSurfaceAvailability({
      actionId: 'session.title.set',
      surface: 'agent',
      isActionEnabled: () => false,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'disabled_by_policy',
    }));
  });

  it('keeps direct tool binding checks separate from discoverable availability', () => {
    expect(resolveActionSurfaceAvailability({
      actionId: 'execution.run.ensure',
      surface: 'agent',
      requireToolBinding: true,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'missing_tool_binding',
    }));
  });

  it('explicitly classifies every action surface for settings configurability', () => {
    expect(listActionSurfacePolicies().map((policy) => policy.surface)).toEqual([
      'ui',
      'voice',
      'agent',
      'mcp',
      'cli',
      'rpc',
      'api',
      'plugin',
    ]);
    expect(getActionSurfacePolicy('rpc')).toEqual(expect.objectContaining({
      settingsConfigurable: false,
      classification: 'internal',
    }));
    expect(getActionSurfacePolicy('api')).toEqual(expect.objectContaining({
      settingsConfigurable: true,
      classification: 'settings_configurable',
    }));
    expect(getActionSurfacePolicy('plugin')).toEqual(expect.objectContaining({
      settingsConfigurable: true,
      classification: 'settings_configurable',
    }));
    expect(ACTION_SURFACE_POLICIES.every((policy) => typeof policy.settingsConfigurable === 'boolean')).toBe(true);
  });

  it('makes ordinary user Actions available through the configurable external API by default', () => {
    expect(resolveActionSurfaceAvailability({
      actionId: 'session.spawn_new',
      surface: 'api',
    })).toEqual(expect.objectContaining({
      available: true,
      reason: 'available',
      surface: 'api',
    }));

    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.spawn_new': {
          disabledSurfaces: ['api'],
        },
      },
    });
    expect(resolveActionSurfaceAvailability({
      actionId: 'session.spawn_new',
      surface: 'api',
      settings,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'disabled_by_settings',
      settingsState: 'disabled',
    }));
  });

  it('derives public Action projections from reasoned exclusions independently of execution placement', () => {
    const internalActionIds = new Set(INTERNAL_ACTION_IDS);
    const pluginProvenanceOnlyActionIds = new Set(PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS);
    const pluginSurfaceExcludedActionIds = new Set(PLUGIN_SURFACE_EXCLUSION_ACTION_IDS);

    expect(INTERNAL_ACTION_IDS).toContain('plugin.webhook.delivery.movePending');
    for (const actionId of INTERNAL_ACTION_IDS) {
      expect(INTERNAL_ACTION_REASONS[actionId]).toMatch(/\S/);
    }
    for (const actionId of PLUGIN_SURFACE_EXCLUSION_ACTION_IDS) {
      expect(PLUGIN_SURFACE_EXCLUSION_REASONS[actionId]).toMatch(/\S/);
    }

    for (const spec of listActionSpecs()) {
      if (internalActionIds.has(spec.id)) {
        expect(spec.surfaces.api).toBe(false);
        expect(spec.surfaces.plugin).toBe(false);
      } else {
        expect(spec.surfaces.api, spec.id).toBe(
          !pluginProvenanceOnlyActionIds.has(spec.id),
        );
        expect(spec.surfaces.plugin, spec.id).toBe(
          !pluginSurfaceExcludedActionIds.has(spec.id),
        );
      }
    }

    expect(getActionSpec('projects.list').surfaces).toEqual(expect.objectContaining({
      api: true,
      plugin: true,
    }));
    expect(getActionSpec('ui.current_context.read').surfaces).toEqual(expect.objectContaining({
      voice: true,
      api: true,
      plugin: true,
    }));
    expect(getActionSpec('ui.current_context.command.invoke').surfaces).toEqual(expect.objectContaining({
      voice: true,
      api: true,
      plugin: true,
    }));
    expect(getActionSpec('voice_agent.start').surfaces).toEqual(expect.objectContaining({
      api: true,
      plugin: true,
    }));
  });

  it('publishes safe subagent reads and keeps lifecycle mutations internal', () => {
    const safeSubagentReadActionIds = [
      'sessions.subagents.list',
      'sessions.subagents.get',
      'sessions.subagents.watch',
    ] as const;
    const safeSubagentReadActionIdSet = new Set<string>(safeSubagentReadActionIds);
    expect(INTERNAL_ACTION_IDS.filter((actionId) => safeSubagentReadActionIdSet.has(actionId)))
      .toEqual([]);
    for (const actionId of safeSubagentReadActionIds) {
      expect(getActionSpec(actionId).surfaces).toEqual(expect.objectContaining({
        rpc: true,
        api: true,
        plugin: true,
      }));
    }

    const lifecycleMutationActionIds = [
      'sessions.subagents.upsert',
      'sessions.subagents.updateStatus',
      'sessions.subagents.complete',
    ] as const;

    expect(INTERNAL_ACTION_IDS.filter((actionId) => actionId.startsWith('sessions.subagents.')))
      .toEqual(lifecycleMutationActionIds);
    for (const actionId of lifecycleMutationActionIds) {
      expect(getActionSpec(actionId).surfaces).toEqual(expect.objectContaining({
        rpc: true,
        api: false,
        plugin: false,
      }));
      expect(PLUGIN_SURFACE_EXCLUSION_REASONS[actionId]).toBe(INTERNAL_ACTION_REASONS[actionId]);
    }

    for (const actionId of ['subagents.plan.start', 'subagents.delegate.start', 'voice_agent.start'] as const) {
      expect(getActionSpec(actionId).surfaces).toEqual(expect.objectContaining({
        api: true,
        plugin: true,
      }));
    }
  });

  /**
   * Each runtime Action on the internal list is internal because no executor
   * routes it through the ActionExecutor front door. That reason is only worth
   * having if the backing census agrees with it: an executor wired without
   * clearing the internal entry would surface an Action that no public catalog
   * lists, and an internal entry left behind after the executor lands would be
   * a second decision-maker for the same Action.
   */
  it('keeps every internal runtime Action unbacked and unsurfaced in the executor census', () => {
    const internalRuntimeActionIds = INTERNAL_ACTION_IDS.filter(isRuntimeActionIdV1);

    expect(internalRuntimeActionIds).toEqual([
      'devices.simulator.input.orientation',
    ]);
    for (const actionId of internalRuntimeActionIds) {
      expect(isRuntimeActionExecutorReal(actionId), actionId).toBe(false);
      expect(resolveRuntimeActionSurfaces(actionId), actionId).toEqual({
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
      });
    }
  });

  it('stamps action execution placement at the registry owner', () => {
    expect(getActionSpec('machines.list').executionPlacement).toBe('account');
    expect(getActionSpec('servers.list').executionPlacement).toBe('client');
    expect(getActionSpec('projects.list').executionPlacement).toBe('client');
    expect(getActionSpec('session.spawn_new').executionPlacement).toBe('machine');
    expect(getActionSpec('approval.request.decide').executionPlacement).toBe('account');
    expect(getActionSpec('session.activity.get').executionPlacement).toBe('session');
    expect(getActionSpec('execution.run.start').executionPlacement).toBe('machine');
    expect(getActionSpec('ui.current_context.read').executionPlacement).toBe('client');
  });

  it('routes persisted transcript readers through a selected machine instead of a current Session publisher', () => {
    for (const actionId of [
      'session.history.get',
      'session.transcript.get',
      'session.events.get',
      'session.messages.recent.get',
      'transcript.page',
      'transcript.readAfter',
      'transcript.search',
    ] as const) {
      expect(getActionSpec(actionId).executionPlacement, actionId).toBe('machine');
    }
  });

  it('keeps live transcript controls at the current Session publisher', () => {
    for (const actionId of [
      'session.log.tail',
      'transcript.follow',
      'transcript.unfollow',
      'transcript.import',
    ] as const) {
      expect(getActionSpec(actionId).executionPlacement, actionId).toBe('session');
    }
  });

  it('makes transcript follow lifecycle actions available to CLI history', () => {
    for (const actionId of ['transcript.follow', 'transcript.unfollow'] as const) {
      expect(resolveActionSurfaceAvailability({
        actionId,
        surface: 'cli',
      }), actionId).toEqual(expect.objectContaining({
        available: true,
        reason: 'available',
        surface: 'cli',
      }));
    }
  });

  it('keeps every final public projection valid after openness and caller-policy normalization', () => {
    const invalidActionIds = listActionSpecs()
      .filter((spec) => !ActionSpecSchema.safeParse(spec).success)
      .map((spec) => spec.id);

    expect(invalidActionIds).toEqual([]);
  });

  it('projects collision-free SDK method paths without reserved or object-hazard segments', () => {
    const methodNames = listActionSpecs()
      .filter((spec) => spec.surfaces.api)
      .map(resolveActionSdkMethodName);

    expect(methodNames).toContain('session.handoff.start');
    expect(methodNames).not.toContain('sessions.external.takeover.execute');
    expect(resolveActionSdkMethodName(getActionSpec('sessions.external.takeover')))
      .toBe('sessions.external.takeover.execute');
    expect(resolveActionSdkMethodName(getActionSpec('session.handoff.prepare_target')))
      .toBe('session.handoff.prepareTarget.start');
    expect(new Set(methodNames).size).toBe(methodNames.length);
    for (const methodName of methodNames) {
      expect(methodName.split('.')).not.toContain('__proto__');
      expect(methodName.split('.')).not.toContain('constructor');
      expect(methodName.split('.')).not.toContain('prototype');
      expect(['execute', 'search', 'invoke']).not.toContain(methodName);
    }
  });

  it('keeps discoverable-only agent actions in action search results', () => {
    const results = searchSerializedActionSpecsForSurface({
      surface: 'agent',
      query: 'delegate',
      limit: 10,
    });

    expect(results.map((spec) => spec.id)).toContain('subagents.delegate.start');
  });
});
