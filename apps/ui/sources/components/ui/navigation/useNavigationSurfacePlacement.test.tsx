import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { StoredNavigationSurfacePlacementsV1Schema } from '@/sync/domains/settings/mobileSurfacePinning';
import { navigationPlacementStorageBinding } from '@/components/settings/appearance/navigationPlacementSettingBinding';
import { useNavigationSurfacePlacement } from './useNavigationSurfacePlacement';

const initial = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(initial, true); });

it('keeps a Session desktop subscriber idle for Machine phone edits and unrelated Session arrivals', async () => {
    let renders = 0;
    const sessionRail = { orderedIds: ['files'], placements: {} };
    storage.setState(state => ({ localSettings: { ...state.localSettings, navigationSurfacePlacementsV1: { sessionRail } } }));
    const observed: unknown[] = [];
    function SessionDesktop() {
        renders++;
        observed.push(useNavigationSurfacePlacement({ pageKind: 'session', device: 'desktop', section: 'companions' }).preferences);
        return null;
    }
    await renderScreen(<SessionDesktop />);
    const mounted = renders;
    // The canonical local-settings writer merges the Machine phone edit (unchanged surfaces keep their identity).
    const patch = navigationPlacementStorageBinding.parse({ detailPages: { machine: { phone: { items: { orderedIds: [], placements: {} } } } } });
    if (!patch.success) throw new Error('Expected a valid Machine phone placement');
    await act(async () => navigationPlacementStorageBinding.commit(storage.getState().localSettings, patch.value,
        delta => storage.getState().applyLocalSettings(delta, { persist: false })));
    await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
        unrelated: createSessionFixture({ id: 'unrelated', serverId: 'other-home' }),
    } })));
    expect(renders - mounted).toBe(0);
    expect(observed.at(-1)).toBe(sessionRail);
});

it('reads newer stored detail preferences by stripping unknown fields at every stored boundary', () => {
    const parsed = StoredNavigationSurfacePlacementsV1Schema.safeParse({ detailPages: { machine: {
        future: true, phone: { future: true, items: { orderedIds: [], placements: {}, future: true } },
    } } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.detailPages?.machine).toEqual({ phone: { items: { orderedIds: [], placements: {} } } });
});
