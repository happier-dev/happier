import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import * as protocol from '../index.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../rpc/index.js';
import {
  ExecutionRunGetResponseSchema,
  ExecutionRunIntentSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunSendResponseSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../execution/runs/index.js';
import { actionSpecToActionDefinitionV1, serializeActionSpec } from './actionCatalog.js';
import { ActionInputHintsSchema, ActionSpecSchema, PUBLIC_ACTION_IDS, PUBLIC_ACTION_INPUT_SCHEMAS, PUBLIC_ACTION_OUTPUT_SCHEMAS, PublicActionIdSchema, SESSION_TRANSCRIPT_GET_MAX_LIMIT, ActionSurfaceSchema, PLUGIN_ACTION_INPUT_SCHEMAS, PLUGIN_ACTION_OUTPUT_SCHEMAS, PLUGIN_INVOCABLE_ACTION_IDS, PluginInvocableActionIdSchema, SessionTranscriptGetExternalShareableInputV1Schema, getActionContextualDefaults, getActionSpec, isActionSpecSurfacedOn, isInternalActionId, isPluginProvenanceOnlyActionId, isPluginSurfaceExcludedActionId, isVoicePromptHotPathSpec, isVoiceSdkSafeActionSpec, listActionSpecs, listActionSpecsForSurface, listVoicePromptHotPathSpecs, projectSessionSpawnNewApiRequest, resolveRuntimeActionHostEffectClass } from './actionSpecs.js';
import { resolveRuntimeActionSurfaces } from './surfaces.js';
import type { ActionSpec } from './actionSpecs.js';
import {
  ActionIdSchema,
  PLUGIN_DEV_LOOP_ACTION_IDS_V1,
  RuntimeActionIdV1Schema,
  type ActionId,
  type RuntimeActionIdV1,
} from './actionIds.js';

const RETIRED_UNBACKED_RUNTIME_ACTION_IDS = [
  'browser.automation.evaluate',
  'browser.automation.elementPicker.start',
  'browser.automation.elementPicker.cancel',
  'devices.simulator.stream.open',
  'devices.simulator.stream.close',
] as const;

const RUNTIME_ACTION_IDS = [
  'browser.session.create',
  'browser.session.close',
  'browser.view.open',
  'browser.view.close',
  'browser.view.focus',
  'browser.target.set',
  'browser.navigate',
  'browser.reload',
  'browser.goBack',
  'browser.goForward',
  'browser.stop',
  'browser.diagnostics.snapshot',
  'browser.diagnostics.clear',
  'browser.diagnostics.pause',
  'browser.diagnostics.resume',
  'browser.diagnostics.eval',
  'browser.diagnostics.getProperties',
  'browser.diagnostics.releaseObjectGroup',
  'browser.diagnostics.elementPicker.start',
  'browser.diagnostics.elementPicker.cancel',
  'browser.context.capturePage',
  'browser.context.captureScreenshot',
  'browser.context.captureSelectedElement',
  'browser.context.captureNetworkSummary',
  'browser.context.captureConsoleSummary',
  'browser.context.annotation.start',
  'browser.context.annotation.cancel',
  'browser.context.annotation.captureRegion',
  'browser.context.annotation.captureElement',
  'browser.context.annotation.attachComment',
  'browser.context.annotation.attachStroke',
  'browser.context.annotation.attachStyleIntent',
  'browser.context.attachToComposer',
  'browser.context.attachToAgentTurn',
  'browser.context.clear',
  'browser.automation.status',
  'browser.automation.snapshot',
  'browser.automation.semanticSnapshot',
  'browser.automation.queryElements',
  'browser.automation.waitFor',
  'browser.automation.timeline.get',
  'browser.automation.cancelActive',
  'browser.automation.navigate',
  'browser.automation.reload',
  'browser.automation.goBack',
  'browser.automation.goForward',
  'browser.automation.click',
  'browser.automation.tap',
  'browser.automation.type',
  'browser.automation.press',
  'browser.automation.scroll',
  'browser.automation.hover',
  'browser.automation.focus',
  'browser.automation.select',
  'browser.automation.setValue',
  'browser.automation.upload',
  'browser.automation.drag',
  'browser.recording.start',
  'browser.recording.stop',
  'browser.recording.cancel',
  'browser.recording.status',
  'browser.recording.listForView',
  'browser.recording.discard',
  'browser.recording.cleanupExpired',
  'browser.recording.attachToComposer',
  'localServices.inventory.list',
  'localServices.inventory.refresh',
  'localServices.launcher.snapshot',
  'localServices.launcher.start',
  'localServices.launcher.openPreview',
  'localServices.launcher.registerPreview',
  'localServices.launcher.history.clear',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
  'localServices.publicPreview.create',
  'localServices.publicPreview.status',
  'localServices.publicPreview.revoke',
  'localServices.publicPreview.copyUrl',
  'localServices.actions.copyUrl',
  'localServices.actions.openPreview',
  'localServices.actions.forget',
  'localServices.actions.stopManaged',
  'localServices.actions.restartManaged',
  'localServices.actions.terminateDetected',
  'peerMediation.observability.snapshot',
  'peerMediation.observability.subscribe',
  'peerMediation.observability.unsubscribe',
  'devices.simulator.list',
  'devices.simulator.stream.keyframe',
  'devices.simulator.stream.snapshot',
  'devices.simulator.stream.quality.set',
  'devices.simulator.stream.fps.set',
  'devices.simulator.stream.scale.set',
  'devices.simulator.lease.acquire',
  'devices.simulator.lease.renew',
  'devices.simulator.lease.release',
  'devices.simulator.input.tap',
  'devices.simulator.input.swipe',
  'devices.simulator.input.text',
  'devices.simulator.input.key',
  'devices.simulator.input.button',
  'devices.simulator.input.orientation',
  'devices.simulator.input.pinch',
  'devices.simulator.input.rotate',
  'devices.simulator.sideband.request',
] as const;

const RESULT_REQUIRED_BLOCKING_ACTION_IDS = [
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  'action.invoke',
  'account.plugins.data.erase',
  'account.sessions.signOutEverywhere',
  'account.apiTokens.create',
  'account.apiTokens.list',
  'account.apiTokens.revoke',
  'account.apiTokens.revokeAll',
  'sessions.subagents.list',
  'sessions.subagents.get',
  'sessions.subagents.watch',
  'execution.run.list',
  'execution.run.get',
  'execution.run.stream.read',
  'execution.run.wait',
  'session.handoff.prepare_target_result.get',
  'session.handoff.status.get',
  'paths.list_recent',
  'machines.list',
  'servers.list',
  'review.engines.list',
  'agents.backends.list',
  'agents.models.list',
  'agents.config_options.list',
  'agents.session_modes.list',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  'session.list',
  'session.activity.get',
  'session.messages.recent.get',
  'memory.search',
  'memory.get_window',
  'memory.ensure_up_to_date',
  'daemon.promptAssets.discover',
  'daemon.promptRegistry.scanSource',
  'daemon.filesystem.readFile',
  'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree',
  'daemon.filesystem.listRoots',
  'daemon.filesystem.browseDirectory',
  'bugreport.collectDiagnostics',
  'bugreport.getLogTail',
  'approval.request.list',
  'approval.request.get',
  'plugins.permissions.grants.list',
  'plugins.list',
  'plugins.change.status',
  'plugins.settings.list',
  'plugins.settings.get',
  'plugins.settings.secret.status',
  'plugin.webhook.endpoint.read',
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugins.sessionHooks.status.get',
  'session.log.tail',
  'transcript.page',
  'transcript.readAfter',
  'transcript.follow',
  'transcript.search',
  'ui.current_context.read',
  'ui.current_context.command.invoke',
  'sessions.external.candidates.list',
  'sessions.external.operation.status.get',
  'sessions.external.status.get',
  'sessions.external.transcript.page',
  'sessions.external.transcript.readAfter',
  'sessions.spawn.profiles.list',
  'sessions.spawn.connected_services.list',
  'sessions.spawn.mcp_servers.preview',
  'scm.pullRequest.list',
  'scm.pullRequest.get',
  'scm.pullRequest.openCompose',
  'scm.hostingRepository.describePublishTargets',
  'scm.diffSummary.generate',
  ...RUNTIME_ACTION_IDS,
] as const;

const RESULT_NONE_DEFERRED_ACTION_IDS = [
  'session.stop',
  'session.title.set',
  'session.permission_mode.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.goal.set',
  'session.goal.clear',
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
  'transcript.unfollow',
  'ui.voice_global.reset',
  'ui.pet.choose',
  'prompt_doc.update',
  'prompt_bundle.update',
  'prompt_asset.export',
  'prompt_registry.install',
  'approval.request.create',
  'approval.request.decide',
  'plugins.permissions.grants.request',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.revoke',
  'plugins.permissions.grants.dismissRequest',
  'plugin.webhook.endpoint.ensure',
  'plugin.webhook.endpoint.revoke',
  'plugin.webhook.endpoint.retarget',
  'plugin.webhook.delivery.movePending',
  'plugin.webhook.endpoint.credential.configure',
  'plugin.webhook.endpoint.credential.rotate',
  'plugin.webhook.endpoint.credential.finishRotation',
  'plugins.settings.set',
  'plugins.settings.reset',
  'plugins.settings.secret.bind',
  'plugins.settings.secret.unbind',
  'plugins.settings.secret.delete',
  'automation.event.sources.list',
  'automation.event.admit',
  'automation.event.source.status.report',
  'automation.conversation.targets.list',
  'automation.conversation.target.verify',
  'automation.conversation.admit',
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
  'reviews.comments.create',
  'reviews.comments.list',
  'reviews.comments.get',
  'reviews.comments.transition',
  'reviews.comments.edit',
  'reviews.comments.reply',
  'reviews.comments.redact',
  'reviews.comments.setDisposition',
  'reviews.comments.attachEvidence',
  'reviews.comments.bulkTransition',
] as const;

const RESULT_OPTIONAL_DEFERRED_ACTION_IDS = [
  'review.start',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'sessions.subagents.upsert',
  'sessions.subagents.updateStatus',
  'sessions.subagents.complete',
  'execution.run.start',
  'execution.run.send',
  'execution.run.ensure',
  'execution.run.ensure_or_start',
  'execution.run.stream.start',
  'execution.run.stream.cancel',
  'execution.run.stop',
  'execution.run.action',
  'session.open',
  'session.fork',
  'session.continue_with_replay',
  'session.rollback',
  'session.checkpoint_code_rollback',
  'session.checkpoint',
  'session.restore',
  'session.handoff',
  'session.handoff.prepare_target',
  'session.handoff.prepare_target.resume',
  'session.handoff.commit',
  'session.handoff.abort',
  'session.spawn_new',
  'session.message.send',
  'session.permission.respond',
  'session.user_action.answer',
  'session.mode.set',
  'session.target.primary.set',
  'session.target.tracked.set',
  'ui.voice_agent.teleport',
  'daemon.promptAssets.delete',
  'daemon.promptRegistry.install',
  'daemon.filesystem.writeFile',
  'bugreport.uploadArtifact',
  'transcript.import',
  'sessions.external.link.ensure',
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.backgroundFollow.set',
  'sessions.external.takeover',
  'sessions.external.materialize.start',
  'sessions.external.takeover.start',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'scm.pullRequest.openOrReuse',
  'scm.pullRequest.checkout',
  'scm.pullRequest.prepareWorktree',
  'scm.pullRequest.runStacked',
  'scm.repository.clone',
  'scm.repository.init',
  'scm.repository.removeIndexLock',
  'scm.hostingRepository.publish',
  'plugins.scaffold',
  'plugins.install',
  'plugins.uninstall',
  'plugins.dev',
  'plugins.author.install',
  'plugins.author.typecheck',
  'plugins.author.build',
  'plugins.author.test',
  'plugins.doctor',
  'plugins.pack',
  'plugins.reload',
  'plugins.sessionHooks.install',
  'plugins.sessionHooks.disable',
  'plugins.sessionHooks.enable',
  'plugins.sessionHooks.uninstall',
] as const;

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function resolveExpectedApprovalFlow(approval: { flow?: 'blocking' | 'deferred'; result: 'required' | 'optional' | 'none' }): 'blocking' | 'deferred' {
  if (approval.flow) return approval.flow;
  return approval.result === 'required' ? 'blocking' : 'deferred';
}

describe('Action Spec Registry', () => {
  it('registers plugin dev-loop actions on agent, cli, and mcp surfaces', () => {
    const expectations = [
      ['plugins.scaffold', 'danger'],
      ['plugins.install', 'danger'],
      ['plugins.uninstall', 'danger'],
      ['plugins.dev', 'danger'],
      ['plugins.author.install', 'danger'],
      ['plugins.author.typecheck', 'danger'],
      ['plugins.author.build', 'danger'],
      ['plugins.author.test', 'danger'],
      ['plugins.doctor', 'danger'],
      ['plugins.pack', 'danger'],
      ['plugins.reload', 'danger'],
      ['plugins.list', 'safe'],
      ['plugins.change.status', 'safe'],
    ] as const;

    for (const [actionId, safety] of expectations) {
      const spec = getActionSpec(actionId as ActionId);
      expect(spec.safety).toBe(safety);
      expect(spec.surfaces.agent).toBe(true);
      expect((spec.surfaces as Record<string, unknown>).session_agent).toBeUndefined();
      expect(spec.surfaces.cli).toBe(true);
      expect(spec.surfaces.mcp).toBe(true);
      expect(spec.bindings?.mcpToolName).toBe(actionId.replaceAll('.', '_'));
      expect(spec.outputSchema).toBeDefined();
    }

    expect(expectations.map(([actionId]) => actionId)).toEqual(PLUGIN_DEV_LOOP_ACTION_IDS_V1);
  });

  it('projects daemon-issued plugin reviews through one typed pending-review envelope', () => {
    const schema = getActionSpec('plugins.dev').outputSchema;

    expect(schema?.safeParse({
      ok: false,
      kind: 'plugins_dev',
      outcome: 'reviewRequired',
      pendingReview: {
        kind: 'sourceRootReviewRequired',
        pendingChangeId: 'pending-plugin-change',
        review: { sourceRootPath: '/plugins/acme' },
      },
    }).success).toBe(true);
    expect(schema?.safeParse({
      ok: false,
      kind: 'plugins_install',
      outcome: 'reviewRequired',
      pendingReview: {
        kind: 'reviewRequired',
        pendingChangeId: 'pending-plugin-change',
        review: { pluginId: 'acme.plugin' },
      },
    }).success).toBe(true);

    expect(schema?.safeParse({
      ok: false,
      kind: 'plugins_dev',
      outcome: 'reviewRequired',
      pendingChangeId: 'pending-plugin-change',
      review: { sourceRootPath: '/plugins/acme' },
    }).success).toBe(false);
    expect(schema?.safeParse({
      ok: false,
      kind: 'plugins_dev',
      outcome: 'reviewRequired',
    }).success).toBe(false);
    expect(schema?.safeParse({
      ok: false,
      kind: 'plugins_reload',
      outcome: 'reviewRequired',
      pendingReview: {
        kind: 'pending',
        pendingChangeId: 'pending-plugin-change',
        review: {},
      },
    }).success).toBe(false);
    expect(schema?.safeParse({
      ok: true,
      kind: 'plugins_unknown',
    }).success).toBe(false);

    expect(serializeActionSpec(getActionSpec('plugins.dev')).outputSchema).toMatchObject({
      anyOf: expect.any(Array),
    });

    expect(getActionSpec('plugins.change.status').outputSchema?.safeParse({
      ok: true,
      kind: 'plugins_change_status',
      status: { kind: 'daemonUnavailable' },
    }).success).toBe(true);
  });

  it('does not advertise Settings administration on the UI surface without a UI executor', () => {
    for (const actionId of [
      'plugins.settings.list',
      'plugins.settings.get',
      'plugins.settings.set',
      'plugins.settings.reset',
      'plugins.settings.secret.status',
      'plugins.settings.secret.bind',
      'plugins.settings.secret.unbind',
      'plugins.settings.secret.delete',
    ] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.ui).toBe(false);
      expect(spec.surfaces.cli).toBe(true);
    }
  });

  it('keeps package trust approval public but present-user-gated', () => {
    for (const retiredActionId of ['plugins.call', 'plugins.trust']) {
      expect(ActionIdSchema.safeParse(retiredActionId).success).toBe(false);
      expect(() => getActionSpec(retiredActionId as ActionId)).toThrow();
    }

    const install = getActionSpec('plugins.install');
    expect(install.approval.result).toBe('optional');
    expect(resolveExpectedApprovalFlow(install.approval)).toBe('deferred');
    expect(install.surfaces.rpc).toBe(false);
    expect(install.surfaces.api).toBe(true);
    expect(install.surfaces.plugin).toBe(true);
    expect(install.requiredAuthority).toBe('present_user');

    for (const actionId of [
      'plugins.permissions.grants.request',
      'plugins.permissions.grants.grant',
      'plugins.permissions.grants.revoke',
      'plugins.permissions.grants.dismissRequest',
    ] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.agent).toBe(false);
      expect(spec.surfaces.mcp).toBe(false);
    }
  });

  it('surfaces plugin inspect actions to UI without exposing scaffold/install', () => {
    expect(getActionSpec('plugins.list').surfaces.ui).toBe(true);
    expect(getActionSpec('plugins.reload').surfaces.ui).toBe(true);
    expect(getActionSpec('plugins.scaffold').surfaces.ui).toBe(false);
    expect(getActionSpec('plugins.install').surfaces.ui).toBe(false);
    expect(getActionSpec('plugins.uninstall').surfaces.ui).toBe(false);
  });

  it('requires a plugin id for plugin uninstall', () => {
    const schema = getActionSpec('plugins.uninstall').inputSchema;

    expect(schema.safeParse({ pluginId: 'acme.dev-loop' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('supports broad final action surfaces and rejects implementation-specific surface keys', () => {
    const parsed = ActionSurfaceSchema.parse({
      ui: false,
      voice: false,
      mcp: false,
      cli: false,
      agent: true,
      rpc: false,
      api: true,
      plugin: true,
    });

    expect(parsed.agent).toBe(true);
    expect(parsed.api).toBe(true);
    expect(parsed.plugin).toBe(true);
    expect(() => ActionSurfaceSchema.parse({
      [`ui_${'button'}`]: true,
      agent: true,
      mcp: false,
      cli: false,
    })).toThrow();
    expect(() => ActionSurfaceSchema.parse({
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      api: true,
      plugin: false,
      // Retired R7 spelling must stay rejected; no compatibility alias.
      session_agent: true,
    })).toThrow();
    expect(() => ActionSurfaceSchema.parse({
      agent: true,
      mcp: false,
      cli: false,
    })).toThrow();
  });

  it('validates ActionSpec tool exposure metadata only for supported tool surfaces', () => {
    const base = {
      id: 'review.start',
      title: 'Start review',
      safety: 'safe',
      approval: { result: 'optional', flow: 'deferred' },
      placements: [],
      surfaces: {
        ui: true,
        voice: true,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
        api: false,
        plugin: false,
      },
      bindings: { mcpToolName: 'review_start' },
      outputSchema: z.unknown(),
      inputSchema: z.object({}).strict(),
    } as const;

    expect(ActionSpecSchema.parse({
      ...base,
      toolExposure: {
        agent: 'discoverable_only',
        mcp: 'direct',
        cli: 'direct',
      },
    }).toolExposure).toEqual({
      agent: 'discoverable_only',
      mcp: 'direct',
      cli: 'direct',
    });

    expect(ActionSpecSchema.safeParse({
      ...base,
      toolExposure: {
        agent: 'hidden',
      },
    }).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...base,
      toolExposure: {
        voice: 'direct',
      },
    }).success).toBe(false);
  });

  it('fails closed when a plugin-visible ActionSpec has no representable output schema', () => {
    const base = {
      id: 'review.start',
      title: 'Start review',
      safety: 'safe',
      approval: { result: 'optional', flow: 'deferred' },
      placements: [],
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: false,
        plugin: true,
      },
      inputSchema: z.object({}).strict(),
    } as const;

    expect(ActionSpecSchema.safeParse(base).success).toBe(false);
    expect(ActionSpecSchema.safeParse({ ...base, outputSchema: z.unknown() }).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...base,
      outputSchema: z.object({ ok: z.boolean() }).strict(),
    }).success).toBe(true);
  });

  it('requires an explicit host-stamped caller policy for every non-safe Plugin Action', () => {
    const base = {
      id: 'review.start',
      title: 'Start review',
      safety: 'danger',
      approval: { result: 'optional', flow: 'deferred' },
      placements: [],
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: false,
        plugin: true,
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.boolean() }).strict(),
    } as const;

    expect(ActionSpecSchema.safeParse(base).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...base,
      pluginCallerPolicy: { kind: 'caller' },
    }).success).toBe(true);
  });

  it('rejects an ad-hoc exact-plugin grant and admits only the declared reload administration shape', () => {
    const base = {
      id: 'review.start',
      title: 'Start review',
      safety: 'safe',
      approval: { result: 'none' },
      placements: [],
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: false,
        plugin: true,
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.boolean() }).strict(),
    } as const;

    expect(ActionSpecSchema.safeParse({
      ...base,
      pluginCallerPolicy: { kind: 'caller' },
    }).success).toBe(true);
    expect(ActionSpecSchema.safeParse({
      ...base,
      pluginCallerPolicy: { kind: 'exact_plugin', pluginId: 'happier.channels' },
    }).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...base,
      pluginCallerPolicy: {
        kind: 'self_or_inspector_admin',
        targetPluginIdField: 'pluginId',
        administrativeCallers: [{ pluginId: 'happier.inspector', contributionLocalId: 'inspector-app' }],
      },
    }).success).toBe(true);
    // The administrative surface is exact: a bare plugin id with no contribution
    // surface, and an empty administrator list, are both refused.
    expect(ActionSpecSchema.safeParse({
      ...base,
      pluginCallerPolicy: {
        kind: 'self_or_inspector_admin',
        targetPluginIdField: 'pluginId',
        administrativeCallers: [{ pluginId: 'happier.inspector' }],
      },
    }).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...base,
      pluginCallerPolicy: {
        kind: 'self_or_inspector_admin',
        targetPluginIdField: 'pluginId',
        administrativeCallers: [],
      },
    }).success).toBe(false);
    // Only the canonical target field may be named.
    expect(ActionSpecSchema.safeParse({
      ...base,
      pluginCallerPolicy: {
        kind: 'self_or_inspector_admin',
        targetPluginIdField: 'targetPluginId',
        administrativeCallers: [{ pluginId: 'happier.inspector', contributionLocalId: 'inspector-app' }],
      },
    }).success).toBe(false);
  });

  it('validates owner-local RPC, API, and plugin surface bindings without serializing a second action row', () => {
    const transform = (value: unknown) => value;
    const parsed = ActionSpecSchema.parse({
      id: 'review.start',
      title: 'Start review',
      safety: 'safe',
      approval: { result: 'optional', flow: 'deferred' },
      placements: [],
      bindings: { rpcMethod: 'review.start' },
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: true,
        api: true,
        plugin: true,
      },
      inputSchema: z.object({ semantic: z.string() }).strict(),
      outputSchema: z.object({ result: z.string() }).strict(),
      surfaceBindings: {
        rpc: {
          inputSchema: z.object({ carrier: z.string() }).strict(),
          decodeInput: transform,
          outputSchema: z.object({ carrierResult: z.string() }).strict(),
          encodeOutput: transform,
        },
        plugin: {
          inputSchema: z.object({ callerInput: z.string() }).strict(),
          bindInput: transform,
          projectOutput: transform,
        },
        api: {
          inputSchema: z.object({ callerInput: z.string() }).strict(),
          bindInput: transform,
        },
      },
    });

    expect(parsed.surfaceBindings?.rpc?.decodeInput).toBe(transform);
    expect(parsed.surfaceBindings?.api?.bindInput).toBe(transform);
    expect(parsed.surfaceBindings?.plugin?.projectOutput).toBe(transform);
  });

  it('exposes stable action specs', () => {
    const all = listActionSpecs();
    expect(all.length).toBeGreaterThan(0);
    for (const spec of all) {
      // Runtime safety: registry objects must validate against the schema.
      ActionSpecSchema.parse(spec);
    }
  });

  it('keeps concrete browser result contracts when public plugin exposure reaches runtime Actions', () => {
    const clear = getActionSpec('browser.diagnostics.clear').outputSchema;
    const pause = getActionSpec('browser.diagnostics.pause').outputSchema;
    const resume = getActionSpec('browser.diagnostics.resume').outputSchema;
    const recordingStatus = getActionSpec('browser.recording.status').outputSchema;
    const attachRecording = getActionSpec('browser.recording.attachToComposer').outputSchema;
    const cancelActiveInput = getActionSpec('browser.automation.cancelActive').inputSchema;
    const cancelActiveOutput = getActionSpec('browser.automation.cancelActive').outputSchema;

    expect(clear?.safeParse({ ok: true }).success).toBe(true);
    expect(clear?.safeParse({ ok: true, unexpected: true }).success).toBe(false);
    expect(pause?.safeParse({ ok: true, status: 'paused', viewId: 'view-1' }).success).toBe(true);
    expect(resume?.safeParse({ ok: true, status: 'resumed', viewId: 'view-1' }).success).toBe(true);
    expect(pause?.safeParse({ ok: true, status: 'resumed', viewId: 'view-1' }).success).toBe(false);
    expect(recordingStatus?.safeParse(null).success).toBe(true);
    expect(recordingStatus?.safeParse({}).success).toBe(false);
    expect(attachRecording?.safeParse({ ok: true, attachmentId: 'attachment-1' }).success).toBe(true);
    expect(attachRecording?.safeParse({ ok: true }).success).toBe(false);
    expect(cancelActiveInput?.safeParse({
      browserSessionId: 'browser-session-1',
      viewId: 'view-1',
    }).success).toBe(true);
    expect(cancelActiveInput?.safeParse({
      browserSessionId: 'browser-session-1',
      viewId: 'view-1',
      requesterRef: { kind: 'spoofed' },
    }).success).toBe(false);
    expect(getActionSpec('browser.automation.cancelActive').requiredAuthority).toBe('present_user');
    expect(cancelActiveOutput?.safeParse({
      v: 1,
      outcome: 'canceled',
      canceledCount: 1,
    }).success).toBe(true);
    expect(cancelActiveOutput?.safeParse({
      v: 1,
      outcome: 'owner_mismatch',
      canceledCount: 1,
    }).success).toBe(false);
  });

  it('binds every browser automation Action id to its one permitted actionKind', () => {
    const actionKinds = {
      'browser.automation.status': 'getStatus',
      'browser.automation.snapshot': 'snapshot',
      'browser.automation.semanticSnapshot': 'semanticSnapshot',
      'browser.automation.queryElements': 'queryElements',
      'browser.automation.waitFor': 'waitFor',
      'browser.automation.timeline.get': 'getActionTimeline',
      'browser.automation.navigate': 'navigate',
      'browser.automation.reload': 'reload',
      'browser.automation.goBack': 'goBack',
      'browser.automation.goForward': 'goForward',
      'browser.automation.click': 'click',
      'browser.automation.tap': 'tap',
      'browser.automation.type': 'type',
      'browser.automation.press': 'press',
      'browser.automation.scroll': 'scroll',
      'browser.automation.hover': 'hover',
      'browser.automation.focus': 'focus',
      'browser.automation.select': 'select',
      'browser.automation.setValue': 'setValue',
      'browser.automation.upload': 'upload',
      'browser.automation.drag': 'drag',
    } as const;

    for (const [actionId, actionKind] of Object.entries(actionKinds)) {
      const inputSchema = getActionSpec(actionId as ActionId).inputSchema;
      const mismatchedActionKind = actionKind === 'snapshot' ? 'click' : 'snapshot';
      const request = {
        v: 1,
        automationRequestId: 'automation-request-1',
        browserSessionId: 'browser-session-1',
        viewId: 'view-1',
        navigationGeneration: 1,
        requestedBy: 'agent',
        requesterRef: { kind: 'session', id: 'session-1' },
        timeoutMs: 1_000,
        leaseId: 'lease-1',
      };

      expect(inputSchema.safeParse({ ...request, actionKind }).success).toBe(true);
      expect(inputSchema.safeParse({ ...request, actionKind: mismatchedActionKind }).success).toBe(false);
    }
  });

  it('matches runtime surface availability to the actual backing census', () => {
    expect(resolveRuntimeActionSurfaces('localServices.inventory.list').agent).toBe(true);
    expect(resolveRuntimeActionSurfaces('localServices.inventory.refresh').agent).toBe(true);
    expect(resolveRuntimeActionSurfaces('browser.session.create').agent).toBe(false);
    expect(resolveRuntimeActionSurfaces('browser.session.close').agent).toBe(false);
  });

  it('projects strict Agent inventory rows for SDK Agent selection', () => {
    const schema = getActionSpec('agents.backends.list').outputSchema;
    const catalogAgent = {
      targetKey: 'backend:codex',
      label: 'Codex',
      enabled: true,
      agentId: 'codex',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    };

    expect(schema.safeParse({ items: [catalogAgent] }).success).toBe(true);
    expect(schema.safeParse({ items: [catalogAgent], unexpected: true }).success).toBe(false);
    expect(schema.safeParse({
      items: [{ ...catalogAgent, unexpected: true }],
    }).success).toBe(false);
    expect(schema.safeParse({
      items: [{
        targetKey: 'backend:review-bot',
        label: 'Review Bot',
        enabled: true,
        backendId: 'review-bot',
      }],
    }).success).toBe(true);
  });

  it('does not leak untyped runtime result carriers onto public Action surfaces', () => {
    const recordingList = getActionSpec('browser.recording.listForView').outputSchema;
    const launcherSnapshot = getActionSpec('localServices.launcher.snapshot').outputSchema;
    const previewStatus = getActionSpec('localServices.preview.status').outputSchema;
    const publicPreviewStatus = getActionSpec('localServices.publicPreview.status').outputSchema;
    const peerSnapshot = getActionSpec('peerMediation.observability.snapshot').outputSchema;

    for (const schema of [
      recordingList,
      launcherSnapshot,
      previewStatus,
      publicPreviewStatus,
      peerSnapshot,
    ]) {
      expect(schema?.safeParse({ opaqueRuntimeResult: true }).success).toBe(false);
    }
  });

  it('classifies every current ActionSpec explicitly for API and plugin invocation', () => {
    for (const spec of listActionSpecs()) {
      expect(Object.prototype.hasOwnProperty.call(spec.surfaces, 'api')).toBe(true);
      expect(typeof spec.surfaces.api).toBe('boolean');
      expect(spec.surfaces.api, spec.id).toBe(
        !isInternalActionId(spec.id) && !isPluginProvenanceOnlyActionId(spec.id),
      );
      expect(Object.prototype.hasOwnProperty.call(spec.surfaces, 'plugin')).toBe(true);
      expect(typeof spec.surfaces.plugin).toBe('boolean');
      expect(spec.surfaces.plugin, spec.id).toBe(
        !isInternalActionId(spec.id) && !isPluginSurfaceExcludedActionId(spec.id),
      );

      if (
        spec.requiredAuthority === 'present_user'
        && !isInternalActionId(spec.id)
        && !isPluginProvenanceOnlyActionId(spec.id)
        && !isPluginSurfaceExcludedActionId(spec.id)
      ) {
        expect(spec.surfaces.api, spec.id).toBe(true);
        expect(spec.surfaces.plugin, spec.id).toBe(true);
      }
    }

    for (const [actionId, requiredAuthority] of [
      ['account.apiTokens.create', 'present_user'],
      ['account.apiTokens.list', 'account_automation'],
      ['account.apiTokens.revoke', 'present_user'],
      ['account.apiTokens.revokeAll', 'present_user'],
    ] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.api).toBe(true);
      expect(spec.surfaces.plugin).toBe(true);
      expect(spec.requiredAuthority).toBe(requiredAuthority);
    }

    const invokeContributedAction = getActionSpec('action.invoke');
    expect(invokeContributedAction.surfaces.api).toBe(true);
    expect(invokeContributedAction.surfaces.plugin).toBe(true);
    expect(invokeContributedAction.requiredAuthority).toBe('account_automation');

    expect(getActionSpec('memory.search').surfaces.plugin).toBe(true);
    expect(getActionSpec('memory.get_window').surfaces.plugin).toBe(true);
    expect(getActionSpec('memory.ensure_up_to_date').surfaces.plugin).toBe(true);
    expect(getActionSpec('daemon.promptAssets.discover').surfaces.plugin).toBe(true);
    expect(getActionSpec('daemon.promptAssets.delete').surfaces.plugin).toBe(true);
    expect(getActionSpec('daemon.promptRegistry.scanSource').surfaces.plugin).toBe(true);
    expect(getActionSpec('daemon.promptRegistry.install').surfaces.plugin).toBe(true);
    expect(getActionSpec('sessions.external.materialize.start').surfaces.plugin).toBe(true);
    // CONTRACTS.md C1: the six-method `SessionsService.external` contextual
    // service is the author capability. Candidate discovery, link/attach,
    // transcript page/read-after and raw durable takeover Start stay off the
    // plugin projection: the Action executor serves them only for a host
    // caller, so publishing them would compile for authors and then fail.
    expect(
      listActionSpecs()
        .filter((spec) => spec.id.startsWith('sessions.external.') && spec.surfaces.plugin !== true)
        .map((spec) => spec.id)
        .sort(),
    ).toEqual([
      'sessions.external.candidates.list',
      'sessions.external.link.ensure',
      'sessions.external.takeover',
      'sessions.external.takeover.start',
      'sessions.external.transcript.page',
      'sessions.external.transcript.readAfter',
    ]);
    // Excluding them from the plugin projection never removes the host route
    // the current RPC/API clients already use.
    for (const spec of listActionSpecs()) {
      if (!spec.id.startsWith('sessions.external.') || spec.surfaces.plugin === true) continue;
      expect(spec.surfaces.rpc, spec.id).toBe(true);
      expect(spec.surfaces.api, spec.id).toBe(spec.id !== 'sessions.external.takeover');
    }
    for (const actionId of [
      'plugins.sessionHooks.status.get',
      'plugins.sessionHooks.install',
      'plugins.sessionHooks.disable',
      'plugins.sessionHooks.enable',
      'plugins.sessionHooks.uninstall',
    ] as const) {
      expect(getActionSpec(actionId).surfaces.plugin, actionId).toBe(true);
    }
    expect(getActionSpec('voice_agent.start').surfaces.plugin).toBe(true);
    for (const spec of listActionSpecs()) {
      if (spec.id.startsWith('approval.request.')) {
        expect(spec.surfaces.plugin, spec.id).toBe(true);
      }
    }
    expect(getActionSpec('session.permission.respond').surfaces.plugin).toBe(true);
    expect(getActionSpec('session.user_action.answer').surfaces.plugin).toBe(true);
  });

  it('gives remote permission mediation an Account-automation minimum so a host-stamped plugin caller can reach it', () => {
    // PERM-03/PERM-10: the mediator arm is plugin-only provenance, so a
    // present-user requirement here would make the whole vertical unreachable.
    for (const actionId of [
      'session.permission.remote.pending.list',
      'session.permission.remote.respond',
      'session.permission.remote.grants.list',
      'session.permission.remote.grants.revoke',
    ] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.requiredAuthority, actionId).toBe('account_automation');
      expect(spec.surfaces.plugin, actionId).toBe(true);
      expect(PluginInvocableActionIdSchema.safeParse(actionId).success, actionId).toBe(true);
    }

    // The mediator-private reads/writes stay off the PAT surface; the
    // owner-visible grant ledger operations remain ordinary Account API.
    expect(getActionSpec('session.permission.remote.pending.list').surfaces.api).toBe(false);
    expect(getActionSpec('session.permission.remote.respond').surfaces.api).toBe(false);
    expect(getActionSpec('session.permission.remote.grants.list').surfaces.api).toBe(true);
    expect(getActionSpec('session.permission.remote.grants.revoke').surfaces.api).toBe(true);
  });

  it('keeps permission approval discoverable while present-user authority gates execution', () => {
    const permission = getActionSpec('session.permission.respond');
    const userAction = getActionSpec('session.user_action.answer');
    const permissionInput = permission.surfaceBindings?.plugin?.inputSchema;
    const userActionInput = userAction.surfaceBindings?.plugin?.inputSchema;

    expect(permissionInput).toBeUndefined();
    expect(permission.surfaces).toMatchObject({
      ui: true,
      cli: true,
      rpc: true,
      agent: false,
      mcp: false,
      voice: false,
      api: true,
      plugin: true,
    });
    expect(permission.requiredAuthority).toBe('present_user');
    expect(PublicActionIdSchema.safeParse('session.permission.respond').success).toBe(true);
    expect(PUBLIC_ACTION_IDS).toContain('session.permission.respond');
    expect(PluginInvocableActionIdSchema.safeParse('session.permission.respond').success).toBe(true);
    expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain('session.permission.respond');
    expect(PLUGIN_ACTION_INPUT_SCHEMAS).toHaveProperty('session.permission.respond');

    expect(userActionInput?.parse({
      requestId: 'question-1',
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    })).toEqual({
      requestId: 'question-1',
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });
    expect(userActionInput?.safeParse({
      requestId: 'question-1',
      decision: 'approve',
      updatedPermissions: {},
    }).success).toBe(false);
    expect(permission.outputSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(permission.outputSchema.safeParse({ ok: true, sessionId: 'private' }).success).toBe(false);
    expect(userAction.outputSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('exposes the remote permission mediation Actions only through their canonical caller surfaces', () => {
    const pending = getActionSpec('session.permission.remote.pending.list' as any);
    const respond = getActionSpec('session.permission.remote.respond' as any);
    const grantsList = getActionSpec('session.permission.remote.grants.list' as any);
    const grantsRevoke = getActionSpec('session.permission.remote.grants.revoke' as any);

    expect(pending.surfaces).toMatchObject({
      plugin: true,
      ui: false,
      cli: false,
      rpc: false,
      agent: false,
      mcp: false,
      voice: false,
    });
    expect(respond.surfaces).toMatchObject({
      plugin: true,
      ui: false,
      cli: false,
      rpc: false,
      agent: false,
      mcp: false,
      voice: false,
    });
    expect(grantsList.surfaces).toMatchObject({ plugin: true, ui: true, cli: true, rpc: true, agent: false, mcp: false, voice: false });
    expect(grantsRevoke.surfaces).toMatchObject({ plugin: true, ui: true, cli: true, rpc: true, agent: false, mcp: false, voice: false });

    expect(respond.inputSchema.safeParse({
      sessionId: 'session-1',
      requestId: 'request-1',
      sourceRef: 'binding-1',
      sourceRevisionOrEpoch: 'rev-1',
      idempotencyKey: 'retry-1',
      actor: { namespace: 'discord', principalId: 'user-1' },
      decision: 'allow',
      scope: 'request',
      mediatorPluginId: 'forged',
    }).success).toBe(false);
  });

  it('generates runtime plugin ids and schema maps from the canonical registry rows', () => {
    const expected = listActionSpecsForSurface('plugin').map((spec) => spec.id).sort();
    expect([...PLUGIN_INVOCABLE_ACTION_IDS].sort()).toEqual(expected);
    expect(Object.keys(PLUGIN_ACTION_INPUT_SCHEMAS).sort()).toEqual(expected);
    expect(Object.keys(PLUGIN_ACTION_OUTPUT_SCHEMAS).sort()).toEqual(expected);
    for (const actionId of PLUGIN_INVOCABLE_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      expect(PLUGIN_ACTION_INPUT_SCHEMAS[actionId]).toBe(
        spec.surfaceBindings?.plugin?.inputSchema ?? spec.inputSchema,
      );
      const pluginOutputSchema = Reflect.get(
        spec.surfaceBindings?.plugin ?? {},
        'outputSchema',
      );
      expect(PLUGIN_ACTION_OUTPUT_SCHEMAS[actionId]).toBe(
        pluginOutputSchema ?? spec.outputSchema,
      );
    }

    const runStartInput = {
      intent: 'voice_agent',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      connectedServices: 'openai-codex:native',
    };
    expect(PLUGIN_ACTION_INPUT_SCHEMAS['execution.run.start'].safeParse(runStartInput).success).toBe(true);
    expect(PLUGIN_ACTION_INPUT_SCHEMAS['execution.run.start'].safeParse({
      ...runStartInput,
      intent: undefined,
    }).success).toBe(false);

    const installSchema = PLUGIN_ACTION_INPUT_SCHEMAS['plugins.sessionHooks.install'];
    expect(installSchema.safeParse({
      agent: { localId: 'codex' },
      expectedPreviewId: `hook-install-preview:v1:${'a'.repeat(64)}`,
    }).success).toBe(true);
    expect(installSchema.safeParse({
      machineId: 'caller-controlled-machine',
      agent: { localId: 'codex' },
      expectedPreviewId: `hook-install-preview:v1:${'a'.repeat(64)}`,
    }).success).toBe(false);
    expect(installSchema.safeParse({
      agent: { pluginId: 'spoofed-plugin', localId: 'codex' },
      expectedPreviewId: `hook-install-preview:v1:${'a'.repeat(64)}`,
    }).success).toBe(false);
    expect(PLUGIN_ACTION_INPUT_SCHEMAS['execution.run.start'].safeParse({
      ...runStartInput,
      profileId: 'profile-1',
    }).success).toBe(false);
    expect(PLUGIN_ACTION_INPUT_SCHEMAS['session.usageLimit.checkNow'].parse({
      sessionId: 'session-1',
      provider: 'codex',
    })).toMatchObject({ sessionId: 'session-1', agentId: 'codex' });
    expect(PluginInvocableActionIdSchema.safeParse('sessions.subagents.list').success).toBe(true);
    expect(PluginInvocableActionIdSchema.safeParse('voice_agent.start').success).toBe(true);
  });

  it('projects public subagent registry reads to Plugin while retaining lifecycle maintenance host-internal', () => {
    const rawSubagentActionIds = [
      'sessions.subagents.list',
      'sessions.subagents.get',
      'sessions.subagents.watch',
      'sessions.subagents.upsert',
      'sessions.subagents.updateStatus',
      'sessions.subagents.complete',
    ] as const;
    const publicSubagentActionIds = new Set([
      'sessions.subagents.list',
      'sessions.subagents.get',
      'sessions.subagents.watch',
    ]);

    for (const actionId of rawSubagentActionIds) {
      const spec = getActionSpec(actionId);
      const publicProjection = publicSubagentActionIds.has(actionId);
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.surfaces.plugin).toBe(publicProjection);
      expect(PluginInvocableActionIdSchema.safeParse(actionId).success).toBe(publicProjection);
      expect(Object.hasOwn(PLUGIN_ACTION_INPUT_SCHEMAS, actionId)).toBe(publicProjection);
      expect(Object.hasOwn(PLUGIN_ACTION_OUTPUT_SCHEMAS, actionId)).toBe(publicProjection);
    }
  });

  it('keeps SDK-required discovery, run, path, and transcript Actions public in the canonical projection', () => {
    const sdkRequiredActionIds = [
      'action.spec.search',
      'action.spec.get',
      'action.options.resolve',
      'execution.run.wait',
      'paths.list_recent',
      'session.status.get',
      'session.transcript.get',
      'session.log.tail',
      'transcript.page',
      'transcript.readAfter',
      'transcript.follow',
      'transcript.unfollow',
      'transcript.search',
    ] as const;

    for (const actionId of sdkRequiredActionIds) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.api, actionId).toBe(true);
      expect(spec.surfaces.plugin, actionId).toBe(true);
      expect(PUBLIC_ACTION_IDS, actionId).toContain(actionId);
      expect(PublicActionIdSchema.safeParse(actionId).success, actionId).toBe(true);
      expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, actionId), actionId).toBe(true);
      expect(Object.hasOwn(PUBLIC_ACTION_OUTPUT_SCHEMAS, actionId), actionId).toBe(true);
    }
  });

  it('classifies every non-safe Plugin Action and reserves plugin-targeted administration for reload', () => {
    const nonSafePluginActions = listActionSpecsForSurface('plugin').filter(
      (spec) => spec.safety !== 'safe',
    );

    const callerPolicyActions = nonSafePluginActions.filter(
      (spec) => spec.pluginCallerPolicy?.kind === 'caller',
    );
    const pluginTargetedAdministrationActions = nonSafePluginActions.filter(
      (spec) => spec.pluginCallerPolicy?.kind === 'self_or_inspector_admin',
    );
    expect(pluginTargetedAdministrationActions.map((spec) => spec.id)).toEqual(['plugins.reload']);
    expect(callerPolicyActions).toHaveLength(
      nonSafePluginActions.length - pluginTargetedAdministrationActions.length,
    );
    expect(nonSafePluginActions.filter(
      (spec) => spec.pluginCallerPolicy === undefined,
    )).toHaveLength(0);
  });

  it('keeps Plugin Session input and transcript access at their canonical closed schemas', () => {
    const pluginMessageInput = PLUGIN_ACTION_INPUT_SCHEMAS['session.message.send'];
    expect(pluginMessageInput.safeParse({
      sessionId: 'session-1',
      message: 'Forward this',
      idempotencyKey: 'message-42',
      source: {
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
      },
    }).success).toBe(true);
    expect(pluginMessageInput.safeParse({
      sessionId: 'session-1',
      message: 'Forward this',
      idempotencyKey: 'message-42',
      permissionModeOverride: 'yolo',
    }).success).toBe(false);

    const pluginTranscriptInput = PLUGIN_ACTION_INPUT_SCHEMAS['session.transcript.get'];
    expect(pluginTranscriptInput.safeParse({
      sessionId: 'session-1',
      projection: 'externalShareableV1',
      cursor: '7',
      limit: 20,
    }).success).toBe(true);
    expect(pluginTranscriptInput.safeParse({
      sessionId: 'session-1',
      includeRaw: true,
    }).success).toBe(false);

    const pluginTranscriptOutput = PLUGIN_ACTION_OUTPUT_SCHEMAS['session.transcript.get'];
    expect(pluginTranscriptOutput.safeParse({
      ok: true,
      sessionId: 'session-1',
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: {
        rawRowsScanned: 0,
        pagesFetched: 0,
        scanLimitReached: false,
        payloadTruncations: 0,
      },
    }).success).toBe(false);

    for (const actionId of [
      'session.permission_mode.set',
      'session.history.get',
      'session.events.get',
      'session.messages.recent.get',
    ]) {
      expect(getActionSpec(actionId as ActionId).surfaces.plugin).toBe(true);
      expect(PluginInvocableActionIdSchema.safeParse(actionId).success).toBe(true);
    }
  });

  it('keeps plugin External Session action inputs and results public-safe and strict', async () => {
    const status = getActionSpec('sessions.external.status.get');
    expect(status.inputSchema.parse({ sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    });
    expect(status.inputSchema.safeParse({
      sessionId: 'session-1',
      machineId: 'private-machine',
    }).success).toBe(false);
    expect(status.outputSchema?.safeParse({
      ok: true,
      machineOnline: true,
      runnerActive: false,
      activity: 'idle',
      canTakeOverDirect: false,
      canTakeOverPersist: true,
      canForceStop: false,
      trustedPid: 42,
    }).success).toBe(false);

    expect(getActionSpec('sessions.external.follow').inputSchema.parse({
      sessionId: 'session-1',
      ttlMs: 1_000,
    })).toEqual({ sessionId: 'session-1', ttlMs: 1_000 });
    expect(getActionSpec('sessions.external.follow').inputSchema.safeParse({
      sessionId: 'session-1',
      acceptedTailCursor: ' happier_external_cursor_v1:Y3Vyc29y ',
    }).success).toBe(false);
    expect(getActionSpec('sessions.external.unfollow').inputSchema.safeParse({
      sessionId: 'session-1',
      leaseId: 'lease-1',
      source: { kind: 'private' },
    }).success).toBe(false);
    expect(getActionSpec('sessions.external.backgroundFollow.set').inputSchema.parse({
      sessionId: 'session-1',
      enabled: true,
    })).toEqual({ sessionId: 'session-1', enabled: true });

    for (const actionId of [
      'sessions.external.status.get',
      'sessions.external.unfollow',
      'sessions.external.backgroundFollow.set',
    ] as const) {
      const spec = getActionSpec(actionId);
      const projectedFailure = await spec.surfaceBindings?.plugin?.projectOutput?.({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
        retryable: true,
        providerMessage: 'private provider detail',
      }, {
        actionId,
        surface: 'plugin',
        caller: { kind: 'plugin', pluginId: 'fixture' },
      });

      expect(projectedFailure, actionId).toEqual({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
      });
      expect(await spec.surfaceBindings?.plugin?.projectOutput?.({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      }, {
        actionId,
        surface: 'plugin',
        caller: { kind: 'plugin', pluginId: 'fixture' },
      }), actionId).toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      });
      expect(spec.outputSchema?.safeParse({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
      }).success, actionId).toBe(true);
      expect(spec.outputSchema?.safeParse({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
        retryable: true,
      }).success, actionId).toBe(false);
      expect(spec.outputSchema?.safeParse({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
        providerMessage: 'private provider detail',
      }).success, actionId).toBe(false);
    }

    // A follow lease is the one External Session result a caller re-requests on
    // a timer, so its terminal classification is part of the public contract:
    // the daemon's authored boolean survives the projection while the daemon's
    // own message never does.
    const follow = getActionSpec('sessions.external.follow');
    expect(await follow.surfaceBindings?.plugin?.projectOutput?.({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_follow_unavailable',
      retryable: false,
      providerMessage: 'private provider detail',
    }, {
      actionId: follow.id,
      surface: 'plugin',
      caller: { kind: 'plugin', pluginId: 'fixture' },
    })).toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_follow_unavailable',
      retryable: false,
    });
    // A released daemon omits the field; the projection must not invent one.
    expect(await follow.surfaceBindings?.plugin?.projectOutput?.({
      ok: false,
      errorCode: 'machine_offline',
      error: 'machine_offline',
    }, {
      actionId: follow.id,
      surface: 'plugin',
      caller: { kind: 'plugin', pluginId: 'fixture' },
    })).toEqual({
      ok: false,
      errorCode: 'machine_offline',
      error: 'machine_offline',
    });
    expect(follow.outputSchema?.safeParse({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'agent_unavailable',
      retryable: true,
    }).success).toBe(true);
    expect(follow.outputSchema?.safeParse({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'agent_unavailable',
      retryable: 'no',
    }).success).toBe(false);
    expect(follow.outputSchema?.safeParse({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'agent_unavailable',
      providerMessage: 'private provider detail',
    }).success).toBe(false);

    const operation = getActionSpec('sessions.external.operation.status.get');
    const operationRef = {
      sessionId: 'session-1',
      operationId: 'operation-1',
      revision: 3,
    };
    expect(operation.inputSchema.parse(operationRef)).toEqual(operationRef);
    expect(operation.inputSchema.safeParse({
      ...operationRef,
      sessionId: ' session-1 ',
    }).success).toBe(false);
    expect(operation.inputSchema.safeParse({
      ...operationRef,
      operationId: ' operation-1 ',
    }).success).toBe(false);
    expect(operation.surfaceBindings?.rpc?.inputSchema.safeParse({
      ...operationRef,
      sessionId: ' session-1 ',
      operationId: ' operation-1 ',
    }).success).toBe(false);
    expect(operation.surfaceBindings?.rpc?.inputSchema.parse(operationRef)).toEqual(operationRef);

    const materialize = getActionSpec('sessions.external.materialize.start');
    const materializeRequest = {
      request: {
        v: 1,
        idempotencyKey: 'materialize-1',
        sessionId: 'session-1',
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    };
    expect(materialize.inputSchema.parse(materializeRequest)).toEqual(materializeRequest);
    expect(materialize.inputSchema.safeParse({
      request: {
        ...materializeRequest.request,
        idempotencyKey: ' materialize-1 ',
      },
    }).success).toBe(false);
    expect(materialize.inputSchema.safeParse({
      request: {
        ...materializeRequest.request,
        idempotencyKey: 'x'.repeat(256),
      },
    }).success).toBe(true);
    expect(materialize.inputSchema.safeParse({
      request: {
        ...materializeRequest.request,
        idempotencyKey: 'x'.repeat(257),
      },
    }).success).toBe(false);
    expect(materialize.surfaceBindings?.rpc?.inputSchema.parse({
      request: {
        ...materializeRequest.request,
        idempotencyKey: ' materialize-1 ',
      },
    })).toEqual(materializeRequest);
    const publicResult = {
      ok: true,
      operation: operationRef,
      presentation: {
        v: 1,
        operationId: 'operation-1',
        revision: 3,
        kind: 'materialize',
        status: 'running',
        phase: 'validating',
      },
    };
    expect(operation.outputSchema?.parse(publicResult)).toEqual(publicResult);
    expect(operation.outputSchema?.safeParse({
      ...publicResult,
      progress: { private: true },
    }).success).toBe(false);

    const privateResponse = {
      ok: true,
      progress: {
        v: 1,
        operationId: 'operation-1',
        revision: 3,
        request: {
          plan: 'materialize',
          targetStorageMode: 'external-linked',
          targetRuntimeMode: null,
        },
        timeline: ['validating', 'staging', 'importing', 'publishing'],
        status: 'running',
        phase: 'validating',
        updatedAtMs: 10,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: 'machine_only',
        checkpoint: {
          sourcePagesRead: 1,
          stagedItemCount: 2,
          importedItemCount: 1,
          requiredItemFailures: {
            total: 0,
            record: 0,
            media: 0,
            conversion: 0,
            diagnosticsTruncated: false,
          },
        },
        fence: { kind: 'none' },
      },
    };
    const projected = await operation.surfaceBindings?.plugin?.projectOutput?.(privateResponse, {
      actionId: 'sessions.external.operation.status.get',
      surface: 'plugin',
      caller: { kind: 'plugin', pluginId: 'fixture' },
      input: operationRef,
    });
    expect(projected).toEqual(publicResult);
    expect(await operation.surfaceBindings?.plugin?.projectOutput?.(publicResult, {
      actionId: 'sessions.external.operation.status.get',
      surface: 'plugin',
      caller: { kind: 'plugin', pluginId: 'fixture' },
      input: operationRef,
    })).toEqual(publicResult);
    expect(() => operation.surfaceBindings?.plugin?.projectOutput?.({
      ...publicResult,
      operation: { ...publicResult.operation, sessionId: 'session-other' },
    }, {
      actionId: 'sessions.external.operation.status.get',
      surface: 'plugin',
      caller: { kind: 'plugin', pluginId: 'fixture' },
      input: operationRef,
    })).toThrow('external_session_operation_session_mismatch');
    expect(operation.surfaceBindings?.rpc?.outputSchema.parse(privateResponse))
      .toEqual(privateResponse);
    expect(await operation.surfaceBindings?.rpc?.encodeOutput(privateResponse, {
      actionId: 'sessions.external.operation.status.get',
      surface: 'rpc',
      caller: { kind: 'host' },
      input: operationRef,
    })).toEqual(privateResponse);
  });

  it('keeps deciding grant operations present-user-gated while preserving plugin self-revocation', () => {
    expect(getActionSpec('plugins.permissions.grants.list').surfaces.plugin).toBe(true);
    expect(getActionSpec('plugins.permissions.grants.request').surfaces.plugin).toBe(true);
    expect(getActionSpec('plugins.permissions.grants.revoke').surfaces.plugin).toBe(true);
    expect(getActionSpec('plugins.permissions.grants.grant').surfaces.plugin).toBe(true);
    expect(getActionSpec('plugins.permissions.grants.dismissRequest').surfaces.plugin).toBe(true);
    for (const actionId of [
      'plugins.permissions.grants.grant',
      'plugins.permissions.grants.dismissRequest',
    ] as const) {
      expect(getActionSpec(actionId).requiredAuthority).toBe('present_user');
    }
    const revoke = getActionSpec('plugins.permissions.grants.revoke');
    expect(revoke.requiredAuthority).toBe('account_automation');
    expect(revoke.surfaces.api).toBe(false);
    expect(isPluginProvenanceOnlyActionId(revoke.id)).toBe(true);
    expect(PLUGIN_ACTION_INPUT_SCHEMAS['plugins.permissions.grants.list'].safeParse({
      grantId: 'grant-host-private-exact-lookup',
    }).success).toBe(false);
  });

  it('binds credential permission subjects to the host-stamped plugin identity', async () => {
    const spec = getActionSpec('plugins.permissions.grants.request');
    const input = {
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject: {
        kind: 'credential_access_disclosure',
        contribution: { localId: 'voice-provider' },
        credentialSlotId: 'voice-api-key',
        purpose: 'voice.conversation',
        accessDeclarationDigest: 'a'.repeat(64),
        selectedAuthorityDigest: 'c'.repeat(64),
        selectedRawAccessDigest: 'd'.repeat(64),
        installedGenerationId: 'generation-1',
        installReviewPrincipalDigest: 'b'.repeat(64),
      },
      reason: 'Use the declared voice credential',
    };
    const parsed = spec.surfaceBindings?.plugin?.inputSchema?.parse(input);
    const bound = await spec.surfaceBindings?.plugin?.bindInput?.(parsed, {
      actionId: spec.id,
      surface: 'plugin',
      caller: { kind: 'plugin', pluginId: 'acme.voice' },
    });

    expect(bound).toMatchObject({
      pluginId: 'acme.voice',
      requester: { kind: 'plugin', pluginId: 'acme.voice' },
      subject: {
        contribution: { pluginId: 'acme.voice', localId: 'voice-provider' },
      },
    });
  });

  it('uses nameable output schemas for plugin-visible Memory actions', () => {
    const search = getActionSpec('memory.search');
    const window = getActionSpec('memory.get_window');
    const ensure = getActionSpec('memory.ensure_up_to_date');

    expect(search.outputSchema?.safeParse({ v: 1, ok: true, hits: [] }).success).toBe(true);
    expect(window.outputSchema?.safeParse({ v: 1, snippets: [], citations: [] }).success).toBe(true);
    expect(ensure.outputSchema?.safeParse({ ok: true }).success).toBe(true);
    expect(search.outputSchema?.safeParse({ arbitrary: true }).success).toBe(false);
    expect(window.outputSchema?.safeParse({ arbitrary: true }).success).toBe(false);
  });

  it('declares approval result metadata for every action spec', () => {
    for (const spec of listActionSpecs()) {
      expect(spec.approval?.result).toEqual(expect.stringMatching(/^(required|optional|none)$/));
    }
  });

  it('classifies action approval result and flow contracts', () => {
    const groups = {
      requiredBlocking: [] as string[],
      noneDeferred: [] as string[],
      optionalDeferred: [] as string[],
    };

    for (const spec of listActionSpecs()) {
      const approval = (spec as any).approval as { flow?: 'blocking' | 'deferred'; result: 'required' | 'optional' | 'none' };
      const flow = resolveExpectedApprovalFlow(approval);
      if (spec.approval.result === 'required' && flow === 'blocking') groups.requiredBlocking.push(spec.id);
      if (spec.approval.result === 'none' && flow === 'deferred') groups.noneDeferred.push(spec.id);
      if (spec.approval.result === 'optional' && flow === 'deferred') groups.optionalDeferred.push(spec.id);
    }

    expect(sorted(groups.requiredBlocking)).toEqual(sorted(RESULT_REQUIRED_BLOCKING_ACTION_IDS));
    expect(sorted(groups.noneDeferred)).toEqual(sorted(RESULT_NONE_DEFERRED_ACTION_IDS));
    expect(sorted(groups.optionalDeferred)).toEqual(sorted(RESULT_OPTIONAL_DEFERRED_ACTION_IDS));
    expect(new Set([
      ...groups.requiredBlocking,
      ...groups.noneDeferred,
      ...groups.optionalDeferred,
    ]).size).toBe(listActionSpecs().length);
  });

  it('exports approval metadata schema helpers', async () => {
    const module = await import('./actionSpecs.js') as Record<string, unknown>;

    expect(module.ActionApprovalSchema).toBeDefined();
    expect(module.resolveActionApprovalFlow).toEqual(expect.any(Function));
  });

  it('uses default blocking flow for result-required approval metadata', () => {
    expect(getActionSpec('session.list').approval).toEqual({ result: 'required' });
  });

  it('uses default deferred flow for no-result approval metadata', () => {
    expect(getActionSpec('session.title.set').approval).toEqual({ result: 'none' });
  });

  it('requires optional-result approval metadata to declare an explicit flow', () => {
    const base = {
      id: 'review.start',
      title: 'Start review',
      safety: 'safe',
      placements: [],
      surfaces: {
        ui: true,
        voice: true,
        agent: false,
        mcp: true,
        cli: true,
        rpc: false,
        api: false,
        plugin: false,
      },
      bindings: { mcpToolName: 'review_start' },
      outputSchema: z.unknown(),
      inputSchema: z.object({}).strict(),
    };

    expect(() => ActionSpecSchema.parse({
      ...base,
      approval: { result: 'optional' },
    })).toThrow(/flow/i);
    expect(ActionSpecSchema.parse({
      ...base,
      approval: { result: 'optional', flow: 'deferred' },
    }).approval).toEqual({
      result: 'optional',
      flow: 'deferred',
    });
  });

  it('serializes approval metadata in action catalog entries', () => {
    const serialized = serializeActionSpec(getActionSpec('session.list'));

    expect(serialized.approval).toEqual({ result: 'required' });
  });

  it('serializes tool exposure metadata in action catalog entries', () => {
    const parsed = ActionSpecSchema.parse({
      id: 'review.start',
      title: 'Start review',
      safety: 'safe',
      approval: { result: 'optional', flow: 'deferred' },
      placements: [],
      surfaces: {
        ui: true,
        voice: true,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
        api: false,
        plugin: false,
      },
      bindings: { mcpToolName: 'review_start' },
      outputSchema: z.unknown(),
      inputSchema: z.object({}).strict(),
      toolExposure: {
        agent: 'discoverable_only',
      },
    });

    expect(serializeActionSpec(parsed).toolExposure).toEqual({
      agent: 'discoverable_only',
    });
  });

  it('does not reuse MCP tool bindings across action specs', () => {
    const ownersByToolName = new Map<string, string>();

    for (const spec of listActionSpecs()) {
      const toolName = String(spec.bindings?.mcpToolName ?? '').trim();
      if (!toolName) continue;
      const existingOwner = ownersByToolName.get(toolName);
      expect(existingOwner, `${toolName} is bound by both ${existingOwner} and ${spec.id}`).toBeUndefined();
      ownersByToolName.set(toolName, spec.id);
    }
  });

  it('rejects UI placements when the broad UI surface is disabled', () => {
    const parsed = ActionSpecSchema.safeParse({
      id: 'session.list',
      title: 'List sessions',
      safety: 'safe',
      approval: { result: 'required' },
      placements: ['command_palette'],
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: false,
        plugin: false,
      },
      inputSchema: z.object({}).strict(),
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ['surfaces', 'ui'],
      }),
    ]));
  });

  it('finds known action specs by id', () => {
    const spec = getActionSpec('execution.run.list');
    expect(spec.id).toBe('execution.run.list');
    expect(spec.surfaces.voice).toBe(true);
  });

  it('documents the four execution-run Session scope cases without a second Action family', () => {
    const start = getActionSpec('execution.run.start');
    const sessionId = start.inputHints?.fields.find((field) => field.path === 'sessionId');

    expect(start.inputSchema.safeParse({
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Inspect the requested change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      sessionId: 'session_1',
    }).success).toBe(true);
    expect(start.inputSchema.safeParse({
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Inspect the requested change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      sessionId: null,
    }).success).toBe(true);
    expect(start.inputSchema.safeParse({
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Inspect the requested change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }).success).toBe(true);
    expect(start.description).toContain('A nonempty sessionId selects that exact authorized Session.');
    expect(start.description).toContain('Omitting sessionId inherits the current Action Session, or selects detached scope when none exists.');
    expect(start.description).toContain('sessionId:null selects detached scope even inside a current Session.');
    expect(sessionId?.description).toBe('Use a nonempty value for an exact authorized Session. Omit it to inherit the current Action Session, or to select detached scope when no current Session exists. Set null to select detached scope even inside a current Session.');
    expect(listActionSpecs().some((spec) => spec.id.startsWith('execution.oneShot.'))).toBe(false);
  });

  it('keeps execution-run Action docs, hints, and examples aligned on scope and wait semantics', () => {
    const scopeActionIds = [
      'execution.run.start',
      'execution.run.list',
      'execution.run.get',
      'execution.run.send',
      'execution.run.stop',
      'execution.run.action',
      'execution.run.wait',
    ] as const;

    for (const id of scopeActionIds) {
      const spec = getActionSpec(id);
      const sessionId = spec.inputHints?.fields.find((field) => field.path === 'sessionId');
      expect(spec.description).toContain('A nonempty sessionId selects that exact authorized Session.');
      expect(spec.description).toContain('Omitting sessionId inherits the current Action Session, or selects detached scope when none exists.');
      expect(spec.description).toContain('sessionId:null selects detached scope even inside a current Session.');
      expect(sessionId?.description).toContain('Use a nonempty value for an exact authorized Session.');
      expect(sessionId?.description).toContain('Omit it to inherit the current Action Session, or to select detached scope when no current Session exists.');
      expect(sessionId?.description).toContain('Set null to select detached scope even inside a current Session.');
    }

    const startExample = JSON.parse(getActionSpec('execution.run.start').examples?.mcp?.argsExample ?? '{}');
    const listExample = JSON.parse(getActionSpec('execution.run.list').examples?.voice?.argsExample ?? '{}');
    const getExample = JSON.parse(getActionSpec('execution.run.get').examples?.voice?.argsExample ?? '{}');
    expect(startExample.sessionId).toBe('{{sessionId}}');
    expect(startExample.waitForCompletion).toBe(true);
    expect(startExample.waitTimeoutSeconds).toBe(60);
    expect(listExample).not.toHaveProperty('sessionId');
    expect(getExample.sessionId).toBeNull();

    const start = getActionSpec('execution.run.start');
    const waitForCompletion = start.inputHints?.fields.find((field) => field.path === 'waitForCompletion');
    const waitTimeoutSeconds = start.inputHints?.fields.find((field) => field.path === 'waitTimeoutSeconds');
    expect(start.description).toContain('Set waitForCompletion=true to wait for a terminal run result.');
    expect(start.description).toContain('waitTimeoutSeconds only bounds this observation; it never stops, retries, or starts the run.');
    expect(waitForCompletion).toEqual({
      path: 'waitForCompletion',
      title: 'Wait for completion',
      description: 'Return the terminal run disposition under wait instead of returning immediately after start.',
      widget: 'boolean',
    });
    expect(waitTimeoutSeconds).toEqual({
      path: 'waitTimeoutSeconds',
      title: 'Wait timeout seconds',
      description: 'Optional observation deadline; requires waitForCompletion=true and never stops the run.',
      widget: 'text',
    });

    const wait = getActionSpec('execution.run.wait');
    expect(wait.description).toContain('Timeout only ends this observation; it does not stop, retry, or start the run.');
    expect(wait.description).toContain('Cancellation only ends this wait.');
  });

  it("keeps Voice's Session execution-run subset on the canonical plugin Action projection", () => {
    const voiceOperations = [
      ['execution.run.start', 'startExecutionRun'],
      ['execution.run.get', 'getExecutionRun'],
      ['execution.run.send', 'sendExecutionRunMessage'],
      ['execution.run.stop', 'stopExecutionRun'],
      ['execution.run.list', 'listExecutionRuns'],
    ] as const;

    for (const [actionId, voiceClientToolName] of voiceOperations) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces).toMatchObject({ voice: true, plugin: true, api: true });
      expect(spec.bindings?.voiceClientToolName).toBe(voiceClientToolName);
    }

    expect(getActionSpec('execution.run.wait').surfaces).toMatchObject({ voice: false, plugin: true, api: true });
  });

  it('surfaces action discovery tools on both agent and external mcp', () => {
    const spec = getActionSpec('action.spec.search');
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.surfaces.mcp).toBe(true);
  });

  it('exposes only the MCP-capable session targeting Action outside the voice client', () => {
    const primaryTarget = getActionSpec('session.target.primary.set');
    const trackedTarget = getActionSpec('session.target.tracked.set');

    expect(primaryTarget.surfaces).toMatchObject({ mcp: true, cli: false });
    expect(trackedTarget.surfaces).toMatchObject({ mcp: false, cli: false });
    expect(trackedTarget.bindings?.mcpToolName).toBeUndefined();
    expect(getActionSpec('session.list').surfaces.mcp).toBe(true);
    expect(getActionSpec('session.activity.get').surfaces.mcp).toBe(true);
    expect(getActionSpec('session.transcript.get' as ActionId).bindings?.mcpToolName).toBe('session_transcript_get');
    expect(getActionSpec('session.events.get' as ActionId).bindings?.mcpToolName).toBe('session_events_get');
    expect(getActionSpec('session.messages.recent.get').surfaces.mcp).toBe(true);
  });

  it('accepts session.list filter fields in the action schema', () => {
    const spec = getActionSpec('session.list');

    expect(
      spec.inputSchema.parse({
        limit: 200,
        cursor: 'cursor-1',
        includeLastMessagePreview: false,
        activeOnly: true,
        archivedOnly: false,
        includeSystem: true,
        resumableOnly: true,
        includeRows: true,
      }),
    ).toEqual({
      limit: 200,
      cursor: 'cursor-1',
      includeLastMessagePreview: false,
      activeOnly: true,
      archivedOnly: false,
      includeSystem: true,
      resumableOnly: true,
      includeRows: true,
    });
  });

  it('marks old transcript/session-history actions as deprecated aliases', () => {
    expect(getActionSpec('session.messages.recent.get').description).toContain('DEPRECATED: use session_transcript_get');
    expect(getActionSpec('session.history.get').description).toContain('DEPRECATED: use session_events_get');
  });

  it('defines session work-state, goal, and catalog action specs', () => {
    expect(getActionSpec('session.work_state.get' as any).bindings?.mcpToolName).toBe('session_work_state_get');
    expect(getActionSpec('session.goal.get' as any).bindings?.mcpToolName).toBe('session_goal_get');
    expect(getActionSpec('session.goal.set' as any).bindings?.mcpToolName).toBe('session_goal_set');
    expect(getActionSpec('session.goal.clear' as any).bindings?.mcpToolName).toBe('session_goal_clear');
    expect(getActionSpec('session.vendor_plugin_catalog.list' as any).bindings?.mcpToolName).toBe(
      'session_vendor_plugin_catalog_list',
    );
    expect(getActionSpec('session.skill_catalog.list' as any).bindings?.mcpToolName).toBe('session_skill_catalog_list');

    const goalSetSchema = getActionSpec('session.goal.set' as any).inputSchema;
    expect(goalSetSchema.parse({ sessionId: 's1', status: 'paused' })).toEqual({
      sessionId: 's1',
      status: 'paused',
    });
    expect(goalSetSchema.parse({ sessionId: 's1', tokenBudget: null })).toEqual({
      sessionId: 's1',
      tokenBudget: null,
    });
    expect(() => goalSetSchema.parse({ sessionId: 's1' })).toThrow();
  });

  it('validates catalog action output schemas with runtime catalog contracts', () => {
    const vendorOutputSchema = getActionSpec('session.vendor_plugin_catalog.list' as any).outputSchema;
    expect(vendorOutputSchema.parse({
      supported: true,
      vendorPlugins: [
        {
          v: 1,
          backendId: 'codex',
          vendorPluginRef: 'plugin://gmail@openai-curated',
          displayName: 'Gmail',
          installed: true,
          enabled: true,
        },
      ],
      catalog: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        items: [
          {
            v: 1,
            backendId: 'codex',
            vendorPluginRef: 'plugin://gmail@openai-curated',
            displayName: 'Gmail',
            installed: true,
            enabled: true,
          },
        ],
      },
    })).toMatchObject({
      vendorPlugins: [
        expect.objectContaining({
          backendId: 'codex',
          mentionable: true,
        }),
      ],
    });
    expect(() => vendorOutputSchema.parse({ vendorPlugins: [{ v: 1, backendId: 'codex' }] })).toThrow();

    const skillOutputSchema = getActionSpec('session.skill_catalog.list' as any).outputSchema;
    expect(skillOutputSchema.parse({
      supported: true,
      skills: [
        {
          v: 1,
          id: 'vendor:codex:review',
          origin: 'vendor',
          name: 'review',
          backendId: 'codex',
          path: '/skills/review/SKILL.md',
        },
      ],
      catalog: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        items: [
          {
            v: 1,
            id: 'vendor:codex:review',
            origin: 'vendor',
            name: 'review',
            backendId: 'codex',
            path: '/skills/review/SKILL.md',
          },
        ],
      },
    })).toMatchObject({
      skills: [
        expect.objectContaining({
          id: 'vendor:codex:review',
          origin: 'vendor',
        }),
      ],
    });
    expect(() => skillOutputSchema.parse({ skills: [{ v: 1, origin: 'vendor' }] })).toThrow();
  });

  it('declares usage-limit recovery action specs with conservative agent settings', () => {
    const enable = getActionSpec('session.usageLimit.waitResume.enable' as any);
    const cancel = getActionSpec('session.usageLimit.waitResume.cancel' as any);
    const checkNow = getActionSpec('session.usageLimit.checkNow' as any);
    const consumeResetCredit = getActionSpec('session.usageLimit.consumeResetCredit' as any);

    expect(enable.inputSchema).toBe((protocol as any).SessionUsageLimitWaitResumeEnableRequestV1Schema);
    expect(cancel.inputSchema).toBe((protocol as any).SessionUsageLimitWaitResumeCancelRequestV1Schema);
    expect(checkNow.inputSchema).toBe((protocol as any).SessionUsageLimitCheckNowRequestV1Schema);
    expect(consumeResetCredit.inputSchema).toBe((protocol as any).SessionUsageLimitConsumeResetCreditRequestV1Schema);
    expect(enable.bindings?.mcpToolName).toBe('session_usage_limit_wait_resume_enable');
    expect(cancel.bindings?.mcpToolName).toBe('session_usage_limit_wait_resume_cancel');
    expect(checkNow.bindings?.mcpToolName).toBe('session_usage_limit_check_now');
    expect(consumeResetCredit.bindings?.mcpToolName).toBe('session_usage_limit_consume_reset_credit');
    expect(enable.approval).toEqual({ result: 'none', flow: 'deferred' });
    expect(cancel.approval).toEqual({ result: 'none', flow: 'deferred' });
    expect(checkNow.approval.result).toBe('required');
    expect(consumeResetCredit.approval.result).toBe('required');
    expect(checkNow.safety).toBe('safe');
    expect(consumeResetCredit.safety).toBe('danger');
    expect(enable.surfaces.agent).toBe(true);
    expect(cancel.surfaces.agent).toBe(true);
    expect(checkNow.surfaces.agent).toBe(true);
    expect(consumeResetCredit.surfaces.agent).toBe(true);
    expect(enable.inputHints?.fields.find((field) => field.path === 'resumePromptMode')).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({ value: 'custom' }),
      ]),
    });
    expect(cancel.inputHints?.fields.map((field) => field.path)).toEqual(expect.arrayContaining([
      'issueFingerprint',
      'armedAtMs',
      'runtimeAuthRecoveryAttemptId',
    ]));
    expect(cancel.examples?.mcp?.argsExample).toContain('armedAtMs');
    expect(checkNow.inputHints?.fields.find((field) => field.path === 'provider')).toMatchObject({
      path: 'provider',
      widget: 'text',
    });
    expect(checkNow.inputHints?.fields.find((field) => field.path === 'operation')).toMatchObject({
      widget: 'select',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'check_now' }),
          expect.objectContaining({ value: 'switch_account_now' }),
        ]),
    });
    expect(checkNow.inputHints?.fields.find((field) => field.path === 'operation')).not.toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({ value: 'consume_reset_credit' }),
      ]),
    });
    expect(checkNow.inputHints?.fields.find((field) => field.path === 'resumePromptMode')).toMatchObject({
      widget: 'select',
      options: expect.arrayContaining([
        expect.objectContaining({ value: 'standard' }),
        expect.objectContaining({ value: 'off' }),
        expect.objectContaining({ value: 'custom' }),
      ]),
    });
    expect(consumeResetCredit.inputHints?.fields.find((field) => field.path === 'provider')).toMatchObject({
      path: 'provider',
      widget: 'text',
    });
    expect(consumeResetCredit.inputHints?.fields.find((field) => field.path === 'resumePromptMode')).toMatchObject({
      widget: 'select',
      options: expect.arrayContaining([
        expect.objectContaining({ value: 'standard' }),
        expect.objectContaining({ value: 'off' }),
        expect.objectContaining({ value: 'custom' }),
      ]),
    });
    expect(enable.inputSchema.parse({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:123',
      remember: true,
      resumePromptMode: 'off',
    })).toEqual({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:123',
      remember: true,
      resumePromptMode: 'off',
    });
    expect(enable.inputSchema.safeParse({
      sessionId: 's1',
      resumePromptMode: 'invalid',
    }).success).toBe(false);
    expect(enable.inputSchema.parse({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:123',
      rememberPreference: true,
    })).toEqual({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:123',
      rememberPreference: true,
    });
    expect(cancel.inputSchema.parse({
      sessionId: 's1',
      issueFingerprint: null,
    })).toEqual({
      sessionId: 's1',
      issueFingerprint: null,
    });
  });

  it('declares runtime-unification action specs with executor-specific UI/Agent routes and canonical public projections', () => {
    for (const id of RUNTIME_ACTION_IDS) {
      const spec = getActionSpec(id as ActionId);
      expect(spec.id).toBe(id);
      const publicProjection = !isInternalActionId(id);
      expect(spec.surfaces, id).toEqual({
        ...resolveRuntimeActionSurfaces(id as RuntimeActionIdV1),
        api: publicProjection,
        plugin: publicProjection,
      });
      expect(spec.bindings).toBeUndefined();
    }

    // Spot-check the only remaining fail-closed leaf stays disabled on every surface.
    for (const id of [
      // Absolute-orientation input has no producer (stock scrcpy rotate is relative) → stays
      // statically-unbacked / UNSURFACED. (Resource-gated stream controls like keyframe/snapshot are
      // backed by the Android server-restart producer and surface when advertised, so they are NOT
      // spot-checked as unconditionally disabled here.)
      'devices.simulator.input.orientation',
    ]) {
      expect(getActionSpec(id as ActionId).surfaces.agent).toBe(false);
      expect(getActionSpec(id as ActionId).surfaces.ui).toBe(false);
    }
    // Spot-check the dangerous agent-initiated subset is now reachable on `agent` (incl. the
    // newly-surfaced recording.start danger leaf — its approval floor was required in place first).
    for (const id of [
      'browser.context.capturePage',
      'browser.context.captureScreenshot',
      'browser.context.annotation.captureRegion',
      'browser.context.annotation.captureElement',
      'browser.recording.start',
      // browser.diagnostics INTERACTION verbs — now backed by the live sidecar CDP interaction
      // transport (DIAG-INTERACTION) and surfaced. `eval` stays danger-floored for consent.
      'browser.diagnostics.eval',
      'browser.diagnostics.pause',
      'browser.diagnostics.resume',
      'browser.diagnostics.getProperties',
      'browser.diagnostics.releaseObjectGroup',
      'browser.diagnostics.elementPicker.start',
      'browser.diagnostics.elementPicker.cancel',
      'localServices.publicPreview.create',
      'localServices.actions.stopManaged',
      'devices.simulator.input.tap',
      'devices.simulator.input.pinch',
    ]) {
      expect(getActionSpec(id as ActionId).surfaces.agent).toBe(true);
      expect(getActionSpec(id as ActionId).surfaces.ui).toBe(true);
    }

    expect(getActionSpec('browser.diagnostics.eval' as ActionId)).toMatchObject({
      safety: 'danger',
      sideEffectClass: 'danger',
    });
    expect(getActionSpec('localServices.publicPreview.create' as ActionId)).toMatchObject({
      safety: 'danger',
      sideEffectClass: 'danger',
    });
    expect(getActionSpec('localServices.publicPreview.revoke' as ActionId)).toMatchObject({
      safety: 'danger',
      sideEffectClass: 'danger',
    });
    expect(getActionSpec('devices.simulator.input.tap' as ActionId)).toMatchObject({
      safety: 'danger',
      sideEffectClass: 'external',
    });

    expect(() => getActionSpec('daemon.browser.recording.start' as ActionId)).toThrow();
    expect(() => getActionSpec('daemon.localServices.preview.snapshot' as ActionId)).toThrow();
    expect(() => getActionSpec('daemon.devices.simulator.preview.action' as ActionId)).toThrow();
  });

  it('does not declare retired unbacked runtime actions', () => {
    for (const id of RETIRED_UNBACKED_RUNTIME_ACTION_IDS) {
      expect(ActionIdSchema.safeParse(id).success).toBe(false);
      expect(RuntimeActionIdV1Schema.options).not.toContain(id);
      expect(() => getActionSpec(id as ActionId)).toThrow();
    }

    // Distinct diagnostics picker verbs have real CLI/UI producers and must stay surfaced.
    for (const id of [
      'browser.diagnostics.elementPicker.start',
      'browser.diagnostics.elementPicker.cancel',
    ] as const) {
      expect(ActionIdSchema.safeParse(id).success).toBe(true);
      expect(RuntimeActionIdV1Schema.options).toContain(id);
      expect(getActionSpec(id).surfaces.ui).toBe(true);
      expect(getActionSpec(id).surfaces.agent).toBe(true);
    }
  });

  it('derives runtime host action effects from the canonical ActionSpec side-effect owner', () => {
    expect(resolveRuntimeActionHostEffectClass('localServices.launcher.start')).toBe('destructive');
    expect(resolveRuntimeActionHostEffectClass('localServices.actions.stopManaged')).toBe('destructive');
    expect(resolveRuntimeActionHostEffectClass('localServices.actions.restartManaged')).toBe('destructive');
    expect(resolveRuntimeActionHostEffectClass('localServices.publicPreview.create')).toBe('destructive');
    expect(resolveRuntimeActionHostEffectClass('localServices.publicPreview.revoke')).toBe('destructive');
    expect(resolveRuntimeActionHostEffectClass('localServices.publicPreview.copyUrl')).toBeNull();
    expect(resolveRuntimeActionHostEffectClass('browser.navigate')).toBe('externalNavigation');
    expect(resolveRuntimeActionHostEffectClass('devices.simulator.input.tap')).toBeNull();
  });

  it('uses the daemon launcher start request and response schemas for launcher start runtime actions', () => {
    const spec = getActionSpec('localServices.launcher.start');

    expect(spec.inputSchema.parse({
      machineId: 'machine-a',
      targetId: 'managed:web',
      sessionId: 'session-a',
    })).toEqual({
      machineId: 'machine-a',
      targetId: 'managed:web',
      sessionId: 'session-a',
    });
    expect(spec.inputSchema.safeParse({
      targetId: 'managed:web',
    }).success).toBe(false);
    expect(spec.outputSchema?.parse({
      protocolVersion: 1,
      machineId: 'machine-a',
      targetId: 'managed:web',
      status: 'succeeded',
      snapshot: {
        v: 1,
        machineId: 'machine-a',
        updatedAt: 4_000,
        targets: [],
      },
    })).toMatchObject({
      status: 'succeeded',
      targetId: 'managed:web',
    });
  });

  it('uses the browser command dispatch result schema for browser control runtime actions', () => {
    const spec = getActionSpec('browser.navigate');

    expect(spec.outputSchema.parse({
      v: 1,
      commandId: 'command_1',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    })).toMatchObject({
      commandId: 'command_1',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
    });

    expect(() => spec.outputSchema.parse({
      v: 1,
      commandId: 'command_2',
      status: 'failed',
      adapterKind: 'chromiumSidecar',
      error: {
        code: 'not_a_browser_error',
        message: 'Nope.',
      },
    })).toThrow();
  });

  it('binds each browser control Action id to its exact command kind', () => {
    const browserSessionId = 'browser_session_1';
    const viewId = 'view_1';
    const target = {
      kind: 'externalUrl',
      targetId: 'target_1',
      url: 'https://browser.example.test/start',
    } as const;
    const navigateCommand = {
      kind: 'navigate',
      commandId: 'command_navigate',
      browserSessionId,
      viewId,
      url: 'https://browser.example.test/next',
    } as const;
    const focusCommand = {
      kind: 'focusView',
      commandId: 'command_focus',
      browserSessionId,
      viewId,
    } as const;
    const cases = [
      ['browser.view.open', {
        kind: 'openView',
        commandId: 'command_open',
        browserSessionId,
        viewId,
        target,
        platform: 'web',
      }],
      ['browser.view.close', {
        kind: 'closeView',
        commandId: 'command_close',
        browserSessionId,
        viewId,
      }],
      ['browser.view.focus', focusCommand],
      ['browser.target.set', {
        kind: 'setTarget',
        commandId: 'command_target',
        browserSessionId,
        viewId,
        target,
      }],
      ['browser.navigate', navigateCommand],
      ['browser.reload', {
        kind: 'reload',
        commandId: 'command_reload',
        browserSessionId,
        viewId,
      }],
      ['browser.goBack', {
        kind: 'goBack',
        commandId: 'command_back',
        browserSessionId,
        viewId,
      }],
      ['browser.goForward', {
        kind: 'goForward',
        commandId: 'command_forward',
        browserSessionId,
        viewId,
      }],
      ['browser.stop', {
        kind: 'stop',
        commandId: 'command_stop',
        browserSessionId,
        viewId,
      }],
    ] as const satisfies ReadonlyArray<readonly [RuntimeActionIdV1, Readonly<Record<string, unknown>>]>;

    for (const [actionId, command] of cases) {
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema.safeParse(command).success).toBe(true);
      expect(spec.inputSchema.safeParse(command.kind === 'navigate' ? focusCommand : navigateCommand).success).toBe(false);
    }

    expect(getActionSpec('browser.view.open').inputSchema.safeParse({
      kind: 'openView',
      commandId: 'command_open_missing_target',
      browserSessionId,
      viewId,
    }).success).toBe(false);
    expect(getActionSpec('browser.target.set').inputSchema.safeParse({
      kind: 'setTarget',
      commandId: 'command_target_missing_target',
      browserSessionId,
      viewId,
    }).success).toBe(false);
  });

  it('declares session events MCP examples with provider event kind filters', () => {
    expect(getActionSpec('session.events.get' as ActionId).examples?.mcp?.argsExample).toBe(
      '{"sessionId":"{{sessionId}}","limit":50,"kinds":["tool_call","tool_result"]}',
    );
  });

  it('declares session transcript full-text defaults and optional truncation metadata', () => {
    const transcript = getActionSpec('session.transcript.get' as ActionId);

    expect(transcript.examples?.mcp?.argsExample).toBe('{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}');
    expect(transcript.examples?.voice?.argsExample).toBe('{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}');
    expect(transcript.inputHints?.fields.find((field) => field.path === 'maxCharsPerMessage')).toEqual({
      path: 'maxCharsPerMessage',
      title: 'Message truncation chars',
      description: 'Optional per-message truncation budget. Omit or pass null for full message text.',
      widget: 'text',
    });
    expect(transcript.inputSchema.parse({ sessionId: 's1', maxCharsPerMessage: null })).toEqual({
      sessionId: 's1',
      maxCharsPerMessage: null,
    });
    expect(transcript.inputSchema.parse({ sessionId: 's1', maxCharsPerMessage: 50_000 })).toEqual({
      sessionId: 's1',
      maxCharsPerMessage: 50_000,
    });
    expect(() => transcript.inputSchema.parse({ sessionId: 's1', maxCharsPerMessage: 50_001 })).toThrow();
    expect(transcript.inputSchema.parse({
      sessionId: 's1',
      projection: 'externalShareableV1',
      cursor: '7',
      limit: 20,
    })).toEqual({
      sessionId: 's1',
      projection: 'externalShareableV1',
      cursor: '7',
      limit: 20,
    });
    expect(SessionTranscriptGetExternalShareableInputV1Schema.parse({
      sessionId: 's1',
      projection: 'externalShareableV1',
      cursor: '7',
      limit: 20,
    })).toEqual({
      sessionId: 's1',
      projection: 'externalShareableV1',
      cursor: '7',
      limit: 20,
    });
    expect(() => transcript.inputSchema.parse({ sessionId: 's1', projection: 'rawExternalV1' })).toThrow();
    expect(() => transcript.inputSchema.parse({
      sessionId: 's1',
      projection: 'externalShareableV1',
      includeRaw: true,
    })).toThrow();
    expect(() => SessionTranscriptGetExternalShareableInputV1Schema.parse({
      sessionId: 's1',
      projection: 'externalShareableV1',
      includeRaw: true,
    })).toThrow();
  });

  it('keeps transcript item attribution on the canonical provider field and rejects an undeclared agentId', () => {
    const transcript = getActionSpec('session.transcript.get' as ActionId);
    if (!transcript?.outputSchema) throw new Error('session.transcript.get output schema is unavailable');
    const page = {
      ok: true as const,
      sessionId: 's1',
      items: [{
        id: 'i1',
        createdAt: 1,
        semanticRole: 'assistant' as const,
        role: 'assistant' as const,
        kind: 'assistant_message',
        provider: 'openai',
      }],
      nextCursor: null,
      hasMore: false,
      diagnostics: {
        rawRowsScanned: 1,
        pagesFetched: 1,
        scanLimitReached: false,
        payloadTruncations: 0,
      },
    };

    expect(transcript.outputSchema.parse(page)).toMatchObject({
      items: [{ provider: 'openai' }],
    });
    // The canonical item schema intentionally exposes its existing provider
    // field. A different Agent-id field is not part of this strict result
    // contract and must not be silently accepted.
    const { provider: _provider, ...itemWithoutProvider } = page.items[0]!;
    expect(() => transcript.outputSchema!.parse({
      ...page,
      items: [{ ...itemWithoutProvider, agentId: 'codex' }],
    })).toThrow();
  });

  it('declares the transcript paging vocabulary so a discovering caller can page backwards', () => {
    const transcript = getActionSpec('session.transcript.get' as ActionId);

    // The action reads backwards by default, but a caller that only sees the
    // catalog cannot choose a parameter the catalog never mentions. Declaring
    // the option space here is what lets a consumer derive the call instead of
    // transcribing a literal it read out of the server's normalizer.
    expect(transcript.inputHints?.fields.find((field) => field.path === 'direction')).toEqual({
      path: 'direction',
      title: 'Direction',
      description: 'Page away from the cursor: before reads older items (the default), after reads newer ones.',
      widget: 'select',
      options: [
        { value: 'before', label: 'Before cursor (older)' },
        { value: 'after', label: 'After cursor (newer)' },
      ],
    });
    // Both halves of the idiom: a direction with no cursor still starts at the
    // newest page, so the example has to show the pair.
    const mcpExample = JSON.parse(String(transcript.examples?.mcp?.argsExample ?? '{}')) as Record<string, unknown>;
    expect(mcpExample).toMatchObject({ direction: 'before', cursor: null });
    expect(transcript.inputSchema.safeParse(mcpExample).success).toBe(true);

    // Every value the hints offer is one the action actually accepts.
    for (const option of transcript.inputHints?.fields.find((field) => field.path === 'direction')?.options ?? []) {
      expect(transcript.inputSchema.safeParse({ sessionId: 's1', direction: option.value }).success).toBe(true);
    }
    expect(transcript.inputSchema.safeParse({ sessionId: 's1', direction: 'sideways' }).success).toBe(false);
  });

  it('names the transcript page maximum once, at the schema that enforces it', () => {
    const transcript = getActionSpec('session.transcript.get' as ActionId);

    expect(transcript.inputSchema.safeParse({ sessionId: 's1', limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT }).success).toBe(true);
    expect(transcript.inputSchema.safeParse({ sessionId: 's1', limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT + 1 }).success).toBe(false);
  });

  it('declares a closed result contract for the external shareable transcript projection', () => {
    const transcript = getActionSpec('session.transcript.get' as ActionId);
    const externalShareableResult = {
      ok: true,
      sessionId: 's1',
      projection: 'externalShareableV1',
      items: [],
      scannedThroughSeq: 0,
      hasMore: false,
    } as const;

    expect(transcript.outputSchema.safeParse(externalShareableResult).success).toBe(true);
    expect(transcript.outputSchema.safeParse({
      ...externalShareableResult,
      serverOnlyReceipt: { accountId: 'private-account' },
    }).success).toBe(false);
  });

  it('surfaces approval actions on external mcp and cli (power user/internal)', () => {
    expect(getActionSpec('approval.request.create').surfaces.mcp).toBe(true);
    expect(getActionSpec('approval.request.create').surfaces.cli).toBe(true);
    expect(getActionSpec('approval.request.decide').surfaces.mcp).toBe(true);
    expect(getActionSpec('approval.request.decide').surfaces.cli).toBe(true);
  });

  it('binds approval queue RPC wire methods to ActionSpec rows', () => {
    const expectedBindings = new Map([
      ['approval.request.list', 'approval.request.list'],
      ['approval.request.get', 'approval.request.get'],
      ['approval.request.create', 'approval.request.create'],
      ['approval.request.decide', 'approval.request.decide'],
    ]);

    for (const [actionId, rpcMethod] of expectedBindings) {
      const spec = getActionSpec(actionId as any);

      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
    }
  });

  it('binds plugin permission grant RPC wire methods to ActionSpec rows', () => {
    const expectedBindings = new Map([
      ['plugins.permissions.grants.list', 'plugins.permissions.grants.list'],
      ['plugins.permissions.grants.request', 'plugins.permissions.grants.request'],
      ['plugins.permissions.grants.grant', 'plugins.permissions.grants.grant'],
      ['plugins.permissions.grants.revoke', 'plugins.permissions.grants.revoke'],
      ['plugins.permissions.grants.dismissRequest', 'plugins.permissions.grants.dismissRequest'],
    ]);

    for (const [actionId, rpcMethod] of expectedBindings) {
      const spec = getActionSpec(actionId as any);

      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
    }
  });

  it('accepts canceled approval status in approval list filters', () => {
    const spec = getActionSpec('approval.request.list' as any);

    expect(spec.inputSchema.parse({ status: 'canceled', limit: 10 })).toEqual({
      status: 'canceled',
      limit: 10,
    });
    expect(spec.inputHints?.fields.find((field) => field.path === 'status')?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'canceled' }),
      ]),
    );
  });

  it('registers pet chooser slash aliases as a UI-only action', () => {
    const spec = getActionSpec('ui.pet.choose');
    expect(spec.slash?.tokens).toEqual(['/pet', '/h.pet']);
    expect(spec.placements).toContain('slash_command');
    expect(spec.surfaces.ui).toBe(true);
    expect(spec.surfaces.mcp).toBe(false);
    expect(spec.surfaces.cli).toBe(false);
  });

  it('projects SCM pull-request actions through RPC and SDK surfaces only', () => {
    const expected: readonly [ActionId, 'read' | 'write' | 'external' | 'danger'][] = [
      ['scm.pullRequest.list', 'read'],
      ['scm.pullRequest.get', 'read'],
      ['scm.pullRequest.openOrReuse', 'external'],
      ['scm.pullRequest.openCompose', 'read'],
      ['scm.pullRequest.checkout', 'write'],
      ['scm.pullRequest.prepareWorktree', 'write'],
      ['scm.pullRequest.runStacked', 'danger'],
    ] as const;

    for (const [id, sideEffectClass] of expected) {
      const spec = getActionSpec(id);
      expect(spec.bindings?.rpcMethod).toBe(id);
      expect(spec.bindings?.sdkMethod).toBe(id);
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.surfaces.api).toBe(true);
      expect(spec.surfaces.mcp).toBe(false);
      expect(spec.surfaces.voice).toBe(false);
      expect(spec.sideEffectClass).toBe(sideEffectClass);
    }

    expect(getActionSpec('scm.pullRequest.list').safety).toBe('safe');
    expect(getActionSpec('scm.pullRequest.openOrReuse').safety).toBe('danger');
    expect(getActionSpec('scm.pullRequest.runStacked').safety).toBe('danger');
  });

  it('projects SCM repository provisioning actions through RPC and SDK surfaces only', () => {
    const expected: readonly [ActionId, 'read' | 'write' | 'external' | 'danger'][] = [
      ['scm.repository.clone', 'external'],
      ['scm.repository.init', 'write'],
      ['scm.repository.removeIndexLock', 'danger'],
      ['scm.hostingRepository.describePublishTargets', 'read'],
      ['scm.hostingRepository.publish', 'external'],
    ] as const;

    for (const [id, sideEffectClass] of expected) {
      const spec = getActionSpec(id);
      expect(spec.bindings?.rpcMethod).toBe(id);
      expect(spec.bindings?.sdkMethod).toBe(id);
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.surfaces.api).toBe(true);
      expect(spec.surfaces.mcp).toBe(false);
      expect(spec.surfaces.voice).toBe(false);
      expect(spec.sideEffectClass).toBe(sideEffectClass);
      expect(spec.outputSchema).toMatchObject({
        parse: expect.any(Function),
      });
    }

    expect(getActionSpec('scm.repository.clone').safety).toBe('danger');
    expect(getActionSpec('scm.repository.init').safety).toBe('danger');
    expect(getActionSpec('scm.repository.removeIndexLock').safety).toBe('danger');
    expect(getActionSpec('scm.hostingRepository.describePublishTargets').safety).toBe('safe');
    expect(getActionSpec('scm.hostingRepository.publish').safety).toBe('danger');
    expect(getActionSpec('scm.repository.removeIndexLock').inputHints?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'confirmed',
          required: true,
          widget: 'boolean',
        }),
      ]));
  });

  it('projects SCM diff-summary generation through RPC and SDK surfaces only', () => {
    const spec = getActionSpec('scm.diffSummary.generate' as ActionId);

    expect(spec.bindings?.rpcMethod).toBe('scm.diffSummary.generate');
    expect(spec.bindings?.sdkMethod).toBe('scm.diffSummary.generate');
    expect(spec.surfaces.rpc).toBe(true);
    expect(spec.surfaces.api).toBe(true);
    expect(spec.surfaces.ui).toBe(false);
    expect(spec.surfaces.mcp).toBe(false);
    expect(spec.surfaces.voice).toBe(false);
    expect(spec.surfaces.agent).toBe(false);
    expect(spec.sideEffectClass).toBe('external');
    expect(spec.safety).toBe('safe');

    expect(spec.inputSchema.parse({
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' },
      checkpointReceiptId: 'checkpoint.diff_computed',
    })).toMatchObject({
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' },
      checkpointReceiptId: 'checkpoint.diff_computed',
    });

    expect(() => spec.inputSchema.parse({
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' },
    })).toThrow();

    expect(spec.outputSchema.parse({
      success: true,
      summaryMarkdown: 'Changed one file.',
      sourceKey: 'checkpoint:checkpoint.diff_computed',
      checkpointReceiptId: 'checkpoint.diff_computed',
      metadata: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'checkpoint:checkpoint.diff_computed',
        checkpointReceiptId: 'checkpoint.diff_computed',
        contentConfidence: 'exact',
        attributionScope: 'unknown',
      },
      truncation: {
        reason: 'diffBytes',
        droppedFiles: 2,
      },
    })).toMatchObject({
      success: true,
      summaryMarkdown: 'Changed one file.',
      sourceKey: 'checkpoint:checkpoint.diff_computed',
      truncation: { reason: 'diffBytes', droppedFiles: 2 },
    });
  });

  it('projects external-session actions through canonical external-session RPC bindings and legacy direct-session aliases', () => {
    const expected: readonly [ActionId, string, string, string | null, 'read' | 'write' | 'danger', boolean][] = [
      ['sessions.external.candidates.list', RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST, RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY, 'sessions.external.listCandidates', 'read', true],
      ['sessions.external.link.ensure', RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE, RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY, null, 'write', true],
      ['sessions.external.follow', RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH, RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH_LEGACY, null, 'write', true],
      ['sessions.external.unfollow', RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH, RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH_LEGACY, null, 'write', true],
      ['sessions.external.status.get', RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET, RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY, null, 'read', true],
      ['sessions.external.transcript.page', RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY, 'sessions.external.pageTranscript', 'read', true],
      ['sessions.external.transcript.readAfter', RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER, RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY, 'sessions.external.readAfterTranscript', 'read', true],
      ['sessions.external.takeover', RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER, RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY, 'sessions.external.takeover.execute', 'danger', false],
    ];

    for (const [id, rpcMethod, legacyRpcMethod, sdkMethod, sideEffectClass, api] of expected) {
      const spec = getActionSpec(id);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
      expect(spec.bindings?.rpcMethodAliases).toContain(legacyRpcMethod);
      expect(spec.bindings?.sdkMethod ?? null).toBe(sdkMethod);
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.surfaces.api).toBe(api);
      expect(spec.surfaces.mcp).toBe(false);
      expect(spec.surfaces.voice).toBe(false);
      expect(spec.sideEffectClass).toBe(sideEffectClass);
    }

    const backgroundFollow = getActionSpec('sessions.external.backgroundFollow.set');
    expect(backgroundFollow.bindings?.rpcMethod).toBe(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
    );
    expect(backgroundFollow.bindings?.rpcMethodAliases).toBeUndefined();
    expect(backgroundFollow.surfaces.rpc).toBe(true);
    expect(backgroundFollow.surfaces.api).toBe(true);
    expect(backgroundFollow.sideEffectClass).toBe('write');

    const takeover = getActionSpec('sessions.external.takeover');
    expect(takeover.bindings?.rpcMethodAliases).toEqual([
      RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
      RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
    ]);
  });

  it('projects operation actions without inventing compatibility aliases or a second takeover owner', () => {
    const expected: readonly [ActionId, string, 'read' | 'write' | 'danger'][] = [
      ['sessions.external.materialize.start', RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START, 'write'],
      ['sessions.external.takeover.start', RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START, 'danger'],
      ['sessions.external.operation.status.get', RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, 'read'],
      ['sessions.external.operation.cancel', RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL, 'write'],
      ['sessions.external.operation.resume', RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME, 'write'],
      ['sessions.external.operation.retry', RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY, 'write'],
      ['sessions.external.operation.discard', RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD, 'danger'],
    ];

    for (const [id, rpcMethod, sideEffectClass] of expected) {
      const spec = getActionSpec(id);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
      expect(spec.bindings?.rpcMethodAliases).toBeUndefined();
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.surfaces.api).toBe(id !== 'sessions.external.materialize.start');
      // Raw durable takeover Start is not a plugin-discoverable workflow:
      // SessionsService.external.takeover privately delegates to it.
      expect(spec.surfaces.plugin).toBe(id !== 'sessions.external.takeover.start');
      expect(spec.sideEffectClass).toBe(sideEffectClass);
    }

    const takeoverStart = getActionSpec('sessions.external.takeover.start');
    expect(takeoverStart.surfaceBindings?.rpc?.inputSchema).toBe(takeoverStart.inputSchema);
    expect(takeoverStart.surfaceBindings?.rpc?.outputSchema).toBe(takeoverStart.outputSchema);
    expect(takeoverStart.surfaceBindings?.rpc?.decodeInput).toBeDefined();
    expect(takeoverStart.surfaceBindings?.rpc?.encodeOutput).toBeDefined();

    expect(getActionSpec('sessions.external.takeover').bindings?.rpcMethod).toBe(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
    );
  });

  it('binds non-external transcript RPC wire methods to ActionSpec rows', () => {
    const expectedBindings = new Map([
      ['session.log.tail', RPC_METHODS.SESSION_LOG_TAIL],
      ['transcript.page', RPC_METHODS.TRANSCRIPT_PAGE],
      ['transcript.readAfter', RPC_METHODS.TRANSCRIPT_READ_AFTER],
      ['transcript.follow', RPC_METHODS.TRANSCRIPT_FOLLOW],
      ['transcript.unfollow', RPC_METHODS.TRANSCRIPT_UNFOLLOW],
      ['transcript.import', RPC_METHODS.TRANSCRIPT_IMPORT],
      ['transcript.search', RPC_METHODS.TRANSCRIPT_SEARCH],
    ]);

    for (const [actionId, rpcMethod] of expectedBindings) {
      const spec = getActionSpec(actionId as ActionId);

      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
      expect(spec.surfaces.api).toBe(true);
      expect(spec.surfaces.mcp).toBe(false);
      expect(spec.surfaces.voice).toBe(false);
    }
  });

  it('keeps transcript action schemas bounded by cursor, offset, count, and query inputs', () => {
    expect(getActionSpec('session.log.tail' as ActionId).inputSchema.parse({
      path: '/tmp/session.log',
      maxBytes: 4096,
      offset: 12,
    })).toMatchObject({ maxBytes: 4096, offset: 12 });

    expect(getActionSpec('transcript.page' as ActionId).inputSchema.parse({
      sessionId: 'session-1',
      cursor: 'cursor-1',
      maxBytes: 4096,
      maxItems: 25,
    })).toMatchObject({ sessionId: 'session-1', cursor: 'cursor-1', maxItems: 25 });

    expect(getActionSpec('transcript.readAfter' as ActionId).inputSchema.parse({
      sessionId: 'session-1',
      cursor: 'cursor-1',
      maxBytes: 4096,
      maxItems: 25,
    })).toMatchObject({ cursor: 'cursor-1', maxItems: 25 });

    expect(getActionSpec('transcript.follow' as ActionId).inputSchema.parse({
      sessionId: 'session-1',
      cursor: 'tail',
      leaseId: 'lease-1',
      maxBytes: 4096,
      maxItems: 25,
    })).toMatchObject({ leaseId: 'lease-1', cursor: 'tail' });

    expect(getActionSpec('transcript.import' as ActionId).inputSchema.parse({
      sessionId: 'session-1',
      importId: 'import-operation-1',
      items: [{ id: 'item-1', role: 'user', content: { t: 'plain', v: { text: 'hello' } } }],
      maxItems: 1,
    })).toMatchObject({ sessionId: 'session-1', importId: 'import-operation-1', maxItems: 1 });

    expect(getActionSpec('transcript.search' as ActionId).inputSchema.parse({
      sessionId: 'session-1',
      query: 'permission',
      cursor: 'cursor-1',
      maxItems: 10,
    })).toMatchObject({ query: 'permission', cursor: 'cursor-1' });

    expect(() => getActionSpec('transcript.search' as ActionId).inputSchema.parse({
      sessionId: 'session-1',
      query: '',
    })).toThrow();
  });

  it('defines transcript unfollow as a strict safe write at the canonical Session owner', () => {
    const spec = getActionSpec('transcript.unfollow' as ActionId);

    expect(spec.safety).toBe('safe');
    expect(spec.sideEffectClass).toBe('write');
    expect(spec.executionPlacement).toBe('session');
    expect(spec.inputSchema.parse({ leaseId: 'lease-1' })).toEqual({ leaseId: 'lease-1' });
    expect(spec.inputSchema.parse({ sessionId: 'session-1', leaseId: 'lease-1' })).toEqual({
      sessionId: 'session-1',
      leaseId: 'lease-1',
    });
    expect(() => spec.inputSchema.parse({ leaseId: 'lease-1', unexpected: true })).toThrow();
    expect(spec.outputSchema?.parse({ ok: true, released: true })).toEqual({ ok: true, released: true });
    expect(() => spec.outputSchema?.parse({ ok: true, released: true, unexpected: true })).toThrow();
  });

  it('accepts explicit execution.run.list filter fields in the action schema', () => {
    const spec = getActionSpec('execution.run.list');

    expect(
      spec.inputSchema.parse({
        sessionId: 'session_1',
        backendId: 'claude',
        status: 'running',
        limit: 5,
      }),
    ).toEqual({
      sessionId: 'session_1',
      backendId: 'claude',
      status: 'running',
      limit: 5,
    });
  });

  it('projects public execution-run actions through session RPC bindings', () => {
    const expected: readonly [ActionId, string, 'read' | 'write'][] = [
      ['execution.run.start', SESSION_RPC_METHODS.EXECUTION_RUN_START, 'write'],
      ['execution.run.list', SESSION_RPC_METHODS.EXECUTION_RUN_LIST, 'read'],
      ['execution.run.get', SESSION_RPC_METHODS.EXECUTION_RUN_GET, 'read'],
      ['execution.run.send', SESSION_RPC_METHODS.EXECUTION_RUN_SEND, 'write'],
      ['execution.run.ensure', SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, 'write'],
      ['execution.run.ensure_or_start', SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, 'write'],
      ['execution.run.stream.start', SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, 'write'],
      ['execution.run.stream.read', SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, 'read'],
      ['execution.run.stream.cancel', SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, 'write'],
      ['execution.run.stop', SESSION_RPC_METHODS.EXECUTION_RUN_STOP, 'write'],
      ['execution.run.action', SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, 'write'],
    ];

    for (const [id, rpcMethod, sideEffectClass] of expected) {
      const spec = getActionSpec(id);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.sideEffectClass).toBe(sideEffectClass);
    }

    expect(getActionSpec('execution.run.ensure_or_start').bindings?.rpcMethodAliases).toEqual([
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
    ]);
  });

  it('uses canonical execution-run response DTOs for the plugin Action projection', () => {
    expect(getActionSpec('execution.run.start').outputSchema).toBe(ExecutionRunStartResponseSchema);
    expect(getActionSpec('execution.run.list').outputSchema).toBe(ExecutionRunListResponseSchema);
    expect(getActionSpec('execution.run.get').outputSchema).toBe(ExecutionRunGetResponseSchema);
    expect(getActionSpec('execution.run.send').outputSchema).toBe(ExecutionRunSendResponseSchema);
    expect(getActionSpec('execution.run.stop').outputSchema).toBe(ExecutionRunStopResponseSchema);
    expect(getActionSpec('execution.run.stream.start').outputSchema).toBe(ExecutionRunTurnStreamStartResponseSchema);
    expect(getActionSpec('execution.run.stream.read').outputSchema).toBe(ExecutionRunTurnStreamReadResponseSchema);
    expect(getActionSpec('execution.run.stream.cancel').outputSchema).toBe(ExecutionRunTurnStreamCancelResponseSchema);
  });

  it('uses strict Action-definition envelopes for Action discovery results', () => {
    const summary = serializeActionSpec(getActionSpec('session.list'));
    const definition = actionSpecToActionDefinitionV1(getActionSpec('session.list'));

    expect(getActionSpec('action.spec.search').outputSchema.safeParse({
      actionSpecs: [summary],
      unexpected: true,
    }).success).toBe(false);
    expect(getActionSpec('action.spec.get').outputSchema.safeParse({
      actionSpec: definition,
      unexpected: true,
    }).success).toBe(false);
  });

  it('requires backendTargetKey when listing models for customAcp', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        agentId: 'customAcp',
        machineId: 'machine-1',
      }),
    ).toThrow();
  });

  it('requires backendTargetKey when listing models for a legacy configured ACP flavor carrier', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        agentId: 'acp:review-bot',
        machineId: 'machine-1',
      }),
    ).toThrow();
  });

  it('requires backendTargetKey when listing models for a nested customAcp configured ACP placeholder', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        agentId: 'acp:customAcp',
        machineId: 'machine-1',
      }),
    ).toThrow();
  });

  it('accepts a matching legacy configured ACP flavor carrier when listing models with a canonical configured backendTargetKey', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        agentId: 'acp:review-bot',
        backendTargetKey: 'backend:review-bot:configured:review-bot',
        machineId: 'machine-1',
      }),
    ).not.toThrow();
  });

  it('rejects mismatched agentId and backendTargetKey when listing models', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        agentId: 'claude',
        backendTargetKey: 'agent:codex',
        machineId: 'machine-1',
      }),
    ).toThrow();
  });

  it('rejects agent:customAcp as a backendTargetKey when listing models', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        backendTargetKey: 'agent:customAcp',
        machineId: 'machine-1',
      }),
    ).toThrow();
  });

  it('accepts canonical built-in backendTargetKey values when listing models', () => {
    const spec = getActionSpec('agents.models.list');

    expect(spec.inputSchema.parse({
      backendTargetKey: 'backend:codex',
      machineId: 'machine-1',
      limit: 10,
    })).toMatchObject({
      backendTargetKey: 'backend:codex',
      machineId: 'machine-1',
      limit: 10,
    });
  });

  it('accepts a canonical plugin backendTargetKey with an explicit runtime carrier when listing models', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        agentId: 'claude',
        backendTargetKey: 'backend:plugin-review-bot',
        machineId: 'machine-1',
      }),
    ).not.toThrow();
  });

  it('registers both friendly and namespaced slash aliases for review.start', () => {
    const spec = getActionSpec('review.start');
    expect(spec.slash?.tokens).toEqual(['/review', '/h.review']);
  });

  it('keeps review.start input hints engine-generic', () => {
    const spec = getActionSpec('review.start');
    const fieldPaths = spec.inputHints?.fields.map((field) => field.path) ?? [];

    expect(fieldPaths.filter((path) => path.startsWith('engines.'))).toEqual([]);
  });

  it('exposes execution.run.start for cli and external mcp surfaces', () => {
    const spec = getActionSpec('execution.run.start' as any);
    expect(spec.surfaces.cli).toBe(true);
    expect(spec.surfaces.mcp).toBe(true);
  });

  it('exposes execution.run.wait for cli and external mcp surfaces', () => {
    const spec = getActionSpec('execution.run.wait' as any);
    expect(spec.surfaces.cli).toBe(true);
    expect(spec.surfaces.mcp).toBe(true);
    expect(spec.bindings?.mcpToolName).toBe('execution_run_wait');
    expect(spec.inputSchema.parse({ sessionId: 'session_1', runId: 'run_1' })).toEqual({
      sessionId: 'session_1',
      runId: 'run_1',
    });
    expect(spec.inputSchema.parse({ sessionId: 'session_1', runId: 'run_1', timeoutSeconds: 7_200 })).toEqual({
      sessionId: 'session_1',
      runId: 'run_1',
      timeoutSeconds: 7_200,
    });
  });

  it('exposes session.spawn_new as an MCP tool', () => {
    const spec = getActionSpec('session.spawn_new');
    expect(spec.surfaces.mcp).toBe(true);
    expect(spec.bindings?.mcpToolName).toBe('session_spawn_new');
  });

  it('treats default as a reset sentinel only when no provider connection is selected', () => {
    const spec = getActionSpec('session.model.set');
    expect(spec.inputSchema.safeParse({
      sessionId: 'session-1',
      modelId: 'default',
      providerConnectionId: 'pc_work',
    }).success).toBe(true);
    expect(spec.inputSchema.safeParse({
      sessionId: 'session-1',
      modelId: 'default',
    }).success).toBe(true);
    expect(spec.inputSchema.safeParse({
      sessionId: 'session-1',
      modelId: 'provider-model',
      providerConnectionId: 'pc_work',
    }).success).toBe(true);
  });

  const canonicalSessionSpawnInput = {
    creationKey: 'manual:attempt-7',
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    directory: '/tmp/project',
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: {
      kind: 'agent',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    },
  } as const;

  it('accepts the exact canonical Session creation contract', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.parse(canonicalSessionSpawnInput)).toEqual(canonicalSessionSpawnInput);
  });

  it('projects canonical Session spawn placement into its public API request exactly once', () => {
    const projection = projectSessionSpawnNewApiRequest(canonicalSessionSpawnInput);

    expect(projection).toEqual({
      input: {
        creationKey: 'manual:attempt-7',
        directory: '/tmp/project',
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
      target: { kind: 'machine', machineId: 'machine-1' },
    });
    expect(PUBLIC_ACTION_INPUT_SCHEMAS['session.spawn_new'].safeParse(projection.input).success).toBe(true);
    expect(Object.hasOwn(projection.input, 'executionTarget')).toBe(false);
  });

  it('accepts a structured provider-bound model selection without flat model carriers', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse({
      ...canonicalSessionSpawnInput,
      modelSelection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    }).success).toBe(true);
  });

  it.each([
    ['flat Agent id', { agentId: 'codex' }],
    ['flat backend target key', { backendTargetKey: 'backend:codex' }],
    ['flat model selection', { modelId: 'provider-model', providerConnectionId: 'pc_work' }],
    ['legacy backend transport', { backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } }],
    ['legacy runtime carrier', { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } }],
    ['flat machine target', { machineId: 'machine-2' }],
    ['legacy path', { path: '/other/project' }],
    ['host assertion', { host: 'machine-1.local' }],
  ] as const)('rejects retired Session spawn ingress: %s', (_label, legacyField) => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse({ ...canonicalSessionSpawnInput, ...legacyField }).success).toBe(false);
  });

  it.each([
    ['execution target', { ...canonicalSessionSpawnInput, executionTarget: undefined }],
    ['directory', { ...canonicalSessionSpawnInput, directory: undefined }],
    ['Agent target', { ...canonicalSessionSpawnInput, agentTarget: undefined }],
  ] as const)('requires canonical %s for Session creation', (_label, input) => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse(input).success).toBe(false);
  });

  it('advertises dynamic option sources for rich session.spawn_new fields', () => {
    const spec = getActionSpec('session.spawn_new');
    const fieldsByPath = new Map((spec.inputHints?.fields ?? []).map((field) => [field.path, field]));

    expect(fieldsByPath.get('agentTarget')).toMatchObject({
      optionsSourceId: 'agents.backends.enabled',
    });
    expect(fieldsByPath.get('modelSelection')).toMatchObject({
      optionsSourceId: 'agents.models.available',
    });
    expect(fieldsByPath.get('agentModeId')).toMatchObject({
      optionsSourceId: 'agents.session_modes.available',
    });
    expect(fieldsByPath.get('configuration')).toMatchObject({
      optionsSourceId: 'agents.config_options.available',
    });
    expect(fieldsByPath.get('directory')).toMatchObject({
      optionsSourceId: 'sessions.spawn.paths.recent',
    });
    expect(fieldsByPath.get('executionTarget.machineId')).toMatchObject({
      optionsSourceId: 'sessions.spawn.machines.available',
    });
    expect(fieldsByPath.get('executionTarget.serverId')).toMatchObject({
      optionsSourceId: 'sessions.spawn.servers.available',
    });
    expect(fieldsByPath.get('profileId')).toMatchObject({
      optionsSourceId: 'sessions.spawn.profiles.available',
    });
    expect(fieldsByPath.get('connectedServices')).toMatchObject({
      optionsSourceId: 'sessions.spawn.connected_services.available',
    });
    expect(fieldsByPath.get('mcpSelection')).toMatchObject({
      optionsSourceId: 'sessions.spawn.mcp_servers.preview',
    });
    expect(fieldsByPath.has('backendTargetKey')).toBe(false);
    expect(fieldsByPath.has('modelId')).toBe(false);
    expect(fieldsByPath.has('path')).toBe(false);
    expect(fieldsByPath.has('machineId')).toBe(false);
  });

  it.each([
    'paths.list_recent',
    'machines.list',
    'servers.list',
    'agents.config_options.list',
    'agents.session_modes.list',
    'sessions.spawn.profiles.list',
    'sessions.spawn.connected_services.list',
    'sessions.spawn.mcp_servers.preview',
  ] as const)('surfaces %s for agent spawn option discovery', (actionId) => {
    const spec = getActionSpec(actionId as any);
    expect(spec.surfaces.agent).toBe(true);
  });

  it('does not expose legacy voice_mediator intent in ExecutionRunIntentSchema', () => {
    expect(ExecutionRunIntentSchema.safeParse('voice_agent').success).toBe(true);
    expect(ExecutionRunIntentSchema.safeParse('voice_mediator').success).toBe(false);
  });

  it('binds global voice reset to resetGlobalVoiceAgent', () => {
    const spec = getActionSpec('ui.voice_global.reset');
    expect(spec.bindings?.voiceClientToolName).toBe('resetGlobalVoiceAgent');
  });

  it('binds voice teleport to teleportVoiceAgentToSessionRoot', () => {
    const spec = getActionSpec('ui.voice_agent.teleport');
    expect(spec.bindings?.voiceClientToolName).toBe('teleportVoiceAgentToSessionRoot');
    expect(spec.surfaces.voice).toBe(true);
    expect(spec.surfaces.voice).toBe(true);
  });

  it('exposes memory action specs', () => {
    const spec = getActionSpec('memory.search');
    expect(spec.id).toBe('memory.search');
    expect(spec.surfaces.voice).toBe(true);
  });

  it('exposes session fork action spec', () => {
    const spec = getActionSpec('session.fork');
    expect(spec.id).toBe('session.fork');
    expect(spec.surfaces.ui).toBe(true);
    expect(spec.placements).toContain('session_action_menu');
  });

  it('exposes session rollback action spec', () => {
    const spec = getActionSpec('session.rollback' as any);
    expect(spec.id).toBe('session.rollback');
    expect(spec.surfaces.ui).toBe(true);
    expect(spec.surfaces.rpc).toBe(true);
    expect(spec.placements).toEqual([]);
  });

  it('exposes checkpoint code rollback through RPC without raw menu placement', () => {
    const spec = getActionSpec('session.checkpoint_code_rollback' as any);

    expect(spec.id).toBe('session.checkpoint_code_rollback');
    expect(spec.surfaces.ui).toBe(true);
    expect(spec.surfaces.rpc).toBe(true);
    expect(spec.placements).toEqual([]);
    expect(spec.safety).toBe('danger');
    expect(spec.bindings?.rpcMethod).toBe('session.checkpointCodeRollback');
    expect(spec.inputSchema.safeParse({
      v: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd: '/repo',
      codeMode: 'code_only_without_stash',
      backupMode: 'happier_checkpoint_only',
      expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
      expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
      codeOnlyTranscriptDivergenceConfirmed: true,
    }).success).toBe(true);
    expect(spec.inputSchema.safeParse({
      v: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd: '/repo',
      codeMode: 'conversation_and_code_without_stash',
      backupMode: 'happier_checkpoint_only',
      expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
      expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
    }).success).toBe(false);
  });

  it('exposes product checkpoint and restore as source-qualified lifecycle actions', () => {
    const checkpoint = getActionSpec('session.checkpoint' as any);
    const restore = getActionSpec('session.restore' as any);

    expect(checkpoint.bindings?.rpcMethod).toBe('session.checkpoint');
    expect(restore.bindings?.rpcMethod).toBe('session.restore');
    expect(checkpoint.surfaces.ui).toBe(true);
    expect(restore.surfaces.ui).toBe(true);
    expect(checkpoint.surfaces.rpc).toBe(true);
    expect(restore.surfaces.rpc).toBe(true);
    expect(checkpoint.placements).toEqual([]);
    expect(restore.placements).toEqual([]);
    expect(checkpoint.safety).toBe('danger');
    expect(restore.safety).toBe('danger');
    expect(restore.inputSchema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: {
        sourceChoiceConfirmed: true,
      },
    }).success).toBe(true);
    expect(restore.inputSchema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      checkpointId: 'checkpoint-1',
    }).success).toBe(false);
  });

  it('declares terminal composer clear as a confirmed destructive session-control action', () => {
    const spec = getActionSpec('session.terminalComposer.clear' as any);

    expect(spec.inputSchema).toBe((protocol as any).SessionTerminalComposerClearRequestV1Schema);
    expect(spec.outputSchema).toBe((protocol as any).SessionTerminalComposerClearResultV1Schema);
    expect(spec.bindings?.rpcMethod).toBe((SESSION_RPC_METHODS as any).SESSION_TERMINAL_COMPOSER_CLEAR);
    expect(spec.bindings?.mcpToolName).toBe('session_terminal_composer_clear');
    expect(spec.safety).toBe('danger');
    expect(spec.sideEffectClass).toBe('danger');
    expect(spec.approval.result).toBe('required');
    expect(spec.surfaces.ui).toBe(true);
    expect(spec.surfaces.agent).toBe(false);
    expect(spec.surfaces.mcp).toBe(true);
    expect(spec.surfaces.cli).toBe(true);
    expect(spec.surfaces.rpc).toBe(true);
    expect(spec.placements).toEqual(['pending_messages']);
    expect(spec.inputHints?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sessionId', required: true }),
      expect.objectContaining({ path: 'expectedStateAtMs' }),
    ]));
  });

  it('declares exact contextual defaults without inferring identifier semantics from field names', () => {
    expect(getActionContextualDefaults('session.terminalComposer.clear')).toEqual({
      sessionId: 'current_session',
    });
    expect(getActionContextualDefaults('review.start')).toEqual({ sessionId: 'current_session' });
    expect(getActionContextualDefaults('memory.search')).toEqual({
      machineId: 'current_session_machine',
    });
    expect(getActionContextualDefaults('memory.get_window')).toEqual({
      machineId: 'current_session_machine',
    });
    expect(getActionContextualDefaults('session.list')).toBeNull();
    expect(getActionContextualDefaults('not.real.action')).toBeNull();
  });

  it('exposes session open action spec', () => {
    const spec = getActionSpec('session.open');
    expect(spec.id).toBe('session.open');
    expect(spec.surfaces.ui).toBe(true);
    expect(spec.placements).toContain('command_palette');
    expect(spec.placements).toContain('session_info');
  });

  it('binds session lifecycle RPC wire methods to ActionSpec rows', () => {
    const expectedBindings = new Map([
      ['session.stop', 'stop-session'],
      ['session.fork', 'session.fork'],
      ['session.continue_with_replay', 'session.continueWithReplay'],
      ['session.rollback', 'session.rollback'],
      ['session.checkpoint_code_rollback', 'session.checkpointCodeRollback'],
      ['session.checkpoint', 'session.checkpoint'],
      ['session.restore', 'session.restore'],
      ['session.handoff', 'daemon.sessionHandoff.start'],
      ['session.handoff.prepare_target', 'daemon.sessionHandoff.prepareTarget'],
      ['session.handoff.prepare_target.resume', 'daemon.sessionHandoff.prepareTarget.resume'],
      ['session.handoff.prepare_target_result.get', 'daemon.sessionHandoff.prepareTargetResult.get'],
      ['session.handoff.commit', 'daemon.sessionHandoff.commit'],
      ['session.handoff.abort', 'daemon.sessionHandoff.abort'],
      ['session.handoff.status.get', 'daemon.sessionHandoff.status.get'],
      ['session.spawn_new', RPC_METHODS.SESSION_SPAWN_NEW],
    ]);

    for (const [actionId, rpcMethod] of expectedBindings) {
      const spec = getActionSpec(actionId as any);

      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
    }

    expect(getActionSpec('session.spawn_new').surfaceBindings?.rpc).toBeDefined();
  });

  it('binds prepare-target result-get output to its bounded shared response schema', () => {
    const spec = getActionSpec('session.handoff.prepare_target_result.get' as ActionId);

    expect(spec.outputSchema).toBe(protocol.SessionHandoffPrepareTargetResultGetResponseSchema);
    expect(spec.outputSchema.parse({
      ok: false,
      errorCode: 'target_identity_conflict',
      error: 'The native handoff target conflicts with the exported session identity',
    })).toEqual({
      ok: false,
      errorCode: 'target_identity_conflict',
      error: 'The native handoff target conflicts with the exported session identity',
    });
    expect(spec.outputSchema.safeParse({
      ok: false,
      errorCode: 'target_import_failed',
      error: 'generic failure must not enter this bounded seam',
    }).success).toBe(false);
    expect(spec.outputSchema.parse({
      ok: false,
      errorCode: 'not_found',
    })).toEqual({
      ok: false,
      errorCode: 'not_found',
    });
    expect(spec.outputSchema.parse({
      ok: false,
      errorCode: 'awaiting_recovery',
      error: 'Prepare-target job is awaiting_recovery',
    })).toEqual({
      ok: false,
      errorCode: 'awaiting_recovery',
      error: 'Prepare-target job is awaiting_recovery',
    });
  });

  it('binds session permission RPC wire methods to existing ActionSpec rows', () => {
    const expectedBindings = new Map([
      ['session.permission.respond', 'session.permission.respond'],
      ['session.user_action.answer', 'session.user_action.answer'],
      ['session.permission_mode.set', 'session.permission_mode.set'],
    ]);

    for (const [actionId, rpcMethod] of expectedBindings) {
      const spec = getActionSpec(actionId as any);

      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
    }
  });

  it('treats approval decisions as danger-class actions', () => {
    const spec = getActionSpec('approval.request.decide');
    expect(spec.safety).toBe('danger');
  });

  it('exposes prompt library mutation actions for approval workflows', () => {
    expect(getActionSpec('prompt_doc.update').safety).toBe('danger');
    expect(getActionSpec('prompt_bundle.update').safety).toBe('danger');
    expect(getActionSpec('prompt_asset.export').safety).toBe('danger');
    expect(getActionSpec('prompt_registry.install').safety).toBe('danger');
  });

  it('binds daemon administrative RPC methods to ActionSpec rows', () => {
    const expectedBindings = new Map([
      ['daemon.promptAssets.discover', RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER],
      ['daemon.promptAssets.delete', RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE],
      ['daemon.promptRegistry.scanSource', RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE],
      ['daemon.promptRegistry.install', RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL],
      ['daemon.filesystem.readFile', RPC_METHODS.READ_FILE],
      ['daemon.filesystem.writeFile', RPC_METHODS.WRITE_FILE],
      ['daemon.filesystem.listDirectory', RPC_METHODS.LIST_DIRECTORY],
      ['daemon.filesystem.getDirectoryTree', RPC_METHODS.GET_DIRECTORY_TREE],
      ['daemon.filesystem.listRoots', RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS],
      ['daemon.filesystem.browseDirectory', RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY],
      ['bugreport.collectDiagnostics', RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS],
      ['bugreport.getLogTail', RPC_METHODS.BUGREPORT_GET_LOG_TAIL],
      ['bugreport.uploadArtifact', RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT],
    ]);

    for (const [actionId, rpcMethod] of expectedBindings) {
      const spec = getActionSpec(actionId as ActionId);

      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.bindings?.rpcMethod).toBe(rpcMethod);
      expect(spec.surfaces.mcp).toBe(false);
      expect(spec.surfaces.api).toBe(true);
    }
  });

  it('accepts installMode for prompt asset export and registry install actions', () => {
    const exportParsed = getActionSpec('prompt_asset.export').inputSchema.parse({
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'agents.skill',
      scope: 'project',
      directory: '/tmp/project',
      targetName: 'reviewer',
      installMode: 'symlink',
    });
    const registryParsed = getActionSpec('prompt_registry.install').inputSchema.parse({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:web-design-guidelines',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'reviewer',
        installMode: 'symlink',
      },
    });

    expect((exportParsed as any).installMode).toBe('symlink');
    expect((registryParsed as any).installTarget?.installMode).toBe('symlink');
  });

  it('provides input hints for every ActionSpec (single source of truth for elicitation)', () => {
    for (const spec of listActionSpecs()) {
      expect((spec as any).inputHints).toBeTruthy();
      expect(Array.isArray((spec as any).inputHints?.fields)).toBe(true);
    }
  });

  it('validates ActionSpec inputHints when present', () => {
    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        approval: { result: 'optional', flow: 'deferred' },
        placements: [],
        surfaces: {
          ui: true,
          voice: true,
          agent: false,
          mcp: true,
          cli: true,
          rpc: false,
          api: false,
          plugin: false,
        },
        bindings: { mcpToolName: 'review_start' },
        outputSchema: z.unknown(),
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'engineIds',
              title: 'Engines',
              widget: 'not-a-widget',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('accepts disabled static options in input hints', () => {
    const parsed = ActionSpecSchema.parse({
      id: 'review.start',
      title: 'Start review',
      safety: 'safe',
      approval: { result: 'optional', flow: 'deferred' },
      placements: [],
      surfaces: {
        ui: true,
        voice: true,
        agent: false,
        mcp: true,
        cli: true,
        rpc: false,
        api: false,
        plugin: false,
      },
      bindings: { mcpToolName: 'review_start' },
      outputSchema: z.unknown(),
      inputSchema: z.object({}).strict(),
      inputHints: {
        fields: [
          {
            path: 'engineId',
            title: 'Engine',
            widget: 'select',
            options: [
              { value: 'codex', label: 'Codex' },
              { value: 'legacy', label: 'Legacy', disabled: true },
            ],
          },
        ],
      },
    });

    expect(parsed.inputHints?.fields[0]?.options).toEqual([
      { value: 'codex', label: 'Codex' },
      { value: 'legacy', label: 'Legacy', disabled: true },
    ]);
  });

  it('accepts JSON object fields in input hints', () => {
    const parsed = ActionSpecSchema.parse({
      id: 'session.spawn_new',
      title: 'Create session',
      safety: 'safe',
      approval: { result: 'none' },
      placements: [],
      surfaces: {
        ui: true,
        voice: true,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
        api: false,
        plugin: false,
      },
      bindings: { mcpToolName: 'session_spawn_new' },
      outputSchema: z.unknown(),
      inputSchema: z.object({}).passthrough(),
      inputHints: {
        fields: [
          {
            path: 'sessionConfigOptionOverrides',
            title: 'Config option overrides',
            widget: 'json',
          },
        ],
      },
    });

    expect(parsed.inputHints?.fields[0]?.widget).toBe('json');
  });

  it('retains canonical dynamic option sources for non-select rich fields', () => {
    expect(ActionInputHintsSchema.parse({
      fields: [{
        path: 'sessionConfigOptionOverrides',
        title: 'Config option overrides',
        widget: 'json',
        optionsSourceId: 'agents.config_options.available',
      }],
    })).toMatchObject({
      fields: [{ optionsSourceId: 'agents.config_options.available' }],
    });
  });

  it('describes structured user-action answers through one JSON leaf field', () => {
    const fields = getActionSpec('session.user_action.answer').inputHints?.fields ?? [];

    expect(fields.find((field) => field.path === 'answers')).toMatchObject({
      widget: 'json',
    });
    expect(fields.some((field) => field.path.startsWith('answers.'))).toBe(false);
  });

  it('requires select/multiselect hints to declare options or optionsSourceId', () => {
    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        approval: { result: 'optional', flow: 'deferred' },
        placements: [],
        surfaces: {
          ui: true,
          voice: true,
          agent: false,
          mcp: true,
          cli: true,
          rpc: false,
          api: false,
          plugin: false,
        },
        bindings: { mcpToolName: 'review_start' },
        outputSchema: z.unknown(),
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'x',
              title: 'X',
              widget: 'select',
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        approval: { result: 'optional', flow: 'deferred' },
        placements: [],
        surfaces: {
          ui: true,
          voice: true,
          agent: false,
          mcp: true,
          cli: true,
          rpc: false,
          api: false,
          plugin: false,
        },
        bindings: { mcpToolName: 'review_start' },
        outputSchema: z.unknown(),
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'x',
              title: 'X',
              widget: 'multiselect',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('requires text_list hints to declare a listSeparator', () => {
    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        approval: { result: 'optional', flow: 'deferred' },
        placements: [],
        surfaces: {
          ui: true,
          voice: true,
          agent: false,
          mcp: true,
          cli: true,
          rpc: false,
          api: false,
          plugin: false,
        },
        bindings: { mcpToolName: 'review_start' },
        outputSchema: z.unknown(),
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'x',
              title: 'X',
              widget: 'text_list',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('provides input hints for intent start actions surfaced as drafts', () => {
    const plan = getActionSpec('subagents.plan.start');
    const delegate = getActionSpec('subagents.delegate.start');

    expect(plan.surfaces.ui).toBe(true);
    expect(delegate.surfaces.ui).toBe(true);

    const planFields = (plan as any).inputHints?.fields ?? null;
    const delegateFields = (delegate as any).inputHints?.fields ?? null;

    expect(Array.isArray(planFields)).toBe(true);
    expect(Array.isArray(delegateFields)).toBe(true);

    expect(planFields.map((f: any) => f.path)).toContain('backendTargetKeys');
    expect(planFields.map((f: any) => f.path)).toContain('instructions');
    expect(delegateFields.map((f: any) => f.path)).toContain('backendTargetKeys');
    expect(delegateFields.map((f: any) => f.path)).toContain('instructions');
    expect(planFields.find((f: any) => f.path === 'backendTargetKeys')?.maxSelections).toBe(1);
    expect(delegateFields.find((f: any) => f.path === 'backendTargetKeys')?.maxSelections).toBe(1);
    expect((getActionSpec('voice_agent.start') as any).inputHints?.fields?.find((f: any) => f.path === 'backendTargetKeys')?.maxSelections).toBe(1);
  });

  it('describes backendTargetKeys as provider/backend selection, not parallel capacity', () => {
    const plan = getActionSpec('subagents.plan.start');
    const delegate = getActionSpec('subagents.delegate.start');
    const voiceAgent = getActionSpec('voice_agent.start');

    const planText = [
      plan.inputHints?.description ?? '',
      ...(plan.inputHints?.fields ?? []).map((field) => field.description ?? ''),
    ].join(' ');
    const delegateText = [
      delegate.inputHints?.description ?? '',
      ...(delegate.inputHints?.fields ?? []).map((field) => field.description ?? ''),
    ].join(' ');
    const voiceText = [
      voiceAgent.inputHints?.description ?? '',
      ...(voiceAgent.inputHints?.fields ?? []).map((field) => field.description ?? ''),
    ].join(' ');

    for (const text of [planText, delegateText, voiceText]) {
      expect(text).toContain('provider/backend');
      expect(text).toContain('not parallelism capacity');
      expect(text).not.toContain('Each backend runs as its own execution run');
    }
  });

  it('defaults delegate start permission mode to workspace_write', () => {
    const spec = getActionSpec('subagents.delegate.start');
    const parsed = (spec.inputSchema as any).parse({
      backendTargetKeys: ['agent:codex'],
      instructions: 'Do it.',
    });
    expect(parsed.permissionMode).toBe('workspace_write');
  });

  it('advertises and validates the canonical delegate permission modes at the tool boundary', () => {
    const spec = getActionSpec('subagents.delegate.start');
    const baseInput = {
      backendTargetKeys: ['agent:pi'],
      instructions: 'Do it.',
    };

    for (const permissionMode of ['read_only', 'default', 'workspace_write', 'yolo']) {
      const parsed = (spec.inputSchema as z.ZodTypeAny).safeParse({ ...baseInput, permissionMode });
      expect(parsed.success, permissionMode).toBe(true);
    }

    const invalid = (spec.inputSchema as z.ZodTypeAny).safeParse({
      ...baseInput,
      permissionMode: 'workspace_read',
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]?.path).toEqual(['permissionMode']);
      expect(invalid.error.issues[0]?.message).toContain('read_only');
      expect(invalid.error.issues[0]?.message).toContain('workspace_write');
    }

    const permissionModeHint = spec.inputHints?.fields.find((field) => field.path === 'permissionMode');
    expect(permissionModeHint?.description).toContain('read_only | default | workspace_write | yolo');
  });

  it('projects subagent registry actions through ActionSpec RPC bindings', () => {
    const expected = [
      'sessions.subagents.list',
      'sessions.subagents.get',
      'sessions.subagents.watch',
      'sessions.subagents.upsert',
      'sessions.subagents.updateStatus',
      'sessions.subagents.complete',
    ] as const;
    const publicSubagentActionIds = new Set([
      'sessions.subagents.list',
      'sessions.subagents.get',
      'sessions.subagents.watch',
    ]);

    for (const id of expected) {
      const spec = getActionSpec(id);
      const publicProjection = publicSubagentActionIds.has(id);
      expect(spec.bindings?.rpcMethod).toBe(id);
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.surfaces.api).toBe(publicProjection);
      expect(spec.surfaces.plugin).toBe(publicProjection);
    }

    expect(getActionSpec('sessions.subagents.list').inputSchema.parse({
      parentSessionId: 'session-1',
      groupId: 'group-1',
    })).toEqual({
      parentSessionId: 'session-1',
      groupId: 'group-1',
    });
    expect(getActionSpec('sessions.subagents.upsert').inputSchema.parse({
      id: 'subagent-1',
      parentSessionId: 'session-1',
      origin: 'plugin',
      kind: 'custom',
    })).toMatchObject({
      id: 'subagent-1',
      parentSessionId: 'session-1',
      origin: 'plugin',
      kind: 'custom',
    });
  });

  it('defaults voice agent start to long-lived streaming', () => {
    const spec = getActionSpec('voice_agent.start');
    const parsed = (spec.inputSchema as any).parse({
      backendTargetKeys: ['agent:codex'],
      instructions: 'Voice.',
    });
    expect(parsed.runClass).toBe('long_lived');
    expect(parsed.ioMode).toBe('streaming');
  });

	  it('filters action specs by surfaced availability', () => {
	    expect(isActionSpecSurfacedOn(getActionSpec('session.mode.set'), 'voice')).toBe(true);
	    expect(isActionSpecSurfacedOn(getActionSpec('session.mode.set'), 'mcp')).toBe(true);
	    expect(listActionSpecsForSurface('mcp').some((spec) => spec.id === 'session.mode.set')).toBe(true);
	    expect(listActionSpecsForSurface('voice').some((spec) => spec.id === 'session.mode.set')).toBe(true);
	  });

  it('derives the voice prompt hot-path inventory from ActionSpec metadata', () => {
    const hotPathIds = listVoicePromptHotPathSpecs().map((spec) => spec.id);

    expect(hotPathIds).toContain('action.spec.search');
    expect(hotPathIds).toContain('session.mode.set');
    expect(hotPathIds).toContain('subagents.plan.start');
    expect(hotPathIds).toContain('subagents.delegate.start');
    expect(hotPathIds).not.toContain('memory.get_window');
  });

  it('exposes core voice session controls as voice surfaces', () => {
    const all = listActionSpecs();
    const byVoiceToolName = new Map(
      all
        .filter((spec) => spec.surfaces.voice && Boolean(spec.bindings?.voiceClientToolName))
        .map((spec) => [spec.bindings!.voiceClientToolName!, spec] as const),
    );

    // Baseline expectations: these must exist so local voice and realtime voice can share one tool surface.
    expect(byVoiceToolName.has('sendSessionMessage')).toBe(true);
    // Voice can describe pending permissions, but the canonical approval UI is
    // the only authority that may answer them.
    expect(byVoiceToolName.has('processPermissionRequest')).toBe(false);
    expect(byVoiceToolName.has('answerUserActionRequest')).toBe(true);
    expect(byVoiceToolName.has('setPrimaryActionSession')).toBe(true);
    expect(byVoiceToolName.has('setTrackedSessions')).toBe(true);
    expect(byVoiceToolName.has('listSessions')).toBe(true);
    expect(byVoiceToolName.has('getSessionActivity')).toBe(true);
    expect(byVoiceToolName.has('getSessionTranscript')).toBe(true);
    expect(byVoiceToolName.has('getSessionRecentMessages')).toBe(false);
    expect(byVoiceToolName.has('teleportVoiceAgentToSessionRoot')).toBe(true);

    // Inventory + discovery tools (safe by default; may be gated by user settings in the UI).
    expect(byVoiceToolName.has('spawnSessionPicker')).toBe(false);
    expect(byVoiceToolName.has('listRecentPaths')).toBe(true);
    expect(byVoiceToolName.has('listMachines')).toBe(true);
    expect(byVoiceToolName.has('listServers')).toBe(true);
    expect(byVoiceToolName.has('listReviewEngines')).toBe(true);
    expect(byVoiceToolName.has('listAgentBackends')).toBe(true);
    expect(byVoiceToolName.has('listAgentModels')).toBe(true);
  });

  it('classifies every provider-reachable voice tool at the canonical ActionSpec owner', () => {
    const unclassified = listActionSpecs()
      .filter((spec) => spec.surfaces.voice && Boolean(spec.bindings?.voiceClientToolName))
      .filter((spec) => spec.sideEffectClass === undefined)
      .map((spec) => spec.id);

    expect(unclassified).toEqual([]);
  });

  it('derives Voice SDK safety solely from the Action side-effect class', () => {
    expectTypeOf(isVoiceSdkSafeActionSpec)
      .parameter(0)
      .toEqualTypeOf<Pick<ActionSpec, 'sideEffectClass'>>();
    expect(isVoiceSdkSafeActionSpec({ sideEffectClass: 'none' })).toBe(true);
    expect(isVoiceSdkSafeActionSpec({ sideEffectClass: 'read' })).toBe(true);
    expect(isVoiceSdkSafeActionSpec({ sideEffectClass: 'write' })).toBe(false);
    expect(isVoiceSdkSafeActionSpec({ sideEffectClass: 'external' })).toBe(false);
    expect(isVoiceSdkSafeActionSpec({ sideEffectClass: 'danger' })).toBe(false);
  });

  it('derives Voice prompt hot-path membership solely from prompting metadata', () => {
    expectTypeOf(isVoicePromptHotPathSpec)
      .parameter(0)
      .toEqualTypeOf<Pick<ActionSpec, 'prompting'>>();
    expect(isVoicePromptHotPathSpec({ prompting: { voiceHotPath: true } })).toBe(true);
    expect(isVoicePromptHotPathSpec({ prompting: { voiceHotPath: false } })).toBe(false);
  });

  it('uses concrete schema-shaped voice args examples for all voice surfaces', () => {
    const placeholderFragments = ['...optional...', '"..."', 'allow|deny', '...|null'];

    for (const spec of listActionSpecs().filter((entry) => entry.surfaces.voice || entry.surfaces.voice)) {
      const argsExample = spec.examples?.voice?.argsExample;
      expect(typeof argsExample).toBe('string');
      const exampleText = String(argsExample ?? '').trim();
      expect(exampleText.length).toBeGreaterThan(0);
      for (const fragment of placeholderFragments) {
        expect(exampleText).not.toContain(fragment);
      }

      const parsedJson = JSON.parse(exampleText);
      expect((spec.inputSchema as any).safeParse(parsedJson).success).toBe(true);
    }
  });
});
