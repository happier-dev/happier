import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import {
    SESSION_SUMMARY_COMPANION_ITEM,
    type SessionCompanionItemRefV1,
} from '@/components/sessions/companion/state/sessionCompanionPreference';
import {
    useSessionCompanionController,
    type SessionCompanionMutationOutcome,
} from '@/components/sessions/companion/state/useSessionCompanionController';
import { storage } from '@/sync/domains/state/storageStore';
import { applyLocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';
import { readSessionCompanionPreferenceSlotFromState, useSessionCompanionPreferenceSlot } from './hooks';

const activeServerRuntimeState = vi.hoisted(() => ({
    listener: null as null | ((snapshot: { serverId: string; serverUrl: string; generation: number }) => void),
    snapshot: { serverId: 'active-server', serverUrl: 'https://example.com', generation: 1 },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerRuntimeState.snapshot,
    subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        activeServerRuntimeState.listener = listener;
        return () => {
            if (activeServerRuntimeState.listener === listener) activeServerRuntimeState.listener = null;
        };
    },
}));

afterEach(async () => {
    activeServerRuntimeState.listener = null;
    standardCleanup();
    await resetPersistentUiStateForTest();
});

const COMPANION_KEY_ACCOUNT_A = 'session-companion:v1:session:13:active-server9:account-a:9:session-1';
const COMPANION_KEY_ACCOUNT_B = 'session-companion:v1:session:13:active-server9:account-b:9:session-1';

const widget = (widgetId: string): SessionCompanionItemRefV1 => ({ kind: 'widget', widgetId });

function readCompanionSettings(): Record<string, unknown> {
    return storage.getState().localSettings.sessionCompanionPreferencesBySessionV1 ?? {};
}

async function renderController(options: Readonly<{
    accountId?: string | null;
    seed?: Readonly<Record<string, unknown>>;
    sessionId?: string | null;
}> = {}) {
    storage.setState((state) => ({
        ...state,
        settings: settingsParse({ ...state.settings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }),
        profileScope: options.accountId === null
            ? null
            : { serverId: 'active-server', accountId: options.accountId ?? 'account-a' },
        localSettings: applyLocalSettings(state.localSettings, {
            sessionCompanionPreferencesBySessionV1: { ...(options.seed ?? {}) },
        }),
    }));
    return await renderHook(() => useSessionCompanionController({
        sessionId: options.sessionId === undefined ? 'session-1' : options.sessionId,
        serverId: 'active-server',
        openFullSurface: () => {},
    }), { flushOptions: { cycles: 1, turns: 4 } });
}

