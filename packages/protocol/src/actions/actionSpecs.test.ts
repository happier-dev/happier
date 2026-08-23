import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ExecutionRunIntentSchema } from '../executionRuns.js';
import {
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
} from '../sessionWorkState/sessionWorkStateRpc.js';
import { serializeActionSpec } from './actionCatalog.js';
import { ActionApprovalSchema, ActionOperationDeclarationV1Schema, ActionSpecSchema, ActionSurfaceSchema, getActionSpec, isActionSpecSurfacedOn, listActionSpecs, listActionSpecsForSurface, listVoicePromptHotPathSpecs, resolveActionApprovalFlow } from './actionSpecs.js';

const RESULT_REQUIRED_BLOCKING_ACTION_IDS = [
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  'execution.run.list',
  'execution.run.get',
  'execution.run.wait',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  'session.list',
  'session.activity.get',
  'session.messages.recent.get',
  'agents.backends.list',
  'agents.models.list',
  'agents.session_modes.list',
  'agents.config_options.list',
  'sessions.spawn.profiles.list',
  'sessions.spawn.connected_services.list',
  'sessions.spawn.mcp_servers.preview',
  'paths.list_recent',
  'machines.list',
  'servers.list',
  'review.engines.list',
  'memory.search',
  'memory.get_window',
  'memory.ensure_up_to_date',
] as const;

const RESULT_NONE_DEFERRED_ACTION_IDS = [
  'prompt_doc.update',
  'prompt_bundle.update',
  'prompt_asset.export',
  'prompt_registry.install',
  'session.title.set',
  'session.permission_mode.set',
  'session.model.set',
  'session.goal.set',
  'session.goal.clear',
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
  'session.archive',
  'session.unarchive',
  'session.stop',
  'ui.voice_global.reset',
  'ui.pet.choose',
  'approval.request.create',
  'approval.request.decide',
] as const;

const RESULT_OPTIONAL_DEFERRED_ACTION_IDS = [
  'review.start',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'execution.run.start',
  'execution.run.send',
  'execution.run.stop',
  'execution.run.action',
  'session.open',
  'session.fork',
  'session.rollback',
  'session.handoff',
  'session.spawn_new',
  'session.spawn_picker',
  'session.message.send',
  'session.permission.respond',
  'session.user_action.answer',
  'session.mode.set',
  'session.target.primary.set',
  'session.target.tracked.set',
  'ui.voice_agent.teleport',
] as const;

