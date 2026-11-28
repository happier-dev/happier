import { describe, expect, it } from 'vitest';
import { createSessionStateSyncEngine } from '@happier-dev/agents';
import { createActionExecutor } from '@happier-dev/protocol';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { FollowRuleSetActionInputV1Schema } from '@happier-dev/protocol/sessions/follow/actions';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { createRoleActionExecutor } from './roleActions';

function fixture(marked = false) {
  let metadata = createTestMetadata({ ...(marked ? { bot: { kind: 'bot' } } : {}), work: { memoryEnabled: false,
    sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 'Keep notes' } } });
  let version = 0;
  const pins: { surface: 'list' | 'rail'; pinned: boolean }[] = [];
  const rules: unknown[] = [];
  const engine = createSessionStateSyncEngine({ facet: null,
    capabilities: { display: { bot: { supported: true,
      happierToProvider: { supported: false }, providerToHappier: { supported: false } } } },
    // Metadata and Account HTTP ports are persistence/transport boundaries;
    // role resolution, sparse durable edits and state bindings remain real.
    metadataPort: { update: async (_sessionId, update) => {
      metadata = createTestMetadata(update(metadata)); return { ok: true, version: ++version };
    } },
  });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    // The person's confirmation dialog is a UI boundary, not a policy waiver.
    presentUserActionConfirmation: async () => true,
    roleActionExecute: createRoleActionExecutor({ sessionId: 'coordinator',
      readSessionMetadata: () => metadata,
      readSettingsOverrides: () => ({ status: 'ready', overrides: {} }),
      prepareWorkspaceWritesPolicy: async () => ({ ok: true }),
      stageSessionStateMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    }),
    sessionStateFieldSet: async write => {
      if (write.fieldId !== 'display.bot') throw new Error('Unexpected metadata field');
      const result = await engine.writeHappierField({ sessionId: write.sessionId, fieldId: write.fieldId,
        value: write.value, reason: 'user-mutation', metadataReason: 'test-account-transport' });
      if (!result.ok) return { ok: false, errorCode: result.reason, error: result.reason };
      return { ok: true, sessionId: write.sessionId, bot: write.value, version: result.version };
    },
    sessionOrganizationPinSet: async ({ sessionId, request }) => {
      const surface = request.surface ?? 'list';
      pins.push({ surface, pinned: request.pinned });
      return { pin: { sessionId, sortKey: null, pinnedAt: 1,
        listPinned: surface === 'list', railPinned: surface === 'rail' } };
    },
    sessionManagerSet: async () => ({ ok: false, error: 'manager_forbidden', reason: 'pairwise' }),
    sessionFollowAction: async ({ actionId, input }) => {
      if (actionId !== 'follow.set') throw new Error('Unexpected Follow transport');
      const request = FollowRuleSetActionInputV1Schema.parse(input);
      rules.push(request);
      return { rule: { ruleId: request.source.ruleId, receiver: request.receiver,
        definition: { ...request.ruleDefinition, policy: request.policy }, version: request.expectedVersion + 1 } };
    },
  });
  return { executor, readMetadata: () => metadata, pins, rules };
}

const context = { authority: 'present_user', surface: 'ui', serverId: 'home' } as const;

describe('Make coordinator through canonical Actions', () => {
  it.each(['none', 'list_pin'] as const)('keeps %s through only its existing owners', async keep => {
    const state = fixture();
    const result = await state.executor.execute('session.coordinator.enable',
      { sessionId: 'coordinator', roleId: 'orchestrator', keep, answersWorkerQuestions: false, ruleSuggestions: [] }, context);
    expect(result).toMatchObject({ ok: true, result: { status: 'configured' } });
    expect(readSessionRolesV1(state.readMetadata())).toMatchObject({ roleId: 'orchestrator',
      answersWorkerQuestions: false, notes: 'Keep notes' });
    expect(state.readMetadata().bot).toBeUndefined();
    expect(state.readMetadata().work?.memoryEnabled).toBe(false);
    expect(state.pins).toEqual(keep === 'none' ? [] : [{ surface: 'list', pinned: true }]);
    expect(state.rules).toEqual([]);
  });

  it('reports a manager refusal while retaining accepted role, pin and canonical Important rule effects', async () => {
    const state = fixture();
    const ruleDefinition = { v: 1, enabled: true,
      filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }) };
    const result = await state.executor.execute('session.coordinator.enable', {
      sessionId: 'coordinator', roleId: 'builder', keep: 'list_pin',
      managedBy: { managerSessionId: 'manager', expectedManagerSessionId: null },
      ruleSuggestions: [{ source: { kind: 'rule', ruleId: 'project-rule' }, ruleDefinition, expectedVersion: -1 }],
    }, context);
    expect(result).toMatchObject({ ok: true, result: { status: 'partial', effects: [
      { operation: 'role', status: 'accepted' }, { operation: 'pin', status: 'accepted' },
      { operation: 'manager', status: 'failed', errorCode: 'manager_forbidden' },
      { operation: 'rule', ruleId: 'project-rule', status: 'accepted', version: 0 },
    ] } });
    expect(state.pins).toEqual([{ surface: 'list', pinned: true }]);
    expect(state.rules).toEqual([{ receiver: { kind: 'session', sessionId: 'coordinator' },
      source: { kind: 'rule', ruleId: 'project-rule' }, ruleDefinition, expectedVersion: -1,
      policy: { preset: 'important' } }]);
  });

  it('refuses another Home rule before changing the session', async () => {
    const state = fixture();
    const before = state.readMetadata();
    const result = await state.executor.execute('session.coordinator.enable', {
      sessionId: 'coordinator', roleId: 'orchestrator', keep: 'list_pin',
      ruleSuggestions: [{ source: { kind: 'rule', ruleId: 'foreign-rule' }, expectedVersion: -1,
        ruleDefinition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['other-home'] }) } }],
    }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(state.readMetadata()).toBe(before);
    expect(state.pins).toEqual([]);
    expect(state.rules).toEqual([]);
  });

  it('keeps an existing Bot marker while configuring the same Session as coordinator', async () => {
    const state = fixture(true);
    const result = await state.executor.execute('session.coordinator.enable', {
      sessionId: 'coordinator', roleId: 'orchestrator', keep: 'list_pin', ruleSuggestions: [],
    }, context);
    expect(result).toMatchObject({ ok: true, result: { status: 'configured', effects: [
      { operation: 'role', status: 'accepted' },
      { operation: 'pin', status: 'accepted' },
    ] } });
    expect(state.readMetadata().bot).toEqual({ kind: 'bot' });
    expect(state.pins).toEqual([{ surface: 'list', pinned: true }]);
    expect(readSessionRolesV1(state.readMetadata())?.roleId).toBe('orchestrator');
  });
});
