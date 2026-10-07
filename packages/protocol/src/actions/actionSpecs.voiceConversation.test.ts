import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec, PublicActionIdSchema } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('local Voice Action contract', () => {
  it('declares the exact local conversation and Brief operation identities', () => {
    for (const id of ['get', 'start', 'end', 'set_muted', 'recover', 'dismiss', 'hold_begin', 'hold_release', 'hold_cancel', 'turn_control',
      'brief.request', 'brief.retry', 'brief.stop']) {
      expect(ActionIdSchema.safeParse(`ui.voice_global.${id}`).success, id).toBe(true);
    }
  });

  it('exposes local conversation and Brief operations to automation on the answering client', () => {
    for (const id of ['get', 'start', 'end', 'set_muted', 'recover', 'dismiss', 'hold_begin', 'hold_release', 'hold_cancel', 'turn_control',
      'brief.request', 'brief.retry', 'brief.stop']) {
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
      ['get', false], ['end', false], ['set_muted', false], ['dismiss', false], ['hold_release', false],
      ['hold_cancel', false], ['turn_control', false], ['brief.stop', false],
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

  it('rejects unknown authority fields and requires captured identity for mutation', () => {
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
});
