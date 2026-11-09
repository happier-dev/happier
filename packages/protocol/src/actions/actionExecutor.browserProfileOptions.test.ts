import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';

const context = { surface: 'cli', authority: 'present_user', serverId: 'selected-home' } as const;

function createDeps(runtimeActionExecute: NonNullable<ActionExecutorDeps['runtimeActionExecute']>): ActionExecutorDeps {
  // Host transports are system boundaries; all resolver and Action admission logic remains real.
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected host transport'); };
  return {
    executionRunStart: unavailable, executionRunList: unavailable, executionRunGet: unavailable,
    detachedExecutionRunSend: unavailable, executionRunStop: unavailable, executionRunAction: unavailable,
    executionRunWait: unavailable, sessionOpen: unavailable, sessionFork: unavailable,
    sessionRollback: unavailable, sessionSpawnNew: unavailable, pathsListRecent: unavailable,
    machinesList: unavailable, serversList: unavailable, reviewEnginesList: unavailable,
    agentsBackendsList: unavailable, agentsModelsList: unavailable, sessionSendMessage: unavailable,
    sessionPermissionRespond: unavailable, sessionUserActionAnswer: unavailable, sessionModeSet: unavailable,
    sessionModesList: unavailable, sessionTargetPrimarySet: unavailable, sessionTargetTrackedSet: unavailable,
    sessionList: unavailable, sessionActivityGet: unavailable, sessionRecentMessagesGet: unavailable,
    resetGlobalVoiceAgent: unavailable, runtimeActionExecute,
  };
}

describe('Action executor Browser profile options', () => {
  it('offers saved profiles including profiles without extensions, scoped to the selected Machine and Home', async () => {
    let reads = 0;
    const executor = createActionExecutor(createDeps(async request => {
      reads++;
      expect(request.actionId).toBe('browser.extensions.list');
      expect(request.input).toEqual({ machineId: 'selected-machine' });
      expect(request.context.serverId).toBe(context.serverId);
      expect(request.context.externalActionTarget).toEqual({ kind: 'machine', machineId: 'selected-machine' });
      return { status: 'ready', entries: [], profiles: [
        { profileId: 'work', displayName: 'Work browser' }, { profileId: 'empty' },
      ] };
    }));
    const result = await executor.execute('action.options.resolve', {
      actionId: 'browser.extensions.install', fieldPath: 'profileId',
      draftInput: { machineId: 'selected-machine', profileId: 'work' },
    }, context);
    expect(result).toMatchObject({ ok: true, result: { options: [
      { value: 'work', label: 'Work browser' }, { value: 'empty', label: 'empty' },
    ] } });
    if (!result.ok) throw new Error('Expected saved profiles');
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).options).toHaveLength(2);
    // One demanded inventory resolution performs one finite Machine read.
    expect(reads).toBe(1);
  });

  it('requires a Machine before reading its profiles', async () => {
    let reads = 0;
    const executor = createActionExecutor(createDeps(async () => { reads++; return { status: 'ready', entries: [], profiles: [] }; }));
    expect(await executor.execute('action.options.resolve', {
      optionsSourceId: 'browser.profiles.available', draftInput: {},
    }, context)).toMatchObject({ ok: false, errorCode: 'missing_option_dependency', details: { requiredDraftPath: 'machineId' } });
    expect(reads).toBe(0);
  });

  it('distinguishes a known empty inventory from an older reply without profile inventory', async () => {
    for (const reply of [{ status: 'ready', entries: [], profiles: [] }, { status: 'ready', entries: [] }]) {
      const executor = createActionExecutor(createDeps(async () => reply));
      const result = await executor.execute('action.options.resolve', {
        optionsSourceId: 'browser.profiles.available', draftInput: { machineId: 'selected-machine' },
      }, context);
      expect(result).toMatchObject('profiles' in reply
        ? { ok: true, result: { options: [] } }
        : { ok: false, errorCode: 'unavailable' });
    }
  });

  it('preserves the Machine profile refusal instead of offering an empty inventory', async () => {
    const executor = createActionExecutor(createDeps(async () => ({ status: 'unavailable', code: 'profile_unavailable' })));
    expect(await executor.execute('action.options.resolve', {
      optionsSourceId: 'browser.profiles.available', draftInput: { machineId: 'selected-machine' },
    }, context)).toMatchObject({ ok: false, errorCode: 'profile_unavailable' });
  });
});
