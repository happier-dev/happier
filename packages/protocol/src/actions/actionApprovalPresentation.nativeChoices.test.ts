import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { prepareApprovalRequest } from './executor/approvalPreparation.js';
import { NativePermissionChoicesV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { SessionStatusResultSchema } from '../sessions/control/contract.js';
import { createActionExecutor } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';

const input = { sessionId: 'session-a', requestId: 'request-a', turnId: 'turn-a',
  nativeChoice: { requirementId: 'native-requirement', choiceId: 'opaque-choice-7' } };
const occurrence = { requestId: input.requestId, turnId: input.turnId, kind: 'permission', tool: 'Write',
  nativeChoices: NativePermissionChoicesV1Schema.parse({ requirementId: input.nativeChoice.requirementId, source: 'native-agent', choices: [
    { id: input.nativeChoice.choiceId, label: 'Trust writes in this workspace', scope: 'localPersistent',
      decision: 'approved', rulePreview: 'Write within /workspace', response: { approved: true } },
  ] }) };
const session = { id: input.sessionId, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, encryption: null };

describe('native permission choice Ask presentation', () => {
  it.each(['explicit', 'contextSession', 'noTurn'] as const)('publishes the readable choice through the real automated Action approval path (%s)', async addressing => {
    let stored: ApprovalRequestV2 | null = null;
    const effects: unknown[] = [];
    const executor = createActionExecutor({
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.permission.respond': { approvalRequiredSurfaces: [context.surface] } } }),
      sessionStatusGet: async () => SessionStatusResultSchema.parse({ session, pendingRequests: [occurrence] }),
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'ask-native' }; },
      sessionPermissionRespond: async args => { effects.push(args); return { ok: true }; },
    });
    const { sessionId: _sessionId, ...withoutSession } = input;
    const { turnId: _turnId, ...withoutTurn } = input;
    const answer = addressing === 'contextSession' ? withoutSession : addressing === 'noTurn' ? withoutTurn : input;
    expect(await executor.execute('session.permission.respond', answer, { surface: 'mcp', authority: 'account_automation',
      actionCaller: { kind: 'host' }, serverId: 'home-a', defaultSessionId: input.sessionId,
      machineId: 'machine-a', actionRequestId: 'ask-native-request' })).toMatchObject({
        ok: true, result: { kind: 'approval_request_created', artifactId: 'ask-native' },
      });
    const request = ApprovalRequestV2Schema.parse(stored);
    expect(describeApprovalActionFields(request)).toMatchObject({ unrepresentable: null,
      rows: expect.arrayContaining([expect.objectContaining({ path: 'nativeChoice', value: occurrence.nativeChoices.choices[0].label })]) });
    expect(effects).toEqual([]);
  });

  it('prepares the stored offered label and scope through one selected Session read', async () => {
    const reads: unknown[] = [];
    // Session status is the host transport boundary; preparation/presentation stay real.
    const prepared = await prepareApprovalRequest({ actionId: 'session.permission.respond', input, actionArgs: input,
      context: { serverId: 'home-a' }, deps: {
        sessionStatusGet: async args => { reads.push(args); return { session, pendingRequests: [occurrence] }; },
        buildApprovalPreview: async ({ defaultPreview }) => ({ ...defaultPreview,
          sessionPermissionRequest: { ...occurrence, sessionId: input.sessionId,
            nativeChoices: { ...occurrence.nativeChoices, choices: [{ ...occurrence.nativeChoices.choices[0], label: 'Forged label' }] } } }),
      } });
    expect(prepared).not.toBeNull();
    if (!prepared || 'errorCode' in prepared) throw new Error('Expected approval preparation');
    const presentation = describeApprovalActionFields({ actionId: 'session.permission.respond', ...prepared });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nativeChoice', value: occurrence.nativeChoices.choices[0].label }),
      expect.objectContaining({ path: 'nativeChoice.scope', value: 'localPersistent' }),
      expect.objectContaining({ path: 'nativeChoice.rulePreview', value: 'Write within /workspace' }),
    ]));
    expect(JSON.stringify(presentation)).not.toContain('Forged label');
    expect(JSON.stringify(prepared.preview)).not.toContain('"response"');
    expect(reads).toEqual([{ sessionId: input.sessionId, serverId: 'home-a', context: { serverId: 'home-a' } }]);
  });

  it.each(['missing', 'request', 'turn', 'requirement', 'choice', 'session'] as const)(
    'keeps %s occurrence context unavailable instead of treating opaque IDs as consent', async mismatch => {
      const pending = { ...occurrence,
        ...(mismatch === 'request' ? { requestId: 'replacement-request' } : {}),
        ...(mismatch === 'turn' ? { turnId: 'replacement-turn' } : {}),
        nativeChoices: { ...occurrence.nativeChoices,
          ...(mismatch === 'requirement' ? { requirementId: 'replacement-requirement' } : {}),
          ...(mismatch === 'choice' ? { choices: [{ ...occurrence.nativeChoices.choices[0], id: 'replacement-choice' }] } : {}),
        } };
      const prepared = await prepareApprovalRequest({ actionId: 'session.permission.respond', input, actionArgs: input,
        context: {}, deps: { sessionStatusGet: async () => ({ session: { ...session,
          ...(mismatch === 'session' ? { id: 'other-session' } : {}) }, pendingRequests: mismatch === 'missing' ? [] : [pending] }) } });
      if (!prepared || 'errorCode' in prepared) throw new Error('Expected unavailable approval presentation');
      const presentation = describeApprovalActionFields({ actionId: 'session.permission.respond', ...prepared });
      expect(presentation.unrepresentable).toEqual({ path: 'nativeChoice', reason: 'missing_required_context' });
      expect(presentation.rows).toContainEqual(expect.objectContaining({ kind: 'unrepresentable', path: 'nativeChoice' }));
    },
  );

  it('never uses native choice labels supplied as executable arguments', () => {
    const presentation = describeApprovalActionFields({ actionId: 'session.permission.respond',
      actionArgs: { ...input, nativeChoices: occurrence.nativeChoices, label: 'Forged label' } });
    expect(presentation.unrepresentable).toEqual({ path: 'nativeChoice', reason: 'missing_required_context' });
    expect(JSON.stringify(presentation)).not.toContain('Forged label');
  });

  it('leaves the legacy allow/deny presentation available without a status read', async () => {
    let reads = 0;
    const legacy = { ...input, nativeChoice: undefined, decision: 'allow' };
    const prepared = await prepareApprovalRequest({ actionId: 'session.permission.respond', input: legacy,
      actionArgs: legacy, context: {}, deps: { sessionStatusGet: async () => { reads++; return { session, pendingRequests: [occurrence] }; } } });
    if (!prepared || 'errorCode' in prepared) throw new Error('Expected legacy approval');
    expect(describeApprovalActionFields({ actionId: 'session.permission.respond', ...prepared }).unrepresentable).toBeNull();
    expect(reads).toBe(0);
  });
});
