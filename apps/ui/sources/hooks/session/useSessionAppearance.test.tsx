import { afterEach, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionListSurfaceDataActiveProvider, useSessionListSurfaceDataActiveSignal } from '@/components/sessions/shell/surface/sessionListSurfaceDataActive';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationLabelKey, buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { useEffectiveSessionAppearanceColor, useSessionOwnAppearanceColor, useCustomSessionAppearanceColors } from './useSessionAppearance';

afterEach(standardCleanup);

it('retains a covered row colour without rendering and catches up when the surface returns', async () => {
    const before = storage.getState();
    const key = buildSessionOrganizationSessionKey('appearance-covered', 'one');
    const appearance = (hex: `#${string}`) => ({ sessionId: 'one',
        display: { t: 'plain' as const, v: { color: { kind: 'custom' as const, hex } } },
        displayState: { status: 'available' as const, value: null }, updatedAt: 1 });
    storage.setState({ sessionOrganizationAppearancesBySessionKey: { [key]: appearance('#abc') } });
    let shown: ReturnType<typeof useEffectiveSessionAppearanceColor> = null;
    let renders = 0;
    function RowColour() {
        const gate = useSessionListSurfaceDataActiveSignal();
        shown = useEffectiveSessionAppearanceColor('appearance-covered', 'one', null, gate);
        renders++;
        return null;
    }
    const row = <RowColour />;
    const surface = (dataActive: boolean) => (
        <SessionListSurfaceDataActiveProvider dataActive={dataActive}>{row}</SessionListSurfaceDataActiveProvider>
    );
    const screen = await renderScreen(surface(true));
    try {
        expect(shown).toEqual({ kind: 'custom', hex: '#AABBCC' });
        await screen.update(surface(false));
        renders = 0;
        await act(async () => storage.setState({ sessionOrganizationAppearancesBySessionKey: { [key]: appearance('#123') } }));
        expect(shown).toEqual({ kind: 'custom', hex: '#AABBCC' });
        expect(renders).toBe(0);
        await screen.update(surface(true));
        expect(shown).toEqual({ kind: 'custom', hex: '#112233' });
    } finally {
        await screen.unmount();
        storage.setState(before);
    }
});

it('subscribes to only the consumed colour and keeps closed consumers inert', async () => {
    const before = storage.getState();
    const key = buildSessionOrganizationSessionKey('appearance-hooks', 'one');
    const appearance = { sessionId: 'one', display: { t: 'plain' as const, v: { color: { kind: 'custom', hex: '#abc' } } },
        displayState: { status: 'available' as const, value: null }, updatedAt: 1 };
    storage.setState({ sessionOrganizationLabelsByLabelKey: {
        [buildSessionOrganizationLabelKey({ serverId: 'appearance-hooks', labelKind: 'workspace', scopeKey: 'workspace' })]: {
            labelKind: 'workspace', scopeKey: 'workspace', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#123' } } },
            displayState: { status: 'available', value: null }, createdAt: 1, updatedAt: 1, archivedAt: null,
        },
    }, sessionOrganizationAppearancesBySessionKey: {
        ...Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [buildSessionOrganizationSessionKey('appearance-hooks', `other-${i}`), { ...appearance, sessionId: `other-${i}` }])),
        [key]: appearance,
    } });
    let activeRenders = 0;
    let closedRenders = 0;
    const active = await renderHook(() => { activeRenders++; return {
        own: useSessionOwnAppearanceColor('appearance-hooks', 'one'),
        effective: useEffectiveSessionAppearanceColor('appearance-hooks', 'one', 'workspace'),
    }; });
    const closed = await renderHook(() => { closedRenders++; return useCustomSessionAppearanceColors('appearance-hooks', { enabled: false }); });
    try {
        expect(active.getCurrent()).toEqual({ own: { kind: 'custom', hex: '#AABBCC' }, effective: { kind: 'custom', hex: '#AABBCC' } });
        activeRenders = 0; closedRenders = 0;
        await act(async () => storage.setState({ sessionOrganizationAppearancesBySessionKey: {
            ...storage.getState().sessionOrganizationAppearancesBySessionKey,
            [buildSessionOrganizationSessionKey('other-home', 'one')]: { ...appearance, updatedAt: 2 },
        } }));
        expect(activeRenders).toBe(0);
        expect(closedRenders).toBe(0);
        await act(async () => storage.setState({ sessionOrganizationAppearancesBySessionKey: {} }));
        expect(active.getCurrent()).toEqual({ own: null, effective: { kind: 'custom', hex: '#112233' } });
        expect(activeRenders).toBe(1);
        expect(closedRenders).toBe(0);
    } finally {
        await active.unmount(); await closed.unmount(); storage.setState(before);
    }
});
