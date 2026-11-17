import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { markSessionListQueryResultV1 } from '../sessions/awareness/action.js';
import { SessionAgentTransitionRequestV1Schema } from '../sessions/agentTransition.js';
import { SessionConnectedServiceAuthSwitchRpcParamsSchema } from '../connect/sessionConnectedServiceAuthSwitch.js';
import { SessionCapabilitiesSetInputV1Schema } from './specs/sessionCapabilities.js';
import { SessionModelSetInputSchema, SessionPermissionModeSetInputSchema } from './specs/session/state.js';
import { SessionConfigOptionSetInputSchema, SessionModeSetInputSchema } from './specs/session/interaction.js';

const context = { serverId: 'home', defaultSessionId: 'parent', surface: 'ui', authority: 'present_user',
  actionCaller: { kind: 'host' }, bypassApprovals: true, actionRequestId: 'settings-group' } as const satisfies ActionExecutorContext;
const mutations = [
  ['session.permission_mode.set', { permissionMode: 'default' }],
  ['session.permission_mode.set', { permissionMode: 'default', applyTiming: 'next_prompt' }],
  ['session.model.set', { modelId: 'target-model' }],
  ['session.config_option.set', { configId: 'reasoning', valueId: 'high' }],
  ['session.mode.set', { modeId: 'plan' }],
  ['session.capabilities.set', { kind: 'skill', id: 'lint', state: 'on' }],
  ['session.connected_services_auth.set', { machineId: 'machine', agentId: 'codex', bindings: { v: 2, bindingsByServiceId: {} } }],
  ['session.agent.transition', { expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
    input: { text: 'Continue', localId: 'transition-first-input' } }],
] as const;

function fixture() {
  const writes: Array<{ sessionId: string; input: unknown }> = [];
  const metadata = new Map<string, object>();
  const write = (input: { sessionId: string }) => { writes.push({ sessionId: input.sessionId, input }); return {}; };
  // Home/session transport and metadata persistence are the substituted system boundaries.
  // Target resolution, child admission, Action dispatch and capability CAS remain real.
  const deps = {
    resolveSessionReference: async ({ sessionId, context: ctx }) => ({ kind: 'unique', address: { sessionId: sessionId!, serverId: ctx.serverId! } }),
    sessionList: async () => markSessionListQueryResultV1({ sessions: ['a', 'b'].map(id => ({ id, active: false,
      presence: 'offline', updatedAt: 1, manager: { sessionId: 'parent' } })), nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false }),
    sessionPermissionModeSet: async input => write(input),
    sessionModelSet: async input => { write(input); return { ok: true, status: 'applied', sessionId: input.sessionId,
      modelId: input.modelId!, activeSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: input.modelId! } }; },
    sessionModesList: async () => ({ items: [{ value: 'plan', label: 'Plan' }] }),
    sessionModeSet: async input => write(input),
    sessionConfigOptionSet: async input => write(input),
    sessionConnectedServicesAuthSet: async input => { SessionConnectedServiceAuthSwitchRpcParamsSchema.parse(
      Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'machineId' && key !== 'serverId'))); return write(input); },
    sessionAgentTransition: async ({ request, context: child }) => { SessionAgentTransitionRequestV1Schema.parse(request); write(request);
      return { type: 'accepted', localId: request.input?.localId ?? child!.actionRequestId! }; },
    sessionCapabilities: {
      readSession: async ({ sessionId }) => ({ metadata: metadata.get(sessionId) ?? {}, sessionRunning: false,
        agent: { vendorResume: 'supported', skillsLiveReload: 'supported' }, launchRestart: 'automatic' }),
      resolveItem: async ({ id }) => id,
      writeMetadata: async input => { metadata.set(input.sessionId, input.update(metadata.get(input.sessionId) ?? {}));
        write({ sessionId: input.sessionId }); return 'updated'; },
    },
  } satisfies Partial<ActionExecutorDeps>;
  return { executor: createActionExecutor(deps as ActionExecutorDeps), writes };
}

describe('settings Action SessionTarget opt-ins', () => {
  it.each(mutations)('fans out %s and retains the exact single-session call', async (actionId, mutation) => {
    const h = fixture();
    const single = await h.executor.execute(actionId, { sessionId: 'single', ...mutation }, context);
    expect(single, JSON.stringify(single)).toMatchObject({ ok: true });
    expect(h.writes.map(item => item.sessionId)).toEqual(['single']);
    h.writes.length = 0;
    const group = await h.executor.execute(actionId, { sessionId: { selector: 'workers' }, ...mutation }, context);
    expect(group, JSON.stringify(group)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { serverId: 'home', sessionId: 'a' }, result: { ok: true } },
      { target: { serverId: 'home', sessionId: 'b' }, result: { ok: true } },
    ] } });
    expect(h.writes.map(item => item.sessionId)).toEqual(['a', 'b']);
    if (!group.ok) throw new Error('Expected fanout');
    expect(getActionSpec(actionId).outputSchema.safeParse(group.result).success).toBe(true);
  });

  it('keeps lower transport inputs exact while the Action accepts selectors', () => {
    const target = { selector: 'workers' };
    for (const [schema, mutation] of [
      [SessionPermissionModeSetInputSchema, { permissionMode: 'default' }],
      [SessionModelSetInputSchema, { modelId: 'target-model' }],
      [SessionModeSetInputSchema, { modeId: 'plan' }],
      [SessionConfigOptionSetInputSchema, { configId: 'reasoning', valueId: null }],
      [SessionCapabilitiesSetInputV1Schema, { kind: 'skill', id: 'lint', state: 'on' }],
      [SessionConnectedServiceAuthSwitchRpcParamsSchema, { agentId: 'codex', bindings: { v: 2, bindingsByServiceId: {} } }],
      [SessionAgentTransitionRequestV1Schema, { v: 1, expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
        input: { text: 'Continue', localId: 'transition-first-input' } }],
    ] as const) {
      expect(schema.safeParse({ ...mutation, sessionId: 'single' }).success).toBe(true);
      expect(schema.safeParse({ ...mutation, sessionId: target }).success).toBe(false);
    }
  });
});
