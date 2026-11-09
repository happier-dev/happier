import { describe, expect, it } from 'vitest';
import { getActionSpec, listActionSpecs, listVoiceToolActionSpecs } from './actionSpecs.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS } from './notificationConfigurationActionIds.js';

// These families are the Coordination program's public Action corridor. Other
// product families retain their own surface policy and are outside this lane.
const programAction = /^(follow\.|discussion\.|workflow\.|doc\.|artifact\.|memory\.|boards\.|inbox\.|approval\.request\.|session\.(message\.|messages\.recent\.get$|transcript\.get$|target\.|targets\.|status\.|work\.|update\.|delivery\.|exchange\.|coordinator\.|manager\.|attention\.|read_state\.|trigger\.|board\.|needs_you\.|open$|handoff$|spawn_new$|turn\.cancel$|stop$|wait\.idle$|bot\.set$|memory\.set$|context\.update$|permission\.respond$|user_action\.answer$))/;
const personOnly = new Set([
  'doc.edit.accept', 'doc.edit.decline', 'workflow.run.invocations.complete_review', 'approval.request.decide',
]);
// Inbox brief approvals require a tap in the canonical UI (docs/actions.md).
const tapOnly = new Set(['session.permission.respond']);

describe('Coordination Voice parity', () => {
  it('demonstrates an inline ask and a typed pass through the actual Voice Action schemas', () => {
    const send = getActionSpec('session.message.send');
    const reply = getActionSpec('session.message.reply');
    const askInput = JSON.parse(send.examples?.voice?.argsExample ?? '{}');
    const passInput = JSON.parse(reply.examples?.voice?.argsExample ?? '{}');
    expect(askInput).toMatchObject({ reply: 'wait' });
    expect(passInput).toMatchObject({ requestLocalId: expect.any(String), reply: { kind: 'pass' } });
    expect(send.inputSchema.safeParse(askInput).success).toBe(true);
    expect(reply.inputSchema.safeParse(passInput).success).toBe(true);
  });

  it('binds the remaining operational and mounted-client Actions through the Voice catalog', () => {
    const tools = new Set(listVoiceToolActionSpecs().map(spec => spec.id));
    const specs = listActionSpecs().filter(spec => /^(session\.tags\.|session\.list\.view\.|discussion\.list\.view\.|machines\.agents\.signIn\.|connectedServices\.authentication\.)/.test(spec.id)
      || [...NOTIFICATION_CONFIGURATION_ACTION_IDS, 'session.pending.action.set', 'session.role.set', 'workflow.discussion.round.project', 'projects.list'].includes(spec.id));
    expect(specs.length).toBeGreaterThan(20);
    for (const spec of specs) {
      expect(spec.surfaces.voice, spec.id).toBe(true);
      expect(spec.bindings?.voiceClientToolName, spec.id).toBeTruthy();
      expect(tools.has(spec.id), spec.id).toBe(true);
    }
    for (const id of ['notifications.desktop.permission.request', 'notifications.push.permission.request'] as const) {
      expect(getActionSpec(id).approvalPolicy?.agentDefault, id).toBe('authority');
    }
    expect(getActionSpec('connectedServices.authentication.submitManual').approvalInputCustody).toBe('live_only');
  });

  it('makes every program Action discoverable and bound except explicit person-only decisions', () => {
    const tools = new Set(listVoiceToolActionSpecs().map(spec => spec.id));
    const gaps = listActionSpecs().filter(spec => programAction.test(spec.id) && spec.surfaces.ui && !personOnly.has(spec.id) && !tapOnly.has(spec.id))
      .filter(spec => !spec.surfaces.voice || !spec.bindings?.voiceClientToolName || !tools.has(spec.id))
      .map(spec => spec.id);
    expect(gaps).toEqual([]);
    for (const id of personOnly) {
      const spec = listActionSpecs().find(candidate => candidate.id === id)!;
      expect(spec.requiredAuthority, id).toBe('present_user');
      expect(spec.surfaces.voice, id).toBe(false);
      expect(tools.has(spec.id), id).toBe(false);
    }
    for (const id of tapOnly) {
      const spec = listActionSpecs().find(candidate => candidate.id === id)!;
      expect(spec.surfaces.voice, id).toBe(false);
      expect(tools.has(spec.id), id).toBe(false);
    }
  });

  it('retains each operation’s approval default and authority when exposed to Voice', () => {
    expect(getActionSpec('workflow.run.pause').approval).toEqual({ result: 'optional', flow: 'deferred' });
    expect(getActionSpec('workflow.run.get').approval).toEqual({ result: 'required' });
    expect(getActionSpec('workflow.definition.delete').safety).toBe('danger');
    expect(getActionSpec('boards.apply').approval).toEqual({ result: 'required' });
    expect(getActionSpec('approval.request.create').approval).toEqual({ result: 'none' });
    expect(getActionSpec('workflow.run.pause').requiredAuthority).toBe('account_automation');
    expect(getActionSpec('session.permission.respond').requiredAuthority).toBe('account_automation');
    expect(getActionSpec('session.permission.respond').approvalPolicy).toMatchObject({ agentDefault: 'authority', requiredSurfaces: ['mcp'] });
  });
});
