import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from './actionSpecs.js';
import { clientActionUnavailable, parseClientActionDispatchResult } from './clientDispatchV1.js';
import { actionSpecToActionDefinitionV1, serializeActionSpec } from './actionCatalog.js';

const input = { seed: { prompt: 'Help me author this project.' } };

describe('ordinary editable Session authoring Action', () => {
  it('exposes a safe client presentation on every authoring surface with a strict seed', () => {
    const spec = getActionSpec(ActionIdSchema.parse('session.authoring.open'));
    expect(spec.safety).toBe('safe');
    expect(spec.sideEffectClass).toBe('external');
    expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, voice: true, mcp: true });
    expect(resolveActionExecutionPlacementForInput(spec, input)).toBe('client');
    expect(spec.inputSchema.safeParse({ ...input, pluginId: 'caller-credit' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ seed: { ...input.seed, send: true } }).success).toBe(false);
  });

  it.each(['ui', 'cli', 'agent', 'voice', 'mcp'] as const)('returns typed client absence on %s without spawning a Session', async surface => {
    // No transport is available. The real executor must settle before consulting an execution owner.
    const executor = createActionExecutor({} as ActionExecutorDeps);
    await expect(executor.execute(ActionIdSchema.parse('session.authoring.open'), input, {
      surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
    })).resolves.toEqual({ ok: true, result: { kind: 'unavailable', reason: 'client_unavailable' } });
  });

  it('validates the answering-client acknowledgement without disclosing a writable seed or admitting a Session id', () => {
    const actionId = ActionIdSchema.parse('session.authoring.open');
    expect(clientActionUnavailable(actionId)).toEqual({ ok: true, result: { kind: 'unavailable', reason: 'client_unavailable' } });
    expect(parseClientActionDispatchResult(actionId, { v: 1, execution: { ok: true, result: {
      kind: 'opened', draftId: 'draft-1', destination: 'newSession',
    } } })).toEqual({ ok: true, result: { kind: 'opened', draftId: 'draft-1', destination: 'newSession' } });
    expect(parseClientActionDispatchResult(actionId, { v: 1, execution: { ok: true, result: {
      kind: 'opened', draftId: 'draft-1', destination: 'newSession', sessionId: 'spawned',
    } } })).toBeNull();
  });

  it('publishes the complete authoring request and acknowledgement as native JSON Schema', () => {
    const spec = getActionSpec(ActionIdSchema.parse('session.authoring.open'));
    const summary = serializeActionSpec(spec);
    const definition = actionSpecToActionDefinitionV1(spec);
    expect(definition.inputSchema).toMatchObject({
      type: 'object', required: ['seed'], additionalProperties: false,
    });
    expect(summary.outputSchema).toEqual(definition.outputSchema);
    // Public catalogs must retain these domain members, including the recursive
    // author attachment value, rather than falling back to an empty JSON shape.
    const publicSchema = JSON.stringify(definition);
    for (const member of ['origin', 'workspaceId', 'attachments', 'presentation', 'draftId', 'client_unavailable']) {
      expect(publicSchema).toContain(`"${member}"`);
    }
  });
});
