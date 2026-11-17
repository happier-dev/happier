import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { useCollectionColumnPreferences } from './useCollectionColumnPreferences';
const initial = storage.getState();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(initial, true); });
it('subscribes once per Collection and leaves A idle when reconstructed A equals stored A during a B write', async () => {
 const saved = { orderedIds: [], placements: {} };
 storage.setState(state => ({ settings: { ...state.settings, collectionColumnPreferencesV1: { a: saved } } }));
 const subscribe = vi.spyOn(storage, 'subscribe'); // Instrument the real subscription boundary, without replacing it.
 const renders = { a: 0, b: 0 };
 function Probe({ id }: { id: 'a' | 'b' }) { renders[id]++; useCollectionColumnPreferences(id); return null; }
 await renderScreen(<><Probe id="a" /><Probe id="a" /><Probe id="b" /></>);
 const mounted = { ...renders };
 expect(subscribe.mock.calls.filter(call => {
   const options = call[1];
   return options && typeof options === 'object' && 'settings' in options && Array.isArray(options.settings)
     && options.settings.includes('collectionColumnPreferencesV1');
 }).length).toBe(2);
 await act(async () => storage.setState(state => ({ settings: { ...state.settings, collectionColumnPreferencesV1: {
   a: { orderedIds: [], placements: {} }, b: { orderedIds: [], placements: { state: 'hidden' } },
 } } })));
 expect(renders.a - mounted.a).toBe(0);
 expect(renders.b - mounted.b).toBe(1);
});
