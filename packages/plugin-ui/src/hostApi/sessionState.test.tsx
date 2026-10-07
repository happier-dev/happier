import { act } from 'react';
import renderer from 'react-test-renderer';
import type { PluginUiHostApi, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { PluginHostApiProvider } from '../advanced/index.js';
import { createHostApiStub } from '../surfaceFixture.testSupport.js';
import { useSessionStates, type SessionStatesReadV1 } from './sessionState.public.js';
import { PluginHostApiProviderInternal } from './context.js';

const WORKING: SessionStateV1 = {
  sessionId: 'first', lifecycle: 'active', runtime: 'working', operational: 'working',
  pendingPermissions: [], workStatus: { bucket: 'working', tone: 'neutral', word: 'Working' },
};

describe('useSessionStates', () => {
  it('withdraws inactive watches, retains the snapshot, ignores late reads and callbacks, and rereads on reactivation', async () => {
    const watchers = new Map<string, Parameters<PluginUiHostApi['watchSession']>[1]>();
    const base = createHostApiStub();
    let finishRead: ((state: SessionStateV1 | null) => void) | undefined;
    let snapshot = WORKING;
    const readSession = vi.fn<PluginUiHostApi['readSession']>(async () => snapshot);
    const hostApi = createHostApiStub(undefined, {
      version: () => ({ ...base.version(), methods: ['readSession', 'watchSession'] }),
      readSession,
      watchSession: async (id, listener) => {
        watchers.set(id, listener);
        return { dispose: () => { watchers.delete(id); } };
      },
    });
    let current: SessionStatesReadV1 | undefined;
    function Probe() { current = useSessionStates(['first']); return null; }
    const view = (active: boolean) => (
      <PluginHostApiProviderInternal hostApi={hostApi} surfaceActivity={{ active }}><Probe /></PluginHostApiProviderInternal>
    );
    let tree!: renderer.ReactTestRenderer;
    try {
      await act(async () => { tree = renderer.create(view(false)); });
      expect(watchers.size).toBe(0);
      expect(readSession).not.toHaveBeenCalled();
      await act(async () => { tree.update(view(true)); });
      expect(current?.sessions.get('first')).toMatchObject({ status: 'ready', state: WORKING });
      const retiredWatch = watchers.get('first')!;
      readSession.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      await act(async () => { retiredWatch({ version: 1, subscriptionId: 'watch', kind: 'invalidated', digest: 'pending' }); });
      const pendingSignal = readSession.mock.calls.at(-1)?.[1]?.signal;
      await act(async () => { tree.update(view(false)); });
      expect(watchers.size).toBe(0);
      expect(pendingSignal?.aborted).toBe(true);
      const readsBeforeLateCallback = readSession.mock.calls.length;
      snapshot = { ...WORKING, workStatus: { bucket: 'idle', tone: 'neutral', word: 'Ready' } };
      await act(async () => {
        retiredWatch({ version: 1, subscriptionId: 'watch', kind: 'invalidated', digest: 'late' });
        finishRead?.(snapshot);
        current?.refresh();
      });
      expect(readSession).toHaveBeenCalledTimes(readsBeforeLateCallback);
      expect(current?.sessions.get('first')).toMatchObject({ status: 'ready', state: WORKING });
      await act(async () => { tree.update(view(true)); });
      expect(watchers.size).toBe(1);
      expect(current?.sessions.get('first')).toMatchObject({ status: 'ready', state: snapshot });
    } finally {
      act(() => tree?.unmount());
    }
    expect(watchers.size).toBe(0);
  });

  it.each(['established', 'refused'] as const)('retires a late %s watch without starting a read', async (settlement) => {
    const base = createHostApiStub();
    const dispose = vi.fn();
    let establishWatch!: (subscription: { dispose(): void }) => void;
    let refuseWatch!: (error: Error) => void;
    const readSession = vi.fn<PluginUiHostApi['readSession']>(async () => WORKING);
    const hostApi = createHostApiStub(undefined, {
      version: () => ({ ...base.version(), methods: ['readSession', 'watchSession'] }),
      readSession,
      watchSession: () => new Promise((resolve, reject) => { establishWatch = resolve; refuseWatch = reject; }),
    });
    function Probe() { useSessionStates(['first']); return null; }
    const view = (active: boolean) => (
      <PluginHostApiProviderInternal hostApi={hostApi} surfaceActivity={{ active }}><Probe /></PluginHostApiProviderInternal>
    );
    let tree!: renderer.ReactTestRenderer;
    try {
      await act(async () => { tree = renderer.create(view(true)); });
      await act(async () => { tree.update(view(false)); });
      await act(async () => {
        if (settlement === 'established') establishWatch({ dispose });
        else refuseWatch(new Error('host watch unavailable'));
      });
      if (settlement === 'established') expect(dispose).toHaveBeenCalledOnce();
      expect(readSession).not.toHaveBeenCalled();
    } finally {
      act(() => tree?.unmount());
    }
  });

  it('keeps the same snapshot, and renders nothing, when a re-read finds the Session unchanged', async () => {
    // A watch invalidates on any Session change, including ones no consumer reads. A re-read that returns an
    // equal state must not hand every consumer (a whole page of rows) a new map to recompute from.
    const watchers = new Map<string, Parameters<PluginUiHostApi['watchSession']>[1]>();
    const base = createHostApiStub();
    const readSession = vi.fn<PluginUiHostApi['readSession']>(async () => ({ ...WORKING, workStatus: { ...WORKING.workStatus } }));
    const hostApi = createHostApiStub(undefined, {
      version: () => ({ ...base.version(), methods: ['readSession', 'watchSession'] }),
      readSession,
      watchSession: async (id, listener) => {
        watchers.set(id, listener);
        return { dispose: () => { watchers.delete(id); } };
      },
    });
    let current: SessionStatesReadV1 | undefined;
    let renders = 0;
    function Probe() { renders += 1; current = useSessionStates(['first']); return null; }
    let tree!: renderer.ReactTestRenderer;
    try {
      await act(async () => { tree = renderer.create(<PluginHostApiProvider hostApi={hostApi}><Probe /></PluginHostApiProvider>); });
      await vi.waitFor(() => expect(current?.sessions.get('first')).toMatchObject({ status: 'ready', state: WORKING }));
      const settled = current!.sessions;
      const rendersBefore = renders;
      await act(async () => { watchers.get('first')?.({ version: 1, subscriptionId: 'watch', kind: 'invalidated', digest: 'same' }); });
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(current!.sessions).toBe(settled);
      expect(renders).toBe(rendersBefore);
    } finally {
      act(() => tree?.unmount());
    }
  });

  it('shares watches for repeated ids, follows host invalidations, and retires replaced Sessions', async () => {
    // Session transport is the genuine host boundary; the mounted read/watch owner stays real.
    const watchers = new Map<string, Parameters<PluginUiHostApi['watchSession']>[1]>();
    const snapshots = new Map<string, SessionStateV1 | null>([['first', WORKING]]);
    const base = createHostApiStub();
    const hostApi = createHostApiStub(undefined, {
      version: () => ({ ...base.version(), methods: ['readSession', 'watchSession'] }),
      readSession: async (id) => snapshots.get(id) ?? null,
      watchSession: async (id, listener) => {
        if (watchers.has(id)) throw new Error('duplicate host watch');
        watchers.set(id, listener);
        return { dispose: () => { watchers.delete(id); } };
      },
    });
    let current: SessionStatesReadV1 | undefined;
    function Probe({ ids }: Readonly<{ ids: readonly string[] }>) {
      current = useSessionStates(ids);
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    const view = (ids: readonly string[]) => (
      <PluginHostApiProvider hostApi={hostApi}><Probe ids={ids} /></PluginHostApiProvider>
    );
    try {
      await act(async () => { tree = renderer.create(view(['first', 'first'])); });
      await vi.waitFor(() => expect(current?.sessions.get('first')).toMatchObject({ status: 'ready', state: WORKING }));
      const watch = watchers.get('first');
      expect(watchers.size).toBe(1);
      await act(async () => { tree.update(view(['first'])); });
      expect(watchers.get('first')).toBe(watch);

      snapshots.set('first', { ...WORKING, workStatus: { bucket: 'idle', tone: 'neutral', word: 'Ready' } });
      await act(async () => { watch?.({ version: 1, subscriptionId: 'first-watch', kind: 'invalidated', digest: 'idle' }); });
      await vi.waitFor(() => expect(current?.sessions.get('first')?.state?.workStatus.bucket).toBe('idle'));

      await act(async () => { tree.update(view(['second'])); });
      await vi.waitFor(() => expect(current?.sessions.get('second')?.status).toBe('unavailable'));
      expect(current?.sessions.has('first')).toBe(false);
      expect(watchers.has('first')).toBe(false);
      // A retired host callback cannot leak the prior row's activity into the new window.
      await act(async () => { watch?.({ version: 1, subscriptionId: 'first-watch', kind: 'invalidated', digest: 'late' }); });
      expect(current?.sessions.has('first')).toBe(false);

      snapshots.set('second', { ...WORKING, sessionId: 'second' });
      await act(async () => { current?.refresh(); });
      await vi.waitFor(() => expect(current?.sessions.get('second')).toMatchObject({ status: 'ready', state: { sessionId: 'second' } }));
    } finally {
      act(() => tree?.unmount());
    }
    expect(watchers.size).toBe(0);
  });
});
