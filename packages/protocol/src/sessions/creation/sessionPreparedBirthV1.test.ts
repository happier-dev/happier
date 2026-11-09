import { describe, expect, it } from 'vitest';
import { buildSessionHostOnboardingInputV1, commitPreparedSessionBirthV1, readSessionHostOnboardingPresentationV1 } from './sessionPreparedBirthV1.js';

describe('ordinary prepared Session birth', () => {
  it('carries the first-task display facts separately from the hidden onboarding prompt', () => {
    const prepared = buildSessionHostOnboardingInputV1({ templateName: 'Helper', templateVersion: '1.0.0', authorDisplayName: 'Ana', firstTask: 'Review my change' });
    expect(prepared).toMatchObject({ meta: { happierHostOnboardingV1: {
      v: 1, templateName: 'Helper', templateVersion: '1.0.0', authorDisplayName: 'Ana', firstTask: 'Review my change',
    } } });
    expect(readSessionHostOnboardingPresentationV1(prepared.meta)).toEqual(prepared.meta.happierHostOnboardingV1);
    expect(readSessionHostOnboardingPresentationV1({ happierHostOnboardingV1: { ...prepared.meta.happierHostOnboardingV1,
      futureDisplayField: true } })).toEqual(prepared.meta.happierHostOnboardingV1);
    expect(readSessionHostOnboardingPresentationV1({})).toBeNull();
    expect(readSessionHostOnboardingPresentationV1({ happierHostOnboardingV1: { v: 1, firstTask: 'Unattributed' } })).toBeNull();
  });
  it('admits deferred input only after content settles, and retains the row on content failure', async () => {
    const state = { content: false, input: false, launched: false };
    let release!: () => void;
    const preparing = new Promise<void>(resolve => { release = resolve; });
    let prepared!: () => void;
    const started = new Promise<void>(resolve => { prepared = resolve; });
    const operation = commitPreparedSessionBirthV1({
      commit: async () => ({ sessionId: 'session', disposition: 'created', metadataRevision: 0, value: state }),
      authenticateRejoin: async () => { throw new Error('New birth must not authenticate a rejoin'); },
      bindMachine: async () => {},
      beforeLaunch: async () => { prepared(); await preparing; state.content = true; },
      submitInitialInput: async () => {
        if (!state.content) throw new Error('Input cannot precede prepared content');
        state.input = true;
        return { status: 'accepted', localId: 'onboarding' };
      },
    });
    await started;
    expect(state).toEqual({ content: false, input: false, launched: false });
    release();
    expect(await operation).toMatchObject({ birth: { sessionId: 'session' }, initialInput: { status: 'accepted' } });
    expect(state).toEqual({ content: true, input: true, launched: false });

    state.input = false;
    await expect(commitPreparedSessionBirthV1({
      commit: async () => ({ sessionId: 'retained', disposition: 'created', metadataRevision: 0, value: state }),
      authenticateRejoin: async () => {},
      bindMachine: async () => {},
      beforeLaunch: async () => { throw Object.assign(new Error('Catalog unavailable'), { code: 'catalog_unavailable' }); },
      launch: async () => { state.launched = true; },
      submitInitialInput: async () => { state.input = true; return { status: 'notRequested' }; },
    })).rejects.toMatchObject({ code: 'catalog_unavailable', details: { sessionId: 'retained' } });
    expect(state.input).toBe(false);
    expect(state.launched).toBe(false);
  });

  it('refuses a conflicting rejoin before binding or preparing recipient content', async () => {
    const state = { bound: false, content: false, input: false };
    await expect(commitPreparedSessionBirthV1({
      commit: async () => ({ sessionId: 'existing', disposition: 'rejoined', metadataRevision: 3, value: state }),
      authenticateRejoin: async () => { throw Object.assign(new Error('Different immutable recipe'), { code: 'creation_conflict' }); },
      bindMachine: async () => { state.bound = true; },
      beforeLaunch: async () => { state.content = true; },
      submitInitialInput: async () => { state.input = true; return { status: 'notRequested' }; },
    })).rejects.toMatchObject({ code: 'creation_conflict' });
    expect(state).toEqual({ bound: false, content: false, input: false });
  });
});
