import { describe, expect, it } from 'vitest';

import { searchSerializedActionSpecsForSurface, actionSpecToActionDefinitionV1, projectActionDefinitionForExternalDiscovery } from './actionCatalog.js';
import {
  WORKFLOW_ACTION_IDS_V1,
} from '../workflows/actionsV1.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isRuntimeActionIdV1, SESSION_SUBAGENTS_GET_ACTION_ID, SESSION_SUBAGENTS_LIST_ACTION_ID } from './actionIds.js';
import {
  isRuntimeActionExecutorReal,
  resolveRuntimeActionSurfaces,
} from './surfaces.js';
import {
  ActionSpecSchema,
  HUMAN_SECRET_API_EXCLUSION_ACTION_IDS,
  INTERNAL_ACTION_IDS,
  INTERNAL_ACTION_REASONS,
  PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_REASONS,
  getActionSpec,
  listActionSpecs,
  listVoiceToolActionSpecs,
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
  isActionExecutableFromStandaloneMcp,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';

describe('actionToolExposure', () => {
  it('reports the effective foreign Session HTML settings state from the shared policy', () => {
    for (const [mode, settingsState, available] of [
      [undefined, 'disabled', false], ['allowed', 'enabled', true], ['ask_first', 'approval_required', true],
    ] as const) {
      const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        callerSurfacePolicies: { foreign_session_html: mode ? { 'session.message.send': mode } : {} },
      });
      expect(resolveActionSurfaceAvailability({ actionId: 'session.message.send', surface: 'ui',
        callerSurface: 'foreign_session_html', settings,
      })).toMatchObject({ available, settingsState });
    }
  });
  it.each(['machines.list', 'execution.run.list'] as const)('projects admitted built-in and contributed declarations through the same surface, settings and exposure policy (%s)', actionId => {
    const spec = getActionSpec(actionId);
    const definition = { ...actionSpecToActionDefinitionV1(spec), id: 'acme.triage/actions/list-machines' };
    for (const override of [undefined, { enabled: false }, { disabledSurfaces: ['api'] }, { toolExposureModes: { agent: 'direct' } }] as const) {
      const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
        ...(override ? { [spec.id]: override, [definition.id]: override } : {}),
      } });
      for (const surface of ['api', 'agent', 'mcp', 'rpc'] as const) {
        const builtin = resolveActionSurfaceAvailability({ actionId: spec.id, surface, settings });
        const contributed = resolveActionSurfaceAvailability({ actionId: definition.id, surface, settings, definition });
        expect(contributed).toEqual({ ...builtin, actionId: definition.id });
      }
    }
  });

  it('keeps settings and mounted tab opening discoverable', () => {
    for (const actionId of [
      'settings.list',
      'settings.get',
      'settings.set',
      'settings.reset',
      'settings.invoke',
      'workspace.tabs.open',
    ] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces, actionId).toMatchObject({ agent: true, mcp: true });
      expect(spec.bindings?.mcpToolName, actionId).toBe(actionId.replaceAll('.', '_'));
      expect(isActionDirectToolExposedOn(spec, 'agent'), actionId).toBe(false);
      expect(isActionDirectToolExposedOn(spec, 'mcp'), actionId).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'mcp'), actionId).toBe(true);
    }
  });

  it('delivers resource guidance through the same closed Action definition agents discover', () => {
    const definition = projectActionDefinitionForExternalDiscovery(actionSpecToActionDefinitionV1(getActionSpec('machines.storage.trash.move')));
    expect(definition.prompting).toMatchObject({ agentGuidance: expect.any(String) });
  });

  it('keeps resource reads and effects discoverable', () => {
    const resourceSpecs = listActionSpecs().filter((spec) => /^machines\.(vitals|resources|processes|storage|guard)\./u.test(spec.id));
    expect(resourceSpecs.length).toBeGreaterThan(0);
    for (const spec of resourceSpecs) {
      expect(isActionDiscoverableOnToolSurface(spec, 'agent'), spec.id).toBe(true);
      expect(isActionDirectToolExposedOn(spec, 'agent'), spec.id).toBe(false);
      if (spec.sideEffectClass !== 'read') {
        expect(spec.prompting?.agentGuidance, spec.id).toEqual(expect.any(String));
      }
    }
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'machines.storage.deleteNow': { toolExposureModes: { agent: 'direct' } },
    } });
    expect(isActionDirectToolExposedOn(getActionSpec('machines.storage.deleteNow'), 'agent', { settings })).toBe(true);
  });

  it('derives the resource surface census from enabled specs, policy and canonical placement owners', () => {
    const unbacked: string[] = [];
    const resourceSpecs = listActionSpecs().filter((spec) => /^machines\.(vitals|resources|processes|storage|guard)\./u.test(spec.id));
    for (const spec of resourceSpecs) {
      for (const surface of ['ui', 'voice', 'agent', 'mcp', 'cli'] as const) {
        if (!spec.surfaces[surface]) continue;
        const policy = resolveActionSurfaceAvailability({ actionId: spec.id, surface });
        if (!policy.available) { unbacked.push(`${spec.id}:${surface}:policy`); continue; }
        // These schemas are the canonical DTO owners consumed by the SDK generator.
        if (!spec.inputSchema || !spec.outputSchema) { unbacked.push(`${spec.id}:${surface}:dto`); continue; }
        if (isRuntimeActionIdV1(spec.id)) {
          if (!isRuntimeActionExecutorReal(spec.id)) unbacked.push(`${spec.id}:${surface}:runtime`);
          continue;
        }
        if (spec.executionPlacement === 'client') {
          // The answering-client adapter is the live handler; standalone CLI has no such transport.
          if (surface === 'cli') unbacked.push(`${spec.id}:${surface}:no-client`);
          continue;
        }
        // Remaining specs are owned by the canonical ActionExecutor dispatch corridor.
        expect(spec.executionPlacement, spec.id).toMatch(/^(account|machine|session)$/u);
      }
    }
    expect(unbacked).toEqual([]);
  });
  it('exposes the backed sandbox installer to agent discovery without changing its danger classification', () => {
    const actionId = 'browser.sandbox.install';
    const spec = getActionSpec(actionId);
    expect(isRuntimeActionExecutorReal(actionId)).toBe(true);
    expect(resolveRuntimeActionSurfaces(actionId).agent).toBe(true);
    expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    expect(resolveActionSurfaceAvailability({ actionId: spec.id, surface: 'ui' }).available).toBe(true);
    expect(spec).toMatchObject({ safety: 'danger', requiredAuthority: 'account_automation' });
  });
  it('uses the same Session memory availability for direct and discoverable writes without changing Account surfaces', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'memory.remember': { toolExposureModes: { agent: 'direct' } },
      'memory.decision.save': { toolExposureModes: { agent: 'direct' } },
      'memory.update': { toolExposureModes: { agent: 'direct' } },
      'memory.forget': { toolExposureModes: { agent: 'direct' } },
    } });
    for (const id of ['memory.remember', 'memory.decision.save', 'memory.update', 'memory.forget'] as const) {
      const spec = getActionSpec(id);
      expect(isActionDirectToolExposedOn(spec, 'agent', { settings, sessionMemoryEnabled: true }), id).toBe(true);
      expect(isActionDirectToolExposedOn(spec, 'agent', { settings, sessionMemoryEnabled: false }), id).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent', { settings, sessionMemoryEnabled: false }), id).toBe(false);
      expect(resolveActionSurfaceAvailability({ actionId: id, surface: 'agent', sessionMemoryEnabled: false }), id)
        .toMatchObject({ available: false, reason: 'disabled_by_policy' });
      expect(isActionDiscoverableOnToolSurface(spec, 'mcp'), id).toBe(true);
      expect(isActionDiscoverableOnToolSurface(spec, 'cli'), id).toBe(true);
    }
    expect(isActionDiscoverableOnToolSurface(getActionSpec('memory.search'), 'agent', { sessionMemoryEnabled: false })).toBe(true);
  });

  it('discovers goal recovery through the canonical Agent action policy', () => {
    for (const id of ['session.goal.get', 'session.goal.set', 'session.goal.clear'] as const) {
      const spec = getActionSpec(id);
      expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
      expect(spec.contextualDefaults).toEqual({ sessionId: 'current_session' });
      const settings = ActionsSettingsV1Schema.parse({
        v: 1, actions: { [id]: { toolExposureModes: { agent: 'discoverable_only' } } },
      });
      expect(isActionDirectToolExposedOn(spec, 'agent', { settings })).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent', { settings })).toBe(true);
    }
    expect(getActionSpec('session.goal.clear').approval).toEqual({ result: 'required' });
  });

  it('narrows unbound MCP hosts without removing the bound Agent Session presentation tool', () => {
    const spec = getActionSpec('session.presentation.apply');
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(false);
    expect(isActionExecutableFromStandaloneMcp(spec)).toBe(false);
    for (const id of ['sessions.external.candidates.list', 'sessions.external.materialize.start', 'session.status.get', 'ui.find'] as const) {
      expect(isActionExecutableFromStandaloneMcp(getActionSpec(id)), id).toBe(true);
    }
  });
  it('keeps relayed Find and Next discoverable on MCP and Agent surfaces', () => {
    for (const id of ['ui.find', 'session.pending.next'] as const) {
      const spec = getActionSpec(id);
      expect(isActionDirectToolExposedOn(spec, 'mcp'), id).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'mcp'), id).toBe(true);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent'), id).toBe(true);
      expect(resolveActionToolExposureMode(spec, 'agent'), id).toBe('discoverable_only');
      expect(resolveActionSurfaceAvailability({ actionId: id, surface: 'cli' }).available, id).toBe(id === 'ui.find');
    }
    const picker = getActionSpec('ui.prompts.picker.open');
    expect(isActionDiscoverableOnToolSurface(picker, 'agent')).toBe(true);
    expect(resolveActionSurfaceAvailability({ actionId: picker.id, surface: 'mcp' }).available).toBe(true);
  });
  it('makes landed explanation Actions reachable through the existing UI and Voice catalogs', () => {
    const voiceIds = new Set(listVoiceToolActionSpecs().map((spec) => spec.id));
    for (const actionId of ['scm.diffSummary.capture', 'scm.diffSummary.generate', 'scm.diffSummary.draftPullRequest', 'scm.diffSummary.result.read',
      'scm.diffSummary.result.edit', 'scm.diffSummary.result.undo', 'scm.diffSummary.result.delete',
      'scm.diffSummary.refine', 'scm.diffSummary.addOutputs', 'scm.diffSummary.discuss',
      'scm.diffSummary.reviewed.mark', 'scm.diffSummary.reviewed.unmark'] as const) {
      expect(resolveActionSurfaceAvailability({ actionId, surface: 'ui' }).available, actionId).toBe(true);
      expect(voiceIds.has(actionId), actionId).toBe(true);
      const parsed = ActionSpecSchema.safeParse(getActionSpec(actionId));
      expect(parsed.success, parsed.success ? actionId : `${actionId}: ${JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });
  it('defaults first-party agent action-backed tools to discoverable-only unless allow-listed', () => {
    for (const id of ['review.start', 'subagents.delegate.start', 'execution.run.start', 'session.status.get'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
      expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    }
  });

  it.each(['agent', 'mcp'] as const)('keeps only %s core discovery directly exposed', (surface) => {
    for (const id of [
      'action.spec.search',
      'action.spec.get',
      'action.options.resolve',
      'execution.run.list',
      'execution.run.get',
      'execution.run.wait',
      'plugins.reload',
    ] as const) {
      const spec = getActionSpec(id);

      const core = id === 'action.spec.search' || id === 'action.spec.get';
      expect(resolveActionToolExposureMode(spec, surface)).toBe(core ? 'direct' : 'discoverable_only');
      expect(isActionDirectToolExposedOn(spec, surface)).toBe(core);
      expect(isActionDiscoverableOnToolSurface(spec, surface)).toBe(true);
    }
  });

  it('discovers the current-Session presentation command to Agents and MCP', () => {
    const spec = getActionSpec('session.presentation.apply');

    expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
    expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'mcp')).toBe('discoverable_only');
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp')).toBe(true);
  });

  it('discovers the primary Discussion reply while retaining explicit exposure and disable policy', () => {
    const spec = getActionSpec('discussion.reply');
    expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp')).toBe(true);
    const discoverable = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'discussion.reply': { toolExposureModes: { agent: 'discoverable_only' } },
    } });
    expect(isActionDirectToolExposedOn(spec, 'agent', { settings: discoverable })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'agent', { settings: discoverable })).toBe(true);
    const disabled = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'discussion.reply': { enabled: false },
    } });
    expect(isActionDiscoverableOnToolSurface(spec, 'agent', { settings: disabled })).toBe(false);
  });

  it('discovers the Session Board Action family to Agents and MCP', () => {
    for (const id of [
      'session.board.get',
      'session.board.item.upsert',
      'session.board.item.remove',
      'session.board.layout.update',
    ] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
      expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
      expect(resolveActionToolExposureMode(spec, 'mcp')).toBe('discoverable_only');
      expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'mcp')).toBe(true);
    }
  });

  it('keeps every Workflow Action discoverable on MCP', () => {

    for (const actionId of WORKFLOW_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      const availability = resolveActionSurfaceAvailability({ actionId, surface: 'mcp' });

      // The generic external MCP `action_execute` transport must never
      // surface-reject a Workflow operation.
      expect(availability, actionId).toEqual(expect.objectContaining({
        available: true,
        reason: 'available',
        actionId,
        surface: 'mcp',
      }));
      expect(isActionDiscoverableOnToolSurface(spec, 'mcp'), actionId).toBe(true);

        expect(resolveActionToolExposureMode(spec, 'mcp'), actionId).toBe('discoverable_only');
        expect(isActionDirectToolExposedOn(spec, 'mcp'), actionId).toBe(false);
    }
  });

  it('shares the Agent discovery default with MCP while keeping CLI direct', () => {
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'mcp')).toBe('discoverable_only');
    expect(resolveActionToolExposureMode(spec, 'cli')).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp')).toBe(true);
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
      actionId: 'execution.run.ensure_or_start',
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
    const humanSecretApiExcludedActionIds = new Set(HUMAN_SECRET_API_EXCLUSION_ACTION_IDS);
    const pluginProvenanceOnlyActionIds = new Set(PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS);
    const pluginSurfaceExcludedActionIds = new Set(PLUGIN_SURFACE_EXCLUSION_ACTION_IDS);
    // Saved-secret administration, token inventory and installation withhold PAT access at their spec owners;
    // the dedicated registry contract also checks these remain absent from PublicActionId.
    const specApiExcludedActionIds = new Set([
      'computer.secret.fill', 'plugins.settings.secret.bind', 'plugins.settings.secret.unbind', 'plugins.settings.secret.delete',
      'account.apiTokens.list', 'plugins.install',
    ]);

    expect(INTERNAL_ACTION_IDS).not.toContain('plugin.webhook.delivery.movePending');
    expect(getActionSpec('plugin.webhook.delivery.movePending').surfaces).toMatchObject({ agent: true, mcp: true, api: false, plugin: false });
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
          spec.id !== 'plugin.webhook.delivery.movePending'
            && !pluginProvenanceOnlyActionIds.has(spec.id)
            && !humanSecretApiExcludedActionIds.has(spec.id)
            && !specApiExcludedActionIds.has(spec.id)
            && (!isRuntimeActionIdV1(spec.id) || isRuntimeActionExecutorReal(spec.id))
            && (spec.requiredAuthority === 'account_automation'
              || ['approval.request.decide', 'session.permission.respond', 'session.user_action.answer'].includes(spec.id)),
        );
        expect(spec.surfaces.plugin, spec.id).toBe(
          (!isRuntimeActionIdV1(spec.id) || isRuntimeActionExecutorReal(spec.id))
            && !pluginSurfaceExcludedActionIds.has(spec.id),
        );
      }
    }

    expect(getActionSpec('projects.list').surfaces).toEqual(expect.objectContaining({
      agent: true,
      mcp: true,
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

  it('exposes bounded subagent reads while keeping lifecycle mutations RPC-only', () => {
    const readActionIds = [
      SESSION_SUBAGENTS_LIST_ACTION_ID,
      SESSION_SUBAGENTS_GET_ACTION_ID,
      'sessions.subagents.watch',
    ] as const;
    const mutationActionIds = [
      'sessions.subagents.upsert',
      'sessions.subagents.updateStatus',
      'sessions.subagents.complete',
    ] as const;

    expect(INTERNAL_ACTION_IDS.filter((actionId) => actionId.startsWith('sessions.subagents.')))
      .toEqual(mutationActionIds);
    for (const actionId of readActionIds) {
      expect(getActionSpec(actionId).surfaces).toEqual(expect.objectContaining({
        rpc: true,
        api: true,
        plugin: true,
      }));
      expect(INTERNAL_ACTION_REASONS).not.toHaveProperty(actionId);
      expect(PLUGIN_SURFACE_EXCLUSION_REASONS).not.toHaveProperty(actionId);
    }
    for (const actionId of mutationActionIds) {
      expect(getActionSpec(actionId).surfaces).toEqual(expect.objectContaining({
        rpc: true,
        api: false,
        plugin: false,
      }));
      expect(PLUGIN_SURFACE_EXCLUSION_REASONS[actionId]).toBe(INTERNAL_ACTION_REASONS[actionId]);
    }
    expect(isActionDiscoverableOnToolSurface(getActionSpec(SESSION_SUBAGENTS_LIST_ACTION_ID), 'agent')).toBe(true);
    expect(isActionDiscoverableOnToolSurface(getActionSpec(SESSION_SUBAGENTS_GET_ACTION_ID), 'agent')).toBe(true);

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
    expect(getActionSpec('projects.list').executionPlacement).toBe('account');
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