describe('useSessionCompanionController', () => {
    it('reads authored preferences without importing development visibility carriers or writing on mount', async () => {
        const before = storage.getState();
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            const hook = await renderController({ seed: { [COMPANION_KEY_ACCOUNT_A]: {
                v: 1, visible: true, collapsed: true, edge: 'leading', density: 'compact', items: [widget('mine')],
            } } });
            expect(hook.getCurrent().preference).toMatchObject({ visible: false, collapsed: false, edge: 'leading', items: [widget('mine')] });
            expect(writes).not.toHaveBeenCalled();
            await hook.unmount();
        } finally { writes.mockRestore(); storage.setState(before); }
    });

    it('persists an interaction on the implicit Companion without creating authored Settings', async () => {
        const previousState = storage.getState();
        const hook = await renderController();
        const settings = storage.getState().localSettings;
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            await act(async () => { hook.getCurrent().setCollapsed(true); });
            expect(hook.getCurrent().preference).toMatchObject({ visible: false, collapsed: true, items: [] });
            expect(storage.getState().localSettings).toBe(settings);
            expect(readCompanionSettings()).toEqual({});
            expect(writes).toHaveBeenCalledTimes(1);
        } finally {
            writes.mockRestore();
            await hook.unmount();
            storage.setState(previousState);
        }
    });

    it('persists collapse and visibility per realm without Settings writes and restores them on reopen', async () => {
        const previousState = storage.getState();
        const legacy = { v: 1, edge: 'trailing', density: 'compact', items: [SESSION_SUMMARY_COMPANION_ITEM] };
        const hook = await renderController({ seed: { [COMPANION_KEY_ACCOUNT_A]: legacy } });
        await act(async () => { hook.getCurrent().show(); });
        const settings = storage.getState().localSettings;
        const otherRenders = vi.fn();
        const otherSession = await renderHook(() => {
            otherRenders();
            return useSessionCompanionPreferenceSlot('session-2', 'active-server');
        });
        const initialOtherRenders = otherRenders.mock.calls.length;
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        const settingsPublications = vi.fn();
        const stop = storage.subscribe((next, previous) => {
            if (next.localSettings !== previous.localSettings) settingsPublications();
        });
        try {
            await act(async () => { hook.getCurrent().setCollapsed(true); });
            expect(hook.getCurrent().preference.collapsed).toBe(true);
            expect(storage.getState().localSettings).toBe(settings);
            expect(writes).toHaveBeenCalledTimes(1);
            await act(async () => { hook.getCurrent().setCollapsed(true); });
            expect(writes).toHaveBeenCalledTimes(1);
            await act(async () => { hook.getCurrent().hide(); });
            expect(hook.getCurrent().preference.visible).toBe(false);
            expect(writes).toHaveBeenCalledTimes(2);
            expect(settingsPublications).toHaveBeenCalledTimes(0);
            expect(otherRenders).toHaveBeenCalledTimes(initialOtherRenders);
            expect(readSessionCompanionPreferenceSlotFromState(storage.getState(), 'session-1', 'active-server', 'active-server').stored)
                .toMatchObject({ visible: false, collapsed: true });
            expect(readCompanionSettings()[COMPANION_KEY_ACCOUNT_A]).toEqual(legacy);
            await otherSession.unmount();
            await hook.unmount();
            const reopened = await renderController({ seed: { [COMPANION_KEY_ACCOUNT_A]: legacy } });
            expect(reopened.getCurrent().preference).toMatchObject({ visible: false, collapsed: true });
            await reopened.unmount();
            const otherAccount = await renderController({ accountId: 'account-b', seed: { [COMPANION_KEY_ACCOUNT_A]: legacy } });
            expect(otherAccount.getCurrent().preference).toMatchObject({ visible: false, collapsed: false });
            await otherAccount.unmount();
        } finally {
            stop();
            writes.mockRestore();
            await otherSession.unmount();
            await hook.unmount();
            storage.setState(previousState);
        }
    });

    it('reads the current Account realm entry and never a bare or foreign-realm key', async () => {
        const previousState = storage.getState();
        try {
            const hook = await renderController({
                seed: {
                    'session-1': { v: 1, edge: 'leading', density: 'comfortable', items: [] },
                    [COMPANION_KEY_ACCOUNT_B]: {
                        v: 1, edge: 'leading', density: 'comfortable', items: [widget('other')],
                    },
                    [COMPANION_KEY_ACCOUNT_A]: {
                        v: 1, edge: 'trailing', density: 'compact', items: [widget('mine')],
                    },
                },
            });

            expect(hook.getCurrent().availability).toBe('ready');
            expect(hook.getCurrent().preference.items).toEqual([widget('mine')]);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('refuses persistence for an unproven realm and falls back to the hidden preference', async () => {
        const previousState = storage.getState();
        try {
            const hook = await renderController({
                accountId: null,
                seed: {
                    [COMPANION_KEY_ACCOUNT_A]: {
                        v: 1, edge: 'trailing', density: 'compact', items: [widget('mine')],
                    },
                },
            });

            expect(hook.getCurrent().availability).toBe('realm_unavailable');
            expect(hook.getCurrent().preference.visible).toBe(false);
            expect(hook.getCurrent().preference.items).toEqual([]);

            await act(async () => {
                hook.getCurrent().show();
            });

            expect(readCompanionSettings()[COMPANION_KEY_ACCOUNT_A]).toEqual({
                v: 1, edge: 'trailing', density: 'compact', items: [widget('mine')],
            });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not write a default merely because a Session was opened', async () => {
        const previousState = storage.getState();
        try {
            const hook = await renderController();

            expect(hook.getCurrent().preference.visible).toBe(false);
            expect(readCompanionSettings()).toEqual({});
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('remembers the built-in Session Summary in one realm with Settings writes Off', async () => {
        const previousState = storage.getState();
        try {
            const hook = await renderController();

            await act(async () => {
                hook.getCurrent().show();
            });

            expect(Object.keys(readCompanionSettings())).toEqual([COMPANION_KEY_ACCOUNT_A]);
            expect(readCompanionSettings()[COMPANION_KEY_ACCOUNT_A]).toEqual({
                v: 1, edge: 'trailing', density: 'compact',
                items: [SESSION_SUMMARY_COMPANION_ITEM, ...(['environment', 'running', 'usage', 'links'] as const).map(id => ({ kind: 'builtin', id }))],
            });
            expect(hook.getCurrent().preference.visible).toBe(true);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('never rewrites a preference written by a newer client while only reading it', async () => {
        const previousState = storage.getState();
        const future = { v: 4, visible: true, edge: 'leading', railGroups: [{ id: 'g1' }] };
        try {
            const hook = await renderController({ seed: { [COMPANION_KEY_ACCOUNT_A]: future } });

            expect(hook.getCurrent().preference.visible).toBe(false);
            expect(readCompanionSettings()[COMPANION_KEY_ACCOUNT_A]).toEqual(future);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('applies against the latest stored entry so a stale render cannot drop a concurrent change', async () => {
        const previousState = storage.getState();
        try {
            const hook = await renderController();
            const staleController = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    localSettings: {
                        ...state.localSettings,
                        sessionCompanionPreferencesBySessionV1: {
                            'session-companion:v1:session:13:active-server9:account-a:9:session-9': {
                                v: 1, edge: 'leading', density: 'compact', items: [widget('elsewhere')],
                            },
                            [COMPANION_KEY_ACCOUNT_A]: {
                                v: 1, edge: 'trailing', density: 'compact', items: [widget('added-later')],
                            },
                        },
                    },
                }));
            });

            await act(async () => {
                staleController.addItem(widget('from-stale-render'));
            });

            const settings = readCompanionSettings();
            expect(settings['session-companion:v1:session:13:active-server9:account-a:9:session-9']).toBeDefined();
            expect(settings[COMPANION_KEY_ACCOUNT_A]).toEqual({
                v: 1, edge: 'trailing', density: 'compact',
                items: [widget('added-later'), widget('from-stale-render')],
            });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('restores a safe local inverse only while the applied preference is unchanged', async () => {
        const previousState = storage.getState();
        try {
            const hook = await renderController({
                seed: {
                    [COMPANION_KEY_ACCOUNT_A]: {
                        v: 1, edge: 'trailing', density: 'compact',
                        items: [SESSION_SUMMARY_COMPANION_ITEM, widget('mine')],
                    },
                },
            });

            let outcome: SessionCompanionMutationOutcome | null = null;
            await act(async () => {
                outcome = hook.getCurrent().removeItem(widget('mine'));
            });
            expect(outcome).not.toBeNull();
            expect(hook.getCurrent().preference.items).toEqual([SESSION_SUMMARY_COMPANION_ITEM]);

            await act(async () => {
                expect(hook.getCurrent().applyLocalInverse(outcome!)).toBe(true);
            });
            expect(hook.getCurrent().preference.items).toEqual([SESSION_SUMMARY_COMPANION_ITEM, widget('mine')]);

            // A newer manual change makes the same inverse inert instead of
            // overwriting what the person just chose.
            await act(async () => {
                hook.getCurrent().setEdge('leading');
            });
            await act(async () => {
                expect(hook.getCurrent().applyLocalInverse(outcome!)).toBe(false);
            });
            expect(hook.getCurrent().preference.edge).toBe('leading');
            expect(hook.getCurrent().preference.items).toEqual([SESSION_SUMMARY_COMPANION_ITEM, widget('mine')]);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('hides the card when the last item is removed without touching shared content', async () => {
        const previousState = storage.getState();
        try {
            const hook = await renderController({
                seed: {
                    [COMPANION_KEY_ACCOUNT_A]: {
                        v: 1, edge: 'trailing', density: 'compact', items: [widget('mine')],
                    },
                },
            });

            await act(async () => {
                hook.getCurrent().removeItem(widget('mine'));
            });

            expect(hook.getCurrent().preference).toMatchObject({ visible: false, items: [] });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
