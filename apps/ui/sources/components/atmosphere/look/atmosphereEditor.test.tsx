import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES, releaseLook } from '@happier-dev/brand/atmosphere';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Select the genuine browser persistence adapter over the fake IndexedDB system boundary.
vi.mock('@/components/atmosphere/pictureStore', async () => import('../pictureStore.web'));

vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { AtmosphereWhereItShows } = await import('@/components/settings/appearance/AtmosphereAppearanceRows');
const { useHomeAtmosphereEditor } = await import('./atmosphereEditor');
const { pictureStore } = await import('../pictureStore');
const originalState = storage.getState();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(originalState, true); });

async function chooseShowOn(screen: Awaited<ReturnType<typeof renderScreen>>, mode: 'everywhere' | 'home' | 'custom', presentation: 'page' | 'panel' = 'page') {
    if (presentation === 'panel') {
        await screen.pressByTestIdAsync(`look-show-on:${mode}`);
        return;
    }
    await screen.pressByTestIdAsync('atmosphere-show-on');
    await vi.waitFor(() => expect(screen.findAllHostsByTestId(`atmosphere-show-on:${mode}`).length).toBeGreaterThan(0));
    await screen.pressByTestIdAsync(`atmosphere-show-on:${mode}`);
}

describe('Home Atmosphere editor through declared Settings Actions', () => {
    it('admits the real Show background on control under Off, Ask reject/approve and Allowed', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ memoryUseInNewSessions: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const alert = vi.spyOn(Modal, 'alert');
        try {
            const screen = await renderScreen(<AtmosphereWhereItShows />);
            await chooseShowOn(screen, 'everywhere');
            await vi.waitFor(() => expect(alert).toHaveBeenCalled());
            expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(false);
            expect(account.settingsWrites).toEqual([]);

            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await chooseShowOn(screen, 'everywhere');
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.settingsWrites).toEqual([]);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(false);

            await chooseShowOn(screen, 'everywhere');
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(true));
            expect(storage.getState().settings.homeAtmosphere.showOn.includes('sessions')).toBe(true);

            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await chooseShowOn(screen, 'home');
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(false));
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            expect(account.artifacts.list()).toHaveLength(2);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('edits the latest Home snapshot and preserves custom pictures, sibling fields and absent catalog choices', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ memoryUseInNewSessions: false,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const localId = 'atmosphere-editor-picture';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['pixels'], { type: 'image/webp' }) });
        try {
            const editor = await renderHook(() => useHomeAtmosphereEditor());
            const staleUpdate = editor.getCurrent().update;
            const staleHomeUpdate = editor.getCurrent().updateHome;
            const currentHome = { ...account.persistedSettings.homeAtmosphere, source: 'picture' as const,
                picture: { ref: { kind: 'user' as const, localId }, layout: 'horizon' as const },
                showOn: ['home', 'new-session', 'projects', 'sessions'], moments: { ...account.persistedSettings.homeAtmosphere.moments, welcome: false },
                looks: { 'acme.gallery/aurora': { look: 'fine' as const, strength: 1 }, [localId]: { look: 'engraving' as const } },
            };
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, homeAtmosphere: currentHome })); });
            await act(async () => { await staleUpdate(current => ({ ...current, picture: { ...current.picture, layout: 'wallpaper' } })); });
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.picture.layout).toBe('wallpaper'));
            expect(account.persistedSettings.homeAtmosphere).toMatchObject({ ...currentHome,
                picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' } });
            expect(editor.getCurrent().value).toEqual(account.persistedSettings.homeAtmosphere);
            expect(await pictureStore.get(localId)).toMatchObject({ kind: 'user' });

            const picture = ATMOSPHERE_PICTURES[0]!;
            const release = releaseLook(picture);
            await act(async () => { await staleHomeUpdate(current => ({ ...current,
                looks: { ...current.looks, [picture.id]: { look: release.effect, strength: release.strength, dissolve: release.fade } },
            })); });
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.looks).toEqual(currentHome.looks));
            expect(account.persistedSettings.homeAtmosphere.picture.layout).toBe('wallpaper');
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);

            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const before = account.persistedSettings.homeAtmosphere;
            expect(await createDefaultActionExecutor().execute('settings.set', { anchor: 'appearance.homeAtmosphere',
                value: { ...before, picture: { ...before.picture, ref: { kind: 'user', localId: 17 } } },
            }, { surface: 'ui', authority: 'present_user', serverId: account.scope.serverId }))
                .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
            expect(account.persistedSettings.homeAtmosphere).toEqual(before);
        } finally { standardCleanup(); await pictureStore.remove(localId); await account.dispose(); }
    });
});
