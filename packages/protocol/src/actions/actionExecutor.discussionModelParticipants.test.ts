import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { DiscussionParticipantRemoveInputV1Schema } from '../discussions/actions.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createProfileActionExecuteV1 } from '../profiles/profileActionsV1.js';
import { createProfileOperations } from '../profiles/profileOperations.js';
import { ProfileRecordV1Schema } from '../profiles/profileRecordSchemaV1.js';

const launch = {
  executionTarget: { serverId: 'home', machineId: 'selected-machine' },
  directory: { kind: 'path', path: '/work' },
  agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agents', localId: 'reviewer' } },
  permissionMode: 'read-only',
} as const;
const request = { discussionId: 'discussion',
  participant: { kind: 'model', participantSlotId: 'reviewer-slot', launch } } as const;
const grantResult = { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [], changed: true } as const;
const context = { surface: 'ui', authority: 'present_user', serverId: 'home',
  actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
    'discussion.invite': ['ui'], 'discussion.archive': ['ui'],
    'session.spawn_new': ['ui'], 'session.stop': ['ui'], 'session.archive': ['ui'],
  } }),
} as const;

describe('Discussion model participant Action composition', () => {
  it('rejoins an uncertain ordinary start from the saved slot without sending an initial prompt', async () => {
    // HTTP reservation and native creation are system boundaries. Parsing,
    // Action admission and creation identity use their real canonical owners.
    const births: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
    const executor = createActionExecutor({
      discussionAction: async () => ({ ...grantResult, modelParticipant: {
        participant: { kind: 'model', participantSlotId: 'reviewer-slot' },
        launch, sessionId: null, answerPolicy: 'when_addressed', createdAt: 1,
      } }),
      sessionSpawnNew: async args => {
        births.push(args);
        return births.length === 1 ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
          : { type: 'success', disposition: 'rejoined', sessionId: 'ordinary-reviewer', executionTarget: launch.executionTarget,
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
      },
    } as ActionExecutorDeps);
    const first = await executor.execute('discussion.invite', request, context);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true,
      result: { modelParticipant: { sessionId: null }, sessionStart: { type: 'pending', outcome: 'unknown' } } });
    const retried = await executor.execute('discussion.invite', request, context);
    expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true,
      result: { modelParticipant: { sessionId: 'ordinary-reviewer' }, sessionStart: { type: 'success', disposition: 'rejoined' } } });
    expect(births).toHaveLength(2);
    expect(births[0]?.sessionCreationTag).toBe(births[1]?.sessionCreationTag);
    for (const birth of births) {
      expect(birth).toMatchObject({ executionTarget: launch.executionTarget, agentTarget: launch.agentTarget,
        permissionMode: 'read-only', discussionParticipant: { discussionId: 'discussion', participantSlotId: 'reviewer-slot' } });
      expect(birth.initialInput).toBeUndefined();
      expect(birth.initialTriggers).toEqual([]);
      // The native transport must retain the public child intent rather than
      // reconstructing it from expanded host-only spawn arguments.
      expect(birth.admittedInput).toEqual({ ...launch,
        creationKey: 'reviewer-slot',
        discussionParticipant: { discussionId: 'discussion', participantSlotId: 'reviewer-slot' },
        initialTriggers: [],
      });
    }
  });

  it('keeps an ordinary Session invitation independent of model allocation', async () => {
    let births = 0;
    const executor = createActionExecutor({ discussionAction: async () => grantResult,
      sessionSpawnNew: async () => { births++; throw new Error('An existing Session must not allocate a model'); },
    } as ActionExecutorDeps);
    const result = await executor.execute('discussion.invite', { discussionId: 'discussion',
      participant: { kind: 'session', sessionId: 'existing-reviewer' } }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: grantResult });
    expect(births).toBe(0);
  });

  it('rejoins a saved slot through the current proven Home alias without changing its Machine or Agent', async () => {
    const births: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
    const savedLaunch = { ...launch, executionTarget: { ...launch.executionTarget, serverId: 'device-a-home' } };
    const executor = createActionExecutor({ discussionAction: async () => ({ ...grantResult, modelParticipant: {
      participant: { kind: 'model', participantSlotId: 'reviewer-slot' }, launch: savedLaunch,
      sessionId: null, answerPolicy: 'when_addressed', createdAt: 1,
    } }), sessionSpawnNew: async args => { births.push(args);
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }; },
    } as ActionExecutorDeps);
    for (const serverId of ['device-a-home', 'device-b-home']) {
      const invite = { ...request, participant: { ...request.participant,
        launch: { ...launch, executionTarget: { ...launch.executionTarget, serverId: 'portable-home' } } } };
      expect(await executor.execute('discussion.invite', invite,
        { ...context, serverId, serverIdentityId: 'portable-home' })).toMatchObject({ ok: true });
    }
    expect(births.map(birth => birth.executionTarget)).toEqual([
      { ...launch.executionTarget, serverId: 'device-a-home' }, { ...launch.executionTarget, serverId: 'device-b-home' },
    ]);
    expect(births[0]?.sessionCreationTag).toBe(births[1]?.sessionCreationTag);
    expect(births.map(birth => birth.agentTarget)).toEqual([launch.agentTarget, launch.agentTarget]);
  });

  it('retains the selected recipe while ordinary Profile admission adds its skills', async () => {
    const selectedLaunch = { ...launch, profileId: 'review-profile' };
    const births: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'review-profile', enabled: true,
      definition: { kind: 'inline', profile: { v: 2, id: 'review-profile', name: 'Review', createdAt: 1, updatedAt: 1 } },
      promptStack: [], secretBindings: {}, skillSeeds: ['review-seed'] });
    // Only the persisted catalog is substituted; the Profile reader and its
    // Action, parser and seed admission remain the actual internal owners.
    const profileActionExecute = createProfileActionExecuteV1({ operations: createProfileOperations({
      readCatalog: () => ({ status: 'ready', records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1,
        source: 'destination', authority: 'active', controlRevision: 1,
        control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } } }),
      writeRecord: async () => { throw new Error('Selection must not write Profiles'); },
      deleteRecord: async () => { throw new Error('Selection must not delete Profiles'); },
    }) });
    const executor = createActionExecutor({ discussionAction: async () => ({ ...grantResult,
      modelParticipant: { participant: { kind: 'model', participantSlotId: 'reviewer-slot' }, launch: selectedLaunch, sessionId: null,
        answerPolicy: 'when_addressed', createdAt: 1 } }),
      profileActionExecute,
      sessionSpawnNew: async args => { births.push(args);
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('discussion.invite', { ...request,
      participant: { ...request.participant, launch: selectedLaunch } }, context)).toMatchObject({ ok: true });
    expect(births[0]?.discussionParticipantLaunch).toEqual(selectedLaunch);
    expect(births[0]?.capabilitySelection?.skills?.forceIncludeSkillIds).toContain('review-seed');
  });

  it('archives only the owned backing Session through ordinary stop and archive, including a lost-remove retry', async () => {
    // These ports model the actual Session process and persistent lifecycle boundaries.
    const sessions = new Map([['ordinary-reviewer', { active: true, archived: false }],
      ['existing-reviewer', { active: true, archived: false }]]);
    const ownedSession = { discussionId: 'discussion', participantSlotId: 'reviewer-slot', sessionId: 'ordinary-reviewer' };
    const executor = createActionExecutor({
      discussionAction: async ({ input }) => ({ ...grantResult,
        ...(DiscussionParticipantRemoveInputV1Schema.parse(input).participant.kind === 'model' ? { ownedSession } : {}) }),
      sessionStop: async ({ sessionId }) => {
        const state = sessions.get(sessionId);
        if (!state) throw new Error('Unknown Session');
        if (!state.active) return { sessionId, stopped: false,
          stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' } };
        state.active = false;
        return { ok: true, sessionId, stopped: true };
      },
      sessionArchiveSet: async ({ sessionId, archived }) => {
        const state = sessions.get(sessionId);
        if (!state || state.active) throw new Error('Only an inactive Session can archive');
        state.archived = archived;
        return { ok: true, sessionId, archivedAt: archived ? 1 : null };
      },
    } as ActionExecutorDeps);
    const input = { discussionId: 'discussion', participant: { kind: 'model', participantSlotId: 'reviewer-slot' } };
    const removed = await executor.execute('discussion.participant.remove', input, context);
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true, result: { ownedSession } });
    expect(await executor.execute('discussion.participant.remove', input, context)).toMatchObject({ ok: true });
    expect(await executor.execute('discussion.participant.remove', { discussionId: 'discussion',
      participant: { kind: 'session', sessionId: 'existing-reviewer' } }, context)).toMatchObject({ ok: true });
    expect(sessions.get('ordinary-reviewer')).toEqual({ active: false, archived: true });
    expect(sessions.get('existing-reviewer')).toEqual({ active: true, archived: false });
    expect(await executor.execute('session.unarchive', { sessionId: 'ordinary-reviewer' }, context)).toMatchObject({ ok: true });
    expect(sessions.get('ordinary-reviewer')).toEqual({ active: false, archived: false });
  });

  it('refuses a foreign ownership descriptor before any Session lifecycle effect', async () => {
    let lifecycleEffects = 0;
    const executor = createActionExecutor({ discussionAction: async () => ({ ...grantResult,
      ownedSession: { discussionId: 'another-discussion', participantSlotId: 'reviewer-slot', sessionId: 'ordinary-reviewer' } }),
      sessionStop: async () => { lifecycleEffects++; return { ok: true, stopped: true }; },
      sessionArchiveSet: async () => { lifecycleEffects++; return { ok: true }; },
    } as ActionExecutorDeps);
    const result = await executor.execute('discussion.participant.remove', { discussionId: 'discussion',
      participant: { kind: 'model', participantSlotId: 'reviewer-slot' } }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    expect(lifecycleEffects).toBe(0);
  });

  it('rejects a model selected in another Home before reserving or allocating it', async () => {
    let effects = 0;
    const executor = createActionExecutor({ discussionAction: async () => { effects++; return grantResult; },
      sessionSpawnNew: async () => { effects++; throw new Error('Must not allocate'); },
    } as ActionExecutorDeps);
    expect(await executor.execute('discussion.invite', { ...request, participant: { ...request.participant,
      launch: { ...launch, executionTarget: { ...launch.executionTarget, serverId: 'other-home' } } } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(effects).toBe(0);
  });

  it('keeps owned archival retryable when ordinary stop cannot confirm liveness', async () => {
    let archives = 0;
    const executor = createActionExecutor({ discussionAction: async () => ({ ...grantResult,
      ownedSession: { discussionId: 'discussion', participantSlotId: 'reviewer-slot', sessionId: 'ordinary-reviewer' } }),
      sessionStop: async () => ({ sessionId: 'ordinary-reviewer', stopped: false }),
      sessionArchiveSet: async () => { archives++; return { sessionId: 'ordinary-reviewer', archivedAt: 1 }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('discussion.participant.remove', { discussionId: 'discussion',
      participant: { kind: 'model', participantSlotId: 'reviewer-slot' } }, context))
      .toMatchObject({ ok: false, errorCode: 'session_stop_unconfirmed' });
    expect(archives).toBe(0);
  });

  it('keeps a server-issued backing identity exact even when it resembles a Session selector', async () => {
    const affected: string[] = [];
    const executor = createActionExecutor({ discussionAction: async () => ({ ...grantResult,
      ownedSession: { discussionId: 'discussion', participantSlotId: 'reviewer-slot', sessionId: 'manager' } }),
      sessionStop: async ({ sessionId }) => { affected.push(sessionId); return { sessionId, stopped: true }; },
      sessionArchiveSet: async ({ sessionId }) => { affected.push(sessionId); return { sessionId, archivedAt: 1 }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('discussion.participant.remove', { discussionId: 'discussion',
      participant: { kind: 'model', participantSlotId: 'reviewer-slot' } }, context)).toMatchObject({ ok: true });
    expect(affected).toEqual(['manager', 'manager']);
  });

  it('keeps the Agent approval floor ahead of model reservation and allocation', async () => {
    let effects = 0;
    const executor = createActionExecutor({ discussionAction: async () => { effects++; return grantResult; },
      sessionSpawnNew: async () => { effects++; throw new Error('Must await confirmation'); },
    } as ActionExecutorDeps);
    expect(await executor.execute('discussion.invite', request,
      { ...context, surface: 'agent', authority: 'account_automation', actionsSettings: normalizeActionsSettingsV1({ v: 1 }) }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(effects).toBe(0);
  });
});