const EXTERNALLY_CONTROLLABLE_SESSION_AGENT_UNSUPPORTED_ACTIONS = {
  'voice_agent.start': 'voice-agent launches are a separate user-facing runtime surface, not an in-session self-control primitive.',
  'execution.run.get': 'execution run reads are available through session-scoped run list/wait/status paths; direct external get remains outside session-agent by policy.',
  'session.spawn_picker': 'the interactive spawn picker remains UI/external-client only; in-session agents use session.spawn_new.',
  'session.terminalComposer.clear': 'clearing a human terminal composer is an explicit human/UI decision.',
  'session.pendingInput.interruptAndRun': 'interrupting a human-visible live provider turn is an explicit human/UI decision.',
  'session.target.primary.set': 'target-state mutation changes the human-visible workspace target and stays external by default.',
  'session.target.tracked.set': 'target-state mutation changes tracked workspace state and stays external by default.',
  'approval.request.decide': 'agents must not approve or reject approval requests on their own behalf.',
} as const satisfies Record<string, string>;

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('Action Spec Registry', () => {
  it('supports session_agent as an action surface', () => {
    const parsed = ActionSurfaceSchema.parse({
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: false,
      cli: false,
      session_agent: true,
    });

    expect(parsed.session_agent).toBe(true);
  });

  it('exposes stable action specs', () => {
    const all = listActionSpecs();
    expect(all.length).toBeGreaterThan(0);
    for (const spec of all) {
      // Runtime safety: registry objects must validate against the schema.
      ActionSpecSchema.parse(spec);
    }
  });

  it('keeps externally controllable actions hidden from session_agent only by explicit catalog policy', () => {
    const hiddenButExternallyControllable = listActionSpecs()
      .filter((spec) => !spec.surfaces.session_agent && (spec.surfaces.mcp || spec.surfaces.cli))
      .map((spec) => spec.id);

    expect(sorted(hiddenButExternallyControllable)).toEqual(sorted(
      Object.keys(EXTERNALLY_CONTROLLABLE_SESSION_AGENT_UNSUPPORTED_ACTIONS),
    ));
    for (const actionId of hiddenButExternallyControllable) {
      expect(EXTERNALLY_CONTROLLABLE_SESSION_AGENT_UNSUPPORTED_ACTIONS[actionId]).toEqual(expect.any(String));
      expect(EXTERNALLY_CONTROLLABLE_SESSION_AGENT_UNSUPPORTED_ACTIONS[actionId]?.length).toBeGreaterThan(20);
    }
  });

  it('validates direct tool exposure metadata when action specs declare it', () => {
    const spec = getActionSpec('subagents.delegate.start');
    const parsed = ActionSpecSchema.parse({
      ...spec,
      toolExposure: {
        session_agent: 'discoverable_only',
        mcp: 'direct',
        cli: 'direct',
      },
    });

    expect(parsed.toolExposure).toEqual({
      session_agent: 'discoverable_only',
      mcp: 'direct',
      cli: 'direct',
    });
    expect(serializeActionSpec(parsed).toolExposure).toEqual(parsed.toolExposure);

    expect(ActionSpecSchema.safeParse({
      ...spec,
      toolExposure: {
        session_agent: 'hidden',
      },
    }).success).toBe(false);
  });

  it('accepts only the exact v1 tracked-operation declaration', () => {
    expect(ActionOperationDeclarationV1Schema.parse({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
    })).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
    });
    expect(ActionOperationDeclarationV1Schema.safeParse({
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
    }).success).toBe(true);

    for (const malformed of [
      { version: 2, visibility: 'activity', progress: 'reported' },
      { version: 1, visibility: 'private', progress: 'reported' },
      { version: 1, visibility: 'activity', progress: 'synthetic' },
      { version: 1, visibility: 'activity', progress: 'reported', terminalize: true },
    ]) {
      expect(ActionOperationDeclarationV1Schema.safeParse(malformed).success).toBe(false);
    }
  });

  it('declares and serializes the tracked core session actions', () => {
    const expected = {
      'session.fork': { version: 1, visibility: 'activity', progress: 'indeterminate' },
      'session.spawn_new': { version: 1, visibility: 'activity', progress: 'reported' },
      'session.handoff': { version: 1, visibility: 'activity', progress: 'reported' },
    } as const;

    for (const [actionId, operation] of Object.entries(expected)) {
      const spec = getActionSpec(actionId as keyof typeof expected);
      expect(spec.operation).toEqual(operation);
      expect(serializeActionSpec(spec).operation).toEqual(operation);
    }

    expect(getActionSpec('session.rollback').operation).toBeUndefined();
    expect(serializeActionSpec(getActionSpec('session.rollback')).operation).toBeNull();
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
      const flow = resolveActionApprovalFlow(spec.approval);
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

  it('uses default blocking flow for result-required approval metadata', () => {
    const parsed = ActionApprovalSchema.parse({ result: 'required' });

    expect(parsed.flow).toBeUndefined();
    expect(getActionSpec('session.list').approval).toEqual({ result: 'required' });
  });

  it('uses default deferred flow for no-result approval metadata', () => {
    const parsed = ActionApprovalSchema.parse({ result: 'none' });

    expect(parsed.flow).toBeUndefined();
    expect(getActionSpec('session.title.set').approval).toEqual({ result: 'none' });
  });

  it('requires optional-result approval metadata to declare an explicit flow', () => {
    expect(() => ActionApprovalSchema.parse({ result: 'optional' })).toThrow();
    expect(ActionApprovalSchema.parse({ result: 'optional', flow: 'deferred' })).toEqual({
      result: 'optional',
      flow: 'deferred',
    });
  });

  it('serializes approval metadata in action catalog entries', () => {
    const serialized = serializeActionSpec(getActionSpec('session.list'));

    expect(serialized.approval).toEqual({ result: 'required' });
  });

  it('finds known action specs by id', () => {
    const spec = getActionSpec('execution.run.list');
    expect(spec.id).toBe('execution.run.list');
    expect(spec.surfaces.voice_tool).toBe(true);
  });

  it('surfaces action discovery tools on both session_agent and external mcp', () => {
    const spec = getActionSpec('action.spec.search');
    expect(spec.surfaces.session_agent).toBe(true);
    expect(spec.surfaces.mcp).toBe(true);
  });

  it('surfaces session targeting + listing tools on external mcp', () => {
    expect(getActionSpec('session.target.primary.set').surfaces.mcp).toBe(true);
    expect(getActionSpec('session.target.tracked.set').surfaces.mcp).toBe(true);
    expect(getActionSpec('session.list').surfaces.mcp).toBe(true);
    expect(getActionSpec('session.activity.get').surfaces.mcp).toBe(true);
    expect(getActionSpec('session.transcript.get').bindings?.mcpToolName).toBe('session_transcript_get');
    expect(getActionSpec('session.events.get').bindings?.mcpToolName).toBe('session_events_get');
    expect(getActionSpec('session.messages.recent.get').surfaces.mcp).toBe(true);
    expect(getActionSpec('session.history.get').surfaces.mcp).toBe(true);
  });

  it('declares usage-limit recovery session controls with conservative surfaces', () => {
    const enable = getActionSpec('session.usageLimit.waitResume.enable');
    const cancel = getActionSpec('session.usageLimit.waitResume.cancel');
    const checkNow = getActionSpec('session.usageLimit.checkNow');
    const consumeResetCredit = getActionSpec('session.usageLimit.consumeResetCredit');

    expect(enable.bindings?.mcpToolName).toBe('session_usage_limit_wait_resume_enable');
    expect(cancel.bindings?.mcpToolName).toBe('session_usage_limit_wait_resume_cancel');
    expect(checkNow.bindings?.mcpToolName).toBe('session_usage_limit_check_now');
    expect(consumeResetCredit.bindings?.mcpToolName).toBe('session_usage_limit_consume_reset_credit');
    expect(enable.approval).toEqual({ result: 'none' });
    expect(cancel.approval).toEqual({ result: 'none' });
    expect(checkNow.approval).toEqual({ result: 'required' });
    expect(consumeResetCredit.approval).toEqual({ result: 'required' });
    expect(checkNow.safety).toBe('safe');
    expect(consumeResetCredit.safety).toBe('danger');
    expect(enable.surfaces.session_agent).toBe(true);
    expect(cancel.surfaces.session_agent).toBe(true);
    expect(checkNow.surfaces.session_agent).toBe(true);
    expect(consumeResetCredit.surfaces.session_agent).toBe(true);
    expect(enable.inputSchema).toBe(SessionUsageLimitWaitResumeEnableRequestV1Schema);
    expect(cancel.inputSchema).toBe(SessionUsageLimitWaitResumeCancelRequestV1Schema);
    expect(cancel.inputHints?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'issueFingerprint' }),
      expect.objectContaining({ path: 'armedAtMs' }),
      expect.objectContaining({ path: 'runtimeAuthRecoveryAttemptId' }),
    ]));
    expect(cancel.examples?.mcp?.argsExample).toContain('armedAtMs');
    expect(checkNow.inputSchema).toBe(SessionUsageLimitCheckNowRequestV1Schema);
    expect(consumeResetCredit.inputSchema).toBe(SessionUsageLimitConsumeResetCreditRequestV1Schema);
    expect(checkNow.inputSchema.safeParse({
      sessionId: 's1',
      operation: 'consume_reset_credit',
    }).success).toBe(false);
    expect(consumeResetCredit.inputSchema.parse({
      sessionId: 's1',
      provider: ' codex ',
      resumePromptMode: 'standard',
    })).toEqual({
      sessionId: 's1',
      provider: 'codex',
      resumePromptMode: 'standard',
    });
    expect(enable.inputSchema.parse({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:123',
      remember: true,
    })).toEqual({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:123',
      remember: true,
    });
    expect(cancel.inputSchema.parse({
      sessionId: 's1',
      issueFingerprint: null,
    })).toEqual({
      sessionId: 's1',
      issueFingerprint: null,
    });
    expect(checkNow.inputSchema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
    expect(checkNow.inputHints?.fields.find((field) => field.path === 'provider')).toMatchObject({
      path: 'provider',
      widget: 'text',
    });
    expect(checkNow.inputHints?.fields.find((field) => field.path === 'operation')).toMatchObject({
      path: 'operation',
      widget: 'select',
      options: [
        expect.objectContaining({ value: 'check_now' }),
        expect.objectContaining({ value: 'switch_account_now' }),
      ],
    });
    expect(checkNow.inputHints?.fields.find((field) => field.path === 'resumePromptMode')).toMatchObject({
      path: 'resumePromptMode',
      widget: 'select',
      options: [
        expect.objectContaining({ value: 'standard' }),
        expect.objectContaining({ value: 'off' }),
        expect.objectContaining({ value: 'custom' }),
      ],
    });
  });

  it('declares terminal composer clear as a user-authorized provider-neutral control', () => {
    const spec = getActionSpec('session.terminalComposer.clear' as any);

    expect(spec.safety).toBe('danger');
    expect(spec.approval).toEqual({ result: 'required' });
    expect(spec.surfaces.ui_button).toBe(true);
    expect(spec.surfaces.cli).toBe(true);
    expect(spec.surfaces.mcp).toBe(false);
    expect(spec.surfaces.session_agent).toBe(false);
    expect(spec.inputSchema.parse({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    })).toEqual({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    });
    expect(spec.inputSchema.safeParse({
      sessionId: '  ',
    }).success).toBe(false);
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

  it('declares transcript and events actions with the locked public contract', () => {
    const transcript = getActionSpec('session.transcript.get');
    const events = getActionSpec('session.events.get');
    const history = getActionSpec('session.history.get');
    const recent = getActionSpec('session.messages.recent.get');

    expect(transcript.description).toBe('Read the semantic transcript for a session as clean user/assistant messages with optional tool/reasoning/event flags.');
    expect(transcript.bindings).toEqual({
      voiceClientToolName: 'getSessionTranscript',
      mcpToolName: 'session_transcript_get',
    });
    expect(transcript.examples?.mcp?.argsExample).toBe('{"sessionId":"{{sessionId}}","limit":20,"roles":["user","assistant"],"maxCharsPerMessage":null}');
    expect(transcript.examples?.voice?.argsExample).toBe('{"sessionId":"{{sessionId}}","limit":20,"roles":["user","assistant"],"maxCharsPerMessage":null}');
    expect(transcript.inputHints?.fields.find((field) => field.path === 'maxCharsPerMessage')).toEqual({
      path: 'maxCharsPerMessage',
      title: 'Message truncation chars',
      description: 'Optional per-message truncation budget. Omit or pass null for full message text.',
      widget: 'text',
    });
    expect(transcript.surfaces).toEqual({
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    });
    expect(recent.surfaces.voice_tool).toBe(false);
    expect(recent.surfaces.voice_action_block).toBe(false);
    expect(transcript.approval).toEqual(recent.approval);
    expect(transcript.inputSchema.parse({
      sessionId: 's1',
      limit: 100,
      cursor: null,
      direction: 'after',
      scope: 'sidechain',
      sidechainId: 'side-1',
      roles: ['user', 'assistant'],
      includeTools: true,
      includeReasoning: true,
      includeEvents: true,
      includeMeta: true,
      includeStructuredPayload: true,
      includeRaw: true,
      maxCharsPerMessage: null,
      maxRawPayloadChars: 32768,
    })).toEqual({
      sessionId: 's1',
      limit: 100,
      cursor: null,
      direction: 'after',
      scope: 'sidechain',
      sidechainId: 'side-1',
      roles: ['user', 'assistant'],
      includeTools: true,
      includeReasoning: true,
      includeEvents: true,
      includeMeta: true,
      includeStructuredPayload: true,
      includeRaw: true,
      maxCharsPerMessage: null,
      maxRawPayloadChars: 32768,
    });
    expect(transcript.inputSchema.parse({ sessionId: 's1', maxCharsPerMessage: 50_000 })).toEqual({
      sessionId: 's1',
      maxCharsPerMessage: 50_000,
    });
    expect(() => transcript.inputSchema.parse({ sessionId: 's1', limit: 101 })).toThrow();
    expect(() => transcript.inputSchema.parse({ sessionId: 's1', maxCharsPerMessage: 50_001 })).toThrow();

    expect(events.description).toBe('Inspect raw session events (tool calls, tool results, token counts, lifecycle, permission, stream, session events) for diagnostics. Use session_transcript_get for normal transcript reading.');
    expect(events.bindings).toEqual({ mcpToolName: 'session_events_get' });
    expect(events.examples?.mcp?.argsExample).toBe('{"sessionId":"{{sessionId}}","limit":50,"kinds":["tool_call","tool_result"]}');
    expect(events.surfaces).toEqual(history.surfaces);
    expect(events.approval).toEqual(history.approval);
    expect(events.inputSchema.parse({
      sessionId: 's1',
      limit: 200,
      cursor: null,
      direction: 'before',
      scope: 'all',
      sidechainId: null,
      roles: ['event', 'agent', 'user', 'unknown'],
      kinds: ['tool_call'],
      format: 'raw',
      includeMeta: true,
      includeStructuredPayload: true,
      includeRaw: true,
      maxTextChars: 4000,
      maxPayloadChars: 32768,
    })).toEqual({
      sessionId: 's1',
      limit: 200,
      cursor: null,
      direction: 'before',
      scope: 'all',
      sidechainId: null,
      roles: ['event', 'agent', 'user', 'unknown'],
      kinds: ['tool_call'],
      format: 'raw',
      includeMeta: true,
      includeStructuredPayload: true,
      includeRaw: true,
      maxTextChars: 4000,
      maxPayloadChars: 32768,
    });
    expect(() => events.inputSchema.parse({ sessionId: 's1', limit: 201 })).toThrow();

    expect(history.description).toBe('Read visible session history as compact transcript rows or raw persisted rows for compatibility. Use session_transcript_get for semantic transcript pagination and session_events_get for diagnostics.');
    expect(recent.description).toContain('DEPRECATED: use session_transcript_get. Returns semantic transcript items with cleaner pagination.');
  });

  it('registers work-state, goal, vendor plugin, and skill catalog actions', () => {
    expect(getActionSpec('session.work_state.get' as any).bindings?.mcpToolName).toBe('session_work_state_get');
    expect(getActionSpec('session.goal.get' as any).approval).toEqual({ result: 'required' });
    expect(getActionSpec('session.goal.set' as any).approval).toEqual({ result: 'none' });
    expect(getActionSpec('session.goal.clear' as any).approval).toEqual({ result: 'none' });
    expect(getActionSpec('session.vendor_plugin_catalog.list' as any).bindings?.mcpToolName).toBe('session_vendor_plugin_catalog_list');
    expect(getActionSpec('session.skill_catalog.list' as any).bindings?.mcpToolName).toBe('session_skill_catalog_list');
  });

  it('accepts status-only and budget-only session goal mutations', () => {
    const schema = getActionSpec('session.goal.set' as any).inputSchema;

    expect(schema.safeParse({ sessionId: 's1', status: 'paused' }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 's1', tokenBudget: 50_000 }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 's1', tokenBudget: null }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 's1' }).success).toBe(false);
  });

  it('surfaces approval actions on external mcp and cli (power user/internal)', () => {
    expect(getActionSpec('approval.request.create').surfaces.mcp).toBe(true);
    expect(getActionSpec('approval.request.create').surfaces.cli).toBe(true);
    expect(getActionSpec('approval.request.decide').surfaces.mcp).toBe(true);
    expect(getActionSpec('approval.request.decide').surfaces.cli).toBe(true);
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

  it('requires backendTargetKey when listing models for customAcp', () => {
    const spec = getActionSpec('agents.models.list');

    expect(() =>
      spec.inputSchema.parse({
        agentId: 'customAcp',
        machineId: 'machine-1',
      }),
    ).toThrow();
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

  it('registers both friendly and namespaced slash aliases for review.start', () => {
    const spec = getActionSpec('review.start');
    expect(spec.slash?.tokens).toEqual(['/review', '/h.review']);
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

  it('exposes session.spawn_new to in-session agents as a discoverable action', () => {
    const spec = getActionSpec('session.spawn_new');
    expect(spec.surfaces.session_agent).toBe(true);
    expect(spec.bindings?.mcpToolName).toBe('session_spawn_new');
  });

  it('accepts only the public rich session.spawn_new action input contract', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.parse({
      tag: 'spawn-qa',
      tags: ['qa', 'agent'],
      title: 'Rich spawn',
      path: '/repo',
      directory: '/repo',
      host: 'dev-host',
      machineId: 'machine-1',
      agentId: 'claude',
      backend: 'agent:claude',
      target: 'agent:claude',
      backendTargetKey: 'agent:claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelId: 'claude-opus-4-8',
      prompt: 'Inspect the repository.',
      initialPrompt: 'Inspect the repository.',
      initialMessage: 'Inspect the repository.',
      permissionMode: 'acceptEdits',
      agentModeId: 'plan',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'xhigh' },
          ultracode: { updatedAt: 10, value: true },
        },
      },
      configOptions: {
        reasoning_effort: 'xhigh',
        ultracode: true,
      },
      profileId: 'profile-1',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          github: { source: 'connected', selection: 'profile', profileId: 'default' },
        },
      },
      connectedServicesUpdatedAt: 10,
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: [],
      },
      transcriptStorage: 'persisted',
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'spawn-qa', isolated: true, tmpDir: null },
      },
      windowsRemoteSessionLaunchMode: 'hidden',
      windowsRemoteSessionConsole: 'hidden',
      windowsTerminalWindowName: 'Happier',
      codexBackendMode: 'appServer',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
          },
        },
      },
    })).toMatchObject({
      directory: '/repo',
      initialPrompt: 'Inspect the repository.',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      configOptions: { reasoning_effort: 'xhigh', ultracode: true },
      terminal: { mode: 'tmux' },
      codexBackendMode: 'appServer',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
      },
    });
  });

  it('normalizes supported session permission aliases and rejects unknown modes at the action boundary', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.parse({ permissionMode: 'read_only' })).toEqual({
      permissionMode: 'read-only',
    });
    expect(spec.inputSchema.safeParse({ permissionMode: 'surprise-me' }).success).toBe(false);
  });

  it('rejects daemon authority and outer-workflow session.spawn_new fields', () => {
    const spec = getActionSpec('session.spawn_new');
    const internalFields = [
      'accountSettingsVersionHint',
      'sessionId',
      'existingSessionId',
      'existingSessionAttachPayload',
      'initialTranscriptAfterSeq',
      'initialGoal',
      'executionAuthorization',
      'attachMetadataIdentityPolicy',
      'connectedServiceMaterializationIdentityV1',
      'materializationDiagnostics',
      'attachments',
      'afterCreated',
    ] as const;

    for (const field of internalFields) {
      expect(spec.inputSchema.safeParse({ initialMessage: 'Hello', [field]: 'internal' }).success).toBe(false);
    }
  });

  it('rejects unknown session.spawn_new fields instead of silently passing them through', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse({
      initialMessage: 'Hello',
      unsupportedSpawnField: true,
    }).success).toBe(false);
  });

  it('rejects conflicting session.spawn_new convenience aliases', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse({ path: '/repo-a', directory: '/repo-b' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ initialMessage: 'A', initialPrompt: 'B' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ initialMessage: 'A', prompt: 'B' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ agentId: 'codex', backendTargetKey: 'agent:claude' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({
      backend: 'agent:codex',
      target: 'agent:claude',
    }).success).toBe(false);
    expect(spec.inputSchema.safeParse({
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ backendTargetKey: 'claude' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ agentId: '   ' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ target: '   ' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ backend: '   ' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ target: 'customAcp' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ agentId: 'customAcp' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({
      agentId: 'customAcp',
      backendTargetKey: 'acpBackend:review-bot',
    }).success).toBe(true);
    expect(spec.inputSchema.safeParse({
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'low' },
        },
      },
      configOptions: {
        reasoning_effort: 'xhigh',
      },
    }).success).toBe(false);
  });

  it('exposes session-agent spawn target discovery actions', () => {
    for (const actionId of [
      'paths.list_recent',
      'machines.list',
      'servers.list',
      'sessions.spawn.profiles.list',
      'sessions.spawn.connected_services.list',
      'sessions.spawn.mcp_servers.preview',
    ] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.session_agent).toBe(true);
      expect(spec.surfaces.mcp).toBe(true);
      expect(spec.surfaces.cli).toBe(true);
    }
  });

  it('advertises spawn option sources from session.spawn_new input hints', () => {
    const spec = getActionSpec('session.spawn_new');
    const fields = Object.fromEntries((spec.inputHints?.fields ?? []).map((field) => [field.path, field]));

    expect(fields.backendTargetKey?.optionsSourceId).toBe('agents.backends.enabled');
    expect(fields.path?.optionsSourceId).toBe('sessions.spawn.paths.recent');
    expect(fields.machineId?.optionsSourceId).toBe('sessions.spawn.machines.available');
    expect(fields.modelId?.optionsSourceId).toBe('agents.models.available');
    expect(fields.agentModeId?.optionsSourceId).toBe('agents.session_modes.available');
    expect(fields.sessionConfigOptionOverrides?.optionsSourceId).toBe('agents.config_options.available');
    expect(fields.profileId?.optionsSourceId).toBe('sessions.spawn.profiles.available');
    expect(fields.connectedServices?.optionsSourceId).toBe('sessions.spawn.connected_services.available');
    expect(fields.mcpSelection?.optionsSourceId).toBe('sessions.spawn.mcp_servers.preview');
  });

  it('does not expose legacy voice_mediator intent in ExecutionRunIntentSchema', () => {
    expect(ExecutionRunIntentSchema.safeParse('voice_agent').success).toBe(true);
    expect(ExecutionRunIntentSchema.safeParse('voice_mediator').success).toBe(false);
  });

  it('binds global voice reset to resetGlobalVoiceAgent', () => {
    const spec = getActionSpec('ui.voice_global.reset');
    expect(spec.bindings?.voiceClientToolName).toBe('resetGlobalVoiceAgent');
  });

  it('registers pet chooser slash aliases as a UI-only action', () => {
    const spec = getActionSpec('ui.pet.choose');
    expect(spec.slash?.tokens).toEqual(['/pet', '/h.pet']);
    expect(spec.placements).toContain('slash_command');
    expect(spec.surfaces.ui_slash_command).toBe(true);
    expect(spec.surfaces.mcp).toBe(false);
    expect(spec.surfaces.cli).toBe(false);
  });

  it('binds voice teleport to teleportVoiceAgentToSessionRoot', () => {
    const spec = getActionSpec('ui.voice_agent.teleport');
    expect(spec.bindings?.voiceClientToolName).toBe('teleportVoiceAgentToSessionRoot');
    expect(spec.surfaces.voice_tool).toBe(true);
    expect(spec.surfaces.voice_action_block).toBe(true);
  });

  it('exposes memory action specs', () => {
    const spec = getActionSpec('memory.search');
    expect(spec.id).toBe('memory.search');
    expect(spec.surfaces.voice_tool).toBe(true);
  });

  it('exposes session fork action spec', () => {
    const spec = getActionSpec('session.fork');
    expect(spec.id).toBe('session.fork');
    expect(spec.surfaces.ui_button).toBe(true);
    expect(spec.placements).toContain('session_action_menu');
  });

  it('validates the canonical optional session fork recipe while preserving legacy input', () => {
    const schema = getActionSpec('session.fork').inputSchema;
    expect(schema.safeParse({ sessionId: 'parent-session' }).success).toBe(true);
    expect(schema.safeParse({
      sessionId: 'parent-session',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
      replayMaxSeedChars: 40_000,
      requestId: 'fork-request-1',
    }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 'parent-session', strategy: 'invented' }).success).toBe(false);
    expect(schema.safeParse({
      sessionId: 'parent-session',
      forkPoint: { type: 'seq', upToSeqInclusive: -1 },
    }).success).toBe(false);
  });

  it('exposes session rollback action spec', () => {
    const spec = getActionSpec('session.rollback' as any);
    expect(spec.id).toBe('session.rollback');
    expect(spec.surfaces.ui_button).toBe(true);
    expect(spec.placements).toContain('session_action_menu');
  });

  it('exposes session open action spec', () => {
    const spec = getActionSpec('session.open');
    expect(spec.id).toBe('session.open');
    expect(spec.surfaces.ui_button).toBe(true);
    expect(spec.placements).toContain('command_palette');
    expect(spec.placements).toContain('session_info');
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
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          session_agent: false,
          mcp: true,
          cli: true,
        },
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
        ui_button: true,
        ui_slash_command: true,
        voice_tool: true,
        voice_action_block: true,
        session_agent: false,
        mcp: true,
        cli: true,
      },
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

  it('requires select/multiselect hints to declare options or optionsSourceId', () => {
    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        placements: [],
        surfaces: {
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          mcp: true,
          cli: true,
        },
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
        placements: [],
        surfaces: {
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          mcp: true,
          cli: true,
        },
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
        placements: [],
        surfaces: {
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          mcp: true,
          cli: true,
        },
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

    expect(plan.surfaces.ui_button).toBe(true);
    expect(delegate.surfaces.ui_button).toBe(true);

    const planFields = (plan as any).inputHints?.fields ?? null;
    const delegateFields = (delegate as any).inputHints?.fields ?? null;

    expect(Array.isArray(planFields)).toBe(true);
    expect(Array.isArray(delegateFields)).toBe(true);

    expect(planFields.map((f: any) => f.path)).toContain('backendTargetKeys');
    expect(planFields.map((f: any) => f.path)).toContain('instructions');
    expect(delegateFields.map((f: any) => f.path)).toContain('backendTargetKeys');
    expect(delegateFields.map((f: any) => f.path)).toContain('instructions');

    expect(plan.inputHints?.description).toContain('provider/backend');
    expect(delegate.inputHints?.description).toContain('provider/backend');
    expect(planFields.find((field: any) => field.path === 'backendTargetKeys')?.description).toContain('not parallelism capacity');
    expect(delegateFields.find((field: any) => field.path === 'backendTargetKeys')?.description).toContain('not parallelism capacity');
  });

  it('does not require review instructions in action hints', () => {
    const spec = getActionSpec('review.start');
    const instructionsField = spec.inputHints?.fields.find((field) => field.path === 'instructions');

    expect(instructionsField?.required).not.toBe(true);
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
	    expect(isActionSpecSurfacedOn(getActionSpec('session.mode.set'), 'voice_tool')).toBe(true);
	    expect(isActionSpecSurfacedOn(getActionSpec('session.mode.set'), 'mcp')).toBe(true);
	    expect(listActionSpecsForSurface('mcp').some((spec) => spec.id === 'session.mode.set')).toBe(true);
	    expect(listActionSpecsForSurface('voice_tool').some((spec) => spec.id === 'session.mode.set')).toBe(true);
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
        .filter((spec) => spec.surfaces.voice_tool && Boolean(spec.bindings?.voiceClientToolName))
        .map((spec) => [spec.bindings!.voiceClientToolName!, spec] as const),
    );

    // Baseline expectations: these must exist so local voice and realtime voice can share one tool surface.
    expect(byVoiceToolName.has('sendSessionMessage')).toBe(true);
    expect(byVoiceToolName.has('processPermissionRequest')).toBe(true);
    expect(byVoiceToolName.has('answerUserActionRequest')).toBe(true);
    expect(byVoiceToolName.has('setPrimaryActionSession')).toBe(true);
    expect(byVoiceToolName.has('setTrackedSessions')).toBe(true);
    expect(byVoiceToolName.has('listSessions')).toBe(true);
    expect(byVoiceToolName.has('getSessionActivity')).toBe(true);
    expect(byVoiceToolName.has('getSessionTranscript')).toBe(true);
    expect(byVoiceToolName.has('getSessionRecentMessages')).toBe(false);
    expect(byVoiceToolName.has('teleportVoiceAgentToSessionRoot')).toBe(true);

    // Inventory + discovery tools (safe by default; may be gated by user settings in the UI).
    expect(byVoiceToolName.has('spawnSessionPicker')).toBe(true);
    expect(byVoiceToolName.has('listRecentPaths')).toBe(true);
    expect(byVoiceToolName.has('listMachines')).toBe(true);
    expect(byVoiceToolName.has('listServers')).toBe(true);
    expect(byVoiceToolName.has('listReviewEngines')).toBe(true);
    expect(byVoiceToolName.has('listAgentBackends')).toBe(true);
    expect(byVoiceToolName.has('listAgentModels')).toBe(true);
  });

  it('uses concrete schema-shaped voice args examples for all voice surfaces', () => {
    const placeholderFragments = ['...optional...', '"..."', 'allow|deny', '...|null'];

    for (const spec of listActionSpecs().filter((entry) => entry.surfaces.voice_tool || entry.surfaces.voice_action_block)) {
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
