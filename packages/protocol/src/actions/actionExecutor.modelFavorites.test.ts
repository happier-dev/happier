import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { projectExecutionRunChildChoiceV1 } from '../execution/runs/responseSchemas.js';
import { setModelFavoriteV1 } from '../providers/modelFavoritesV1.js';

describe('model favorite Action', () => {
  it('rejects caller-authored Account defaults before a Run can be started', async () => {
    const request = { sessionId: 'session', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Task', permissionMode: 'default', runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral',
      childSelection: 'agentDefault' };
    const schema = getActionSpec('execution.run.start').inputSchema;
    expect(schema.safeParse(request).success).toBe(true);
    expect(schema.safeParse({ ...request, accountSettings: {
      providerDefaultModelSelectionsByAgentTargetKeyV1: { spoofed: true },
    } }).success).toBe(false);
  });
  it('preserves the child choice refusal through Action start error normalization', async () => {
    const childChoice = projectExecutionRunChildChoiceV1({ agentTargetKey: 'agent:codex' });
    // The CLI Session RPC adapter returns its normalized typed refusal; arbitrary Error codes stay private.
    const executor = createActionExecutor({ executionRunStart: async () => ({
      ok: false, code: 'execution_run_child_choice_required', message: 'Choose a model', details: {
        childChoice, executionRunStart: { v: 1, runCreation: 'noRunCreated' },
      },
    }), executionRunCheckProtocolV2: async () => ({ ok: true }) });
    expect(await executor.execute('execution.run.start', { sessionId: 'session', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'Task',
      permissionMode: 'default', runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral' }, { surface: 'rpc' }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_child_choice_required', details: { childChoice } });
  });
  it('admits a Team-brokered favorite through the Agent Action schema and preserves the native favorite', async () => {
    const native = { selection: { v: 1 as const, updatedAt: 5,
      ref: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'same-model' } } };
    const team = { selection: { v: 2 as const, updatedAt: 6,
      ref: { source: 'team_resource' as const, teamId: 'team', resourceId: 'share', expectedResourceRevision: 1,
        deliveryMode: 'brokered' as const, agentTargetKey: 'agent:codex', modelId: 'same-model' } } };
    const input = { selection: team, favorite: true };
    const schema = getActionSpec('models.favorite.set').inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    const raw = { favoriteModelSelectionsV1: [native] };
    const added = setModelFavoriteV1(raw, input);
    expect(added.favoriteModelSelectionsV1).toEqual([native, team]);
    const refreshed = { ...team, selection: { ...team.selection, ref: { ...team.selection.ref, expectedResourceRevision: 2 } } };
    expect(setModelFavoriteV1(added, { selection: refreshed, favorite: false })).toEqual(raw);
    expect(schema.safeParse({ ...input, selection: { selection: { ...team.selection,
      ref: { ...team.selection.ref, nativeDelivery: {} } } } }).success).toBe(false);
  });
  it('exposes one exact-tuple intent and preserves unrelated and opaque Account favorites', async () => {
    expect(ActionIdSchema.parse('models.favorite.set')).toBe('models.favorite.set');
    const favorite = { selection: { v: 1 as const, updatedAt: 5,
      ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_one', modelId: 'same-model' } }, modelLabel: 'Model' };
    const other = { ...favorite, selection: { ...favorite.selection, ref: { ...favorite.selection.ref, providerConnectionId: 'pc_two' } } };
    const opaque = { selection: { v: 99, ref: { secretFutureShape: true } } };
    const raw = { unrelated: 'keep', favoriteModelSelectionsV1: [other, opaque] };
    const added = setModelFavoriteV1(raw, { favorite: true, selection: favorite });
    expect(added).toEqual({ ...raw, favoriteModelSelectionsV1: [other, opaque, favorite] });
    expect(setModelFavoriteV1(added, { favorite: true, selection: favorite })).toEqual(added);
    expect(setModelFavoriteV1(added, { favorite: false, selection: favorite })).toEqual(raw);
  });
});
