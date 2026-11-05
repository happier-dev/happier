import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec, PublicActionIdSchema } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('local Voice Action contract', () => {
  it('exposes Say and Stop on the answering client with ordinary automation approval defaults', () => {
    for (const operation of ['say.start', 'say.stop'] as const) {
      const actionId = ActionIdSchema.parse(`ui.voice_global.${operation}`);
      const spec = getActionSpec(actionId);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, plugin: true });
      expect(spec.inputSchema.safeParse(operation === 'say.start' ? { text: 'hello '.repeat(1000) } : {}).success).toBe(true);
      expect(spec.inputSchema.safeParse(operation === 'say.start' ? { text: '   ' } : { text: 'wrong' }).success).toBe(false);
      for (const surface of ['agent', 'mcp', 'plugin'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec,
          context: { surface, authority: 'account_automation' } }).required).toBe(operation === 'say.start');
      }
    }
  });

  it('exposes History reads and export while preserving destructive clear approval', () => {
    for (const operation of ['search', 'load_older', 'export', 'clear']) {
      const actionId = ActionIdSchema.parse(`ui.voice_global.history.${operation}`);
      const spec = getActionSpec(actionId);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, plugin: true });
      expect(spec.inputSchema.safeParse(operation === 'export' ? { range: 'all', query: 'release' } : {}).success).toBe(true);
      expect(spec.inputSchema.safeParse({ sessionId: 'ordinary-session' }).success).toBe(false);
      expect(resolveActionApprovalRouting({ actionId, spec,
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(operation === 'clear');
      if (operation === 'search' || operation === 'load_older') expect(spec.sideEffectClass).toBe('read');
    }
  });
  it('declares the exact local conversation and Brief operation identities', () => {
    for (const id of ['get', 'start', 'end', 'set_muted', 'recover', 'dismiss', 'hold_begin', 'hold_release', 'hold_cancel', 'turn_control',
      'brief.request', 'brief.retry', 'brief.stop', 'brief.close', 'glance.open', 'glance.close', 'transcript.set_visible',
      'companion.reveal', 'position.set', 'setup.open', 'setup.close', 'open_conversation',
      'dictation.start', 'dictation.finish', 'dictation.cancel', 'dictation.dismiss', 'dictation.retry']) {
      expect(ActionIdSchema.safeParse(`ui.voice_global.${id}`).success, id).toBe(true);
    }
  });

  it('exposes local conversation and Brief operations to automation on the answering client', () => {
    for (const id of ['get', 'start', 'end', 'set_muted', 'recover', 'dismiss', 'hold_begin', 'hold_release', 'hold_cancel', 'turn_control',
      'brief.request', 'brief.retry', 'brief.stop', 'brief.close', 'glance.open', 'glance.close', 'transcript.set_visible',
      'companion.reveal', 'position.set', 'setup.open', 'setup.close', 'open_conversation',
      'dictation.start', 'dictation.finish', 'dictation.cancel', 'dictation.dismiss', 'dictation.retry']) {
      const actionId = `ui.voice_global.${id}`;
      const parsed = ActionIdSchema.safeParse(actionId);
      expect(parsed.success, actionId).toBe(true);
      if (!parsed.success) continue;
      const spec = getActionSpec(parsed.data);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.requiredAuthority).toBe('account_automation');
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, plugin: true, cli: false, voice: false });
      expect(PublicActionIdSchema.safeParse(actionId).success).toBe(true);
      expect(spec.placements).toContain('command_palette');
    }
  });

  it('defaults microphone opening to approval and leaves safe controls direct', () => {
    for (const [operation, required] of [
      ['start', true], ['recover', true], ['hold_begin', true], ['brief.request', true], ['brief.retry', true],
      ['get', false], ['end', false], ['set_muted', true], ['dismiss', false], ['hold_release', false],
      ['hold_cancel', false], ['turn_control', false], ['brief.stop', false], ['brief.close', false],
      ['glance.open', false], ['glance.close', false], ['transcript.set_visible', false], ['companion.reveal', false],
      ['position.set', false], ['setup.open', false], ['setup.close', false], ['open_conversation', false],
      ['dictation.start', true], ['dictation.finish', false], ['dictation.cancel', false], ['dictation.dismiss', false], ['dictation.retry', false],
    ] as const) {
      const actionId = ActionIdSchema.parse(`ui.voice_global.${operation}`);
      const spec = getActionSpec(actionId);
      for (const surface of ['agent', 'mcp', 'plugin'] as const) {
        const context = { surface, authority: 'account_automation' as const };
        expect(resolveActionApprovalRouting({ actionId, spec, context }).required, `${operation}:${surface}`).toBe(required);
        const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(false);
      }
    }
  });

  it('requires automation approval for unmute while mute and present-user UI controls remain direct', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting, isApprovalRequiredByActionsSettings } = await import('./actionApprovalPolicy.js');
    const actionId = 'ui.voice_global.set_muted';
    const spec = getActionSpec(actionId);
    for (const surface of ['agent', 'mcp', 'plugin'] as const) {
      const context = { surface, authority: 'account_automation' as const };
      for (const muted of [true, false]) {
        const input = { expectedAttempt: 'current-attempt', muted };
        expect(resolveActionApprovalRouting({ actionId, spec, context, input }).required).toBe(!muted);
        const settings = normalizeActionsSettingsV1({ v: 1 });
        expect(isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input)).toBe(!muted);
        const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, input, settings: waived }).required).toBe(false);
        const required = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, input, settings: required }).required).toBe(true);
      }
      expect(resolveActionApprovalRouting({ actionId, spec, context, input: { muted: true } }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec, context,
        input: { expectedAttempt: 'current-attempt', muted: true }, defaultSafety: 'danger' }).required).toBe(true);
    }
    for (const muted of [true, false]) {
      expect(resolveActionApprovalRouting({ actionId, spec, input: { expectedAttempt: 'current-attempt', muted },
        context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
      const required = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
      expect(resolveActionApprovalRouting({ actionId, spec, input: { expectedAttempt: 'current-attempt', muted }, settings: required,
        context: { surface: 'ui', authority: 'present_user' } }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec, input: { expectedAttempt: 'current-attempt', muted },
        context: { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId } } }).required).toBe(false);
    }
  });

  it('rejects unknown authority fields and requires captured identity for mutation', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const get = getActionSpec(ActionIdSchema.parse('ui.voice_global.get'));
    expect(get.inputSchema.safeParse({}).success).toBe(true);
    expect(get.inputSchema.safeParse({ target: { kind: 'session', sessionAddress: { serverId: 'home', sessionId: 's1', accountId: 'injected' } } }).success).toBe(false);
    const end = getActionSpec(ActionIdSchema.parse('ui.voice_global.end'));
    expect(end.inputSchema.safeParse({}).success).toBe(false);
    expect(end.inputSchema.safeParse({ expectedAttempt: 'attempt-1' }).success).toBe(true);
    expect(end.inputSchema.safeParse({ expectedAttempt: 'attempt-1', sessionId: 'focused-session' }).success).toBe(false);
  });

  it('exposes destructive Voice reset with the same default approval owner', () => {
    const actionId = 'ui.voice_global.reset';
    const spec = getActionSpec(actionId);
    expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, plugin: true });
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
  });

  it('admits presentation geometry without pointer replay and keeps exact navigation identity', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const position = getActionSpec(ActionIdSchema.parse('ui.voice_global.position.set'));
    expect(position.inputSchema.safeParse({ x: 0.25, y: 0.75 }).success).toBe(true);
    expect(position.inputSchema.safeParse({ x: -0.1, y: 0.75 }).success).toBe(false);
    expect(position.inputSchema.safeParse({ x: 0.25, y: 1.1 }).success).toBe(false);
    expect(position.inputSchema.safeParse({ x: 0.25, y: 0.75, pointerId: 1 }).success).toBe(false);
    const open = getActionSpec(ActionIdSchema.parse('ui.voice_global.open_conversation'));
    expect(open.inputSchema.safeParse({ expectedAttempt: 'ended-attempt' }).success).toBe(true);
    expect(open.inputSchema.safeParse({}).success).toBe(false);
    expect(open.inputSchema.safeParse({ expectedAttempt: 'ended-attempt', sessionId: 'visible-session' }).success).toBe(false);
    const teleport = getActionSpec('ui.voice_agent.teleport');
    expect(teleport.surfaces).toMatchObject({ agent: true, mcp: true, plugin: true });
    expect(teleport.requiredAuthority).toBe('account_automation');
  });
});
import { listActionSpecs } from './actionSpecs.js';

it('VI-LIFE exposes exact New, Continue, list and open operations to UI, Voice, Agent and MCP with microphone approval', () => {
  for (const id of ['ui.voice_global.new_conversation', 'ui.voice_global.continue_conversation',
    'ui.voice_global.conversations.list', 'ui.voice_global.conversations.open']) {
    const spec = listActionSpecs().find(spec => spec.id === id);
    expect(spec, id).toBeDefined();
    expect(spec?.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true });
    if (!spec) throw new Error('Expected the registered Voice conversation Action');
    expect(spec.bindings?.mcpToolName).toBe(id.replaceAll('.', '_'));
    for (const surface of ['voice', 'agent', 'mcp'] as const) {
      expect(resolveActionApprovalRouting({ actionId: ActionIdSchema.parse(id), spec,
        context: { surface, authority: 'account_automation' } }).required)
        .toBe(id.endsWith('new_conversation') || id.endsWith('continue_conversation'));
    }
    if (id.endsWith('new_conversation') || id.endsWith('continue_conversation')) {
      expect(spec?.safety).toBe('danger');
      expect(spec?.approval.result).toBe('required');
    }
  }
});
