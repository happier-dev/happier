import { act } from 'react';
import renderer from 'react-test-renderer';
import type { PluginUiHostApi, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { PluginHostApiProvider } from '../advanced/index.js';
import { createHostApiStub } from '../surfaceFixture.testSupport.js';
import { useSessionStates, type SessionStatesReadV1 } from './sessionState.public.js';

const WORKING: SessionStateV1 = {
  sessionId: 'first', lifecycle: 'active', runtime: 'working', operational: 'working',
  pendingPermissions: [], workStatus: { bucket: 'working', tone: 'neutral', word: 'Working' },
};

describe('useSessionStates', () => {
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
