import React from 'react';
import { createRequire } from 'node:module';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderScreen } from '@/dev/testkit';
import { evaluateInstalledExpoModule } from '@/dev/testkit/runtime/installedExpoPathSerializer';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { IModal } from '@/modal';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
    ProfileRecordV1Schema, ProfileRowsListResponseV1Schema, ProfileRowMutationV1Schema,
    ProfileRowMutationResponseV1Schema, ProfileRowReadRequestV1Schema, ProfileRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { readAiLaunchProfileRecords } from '@happier-dev/protocol/profiles/read';
import { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import {
    createNavigationMock, createRouterMock, createStackOptionsCapture,
    enableReactActEnvironment, installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();
const routerMock = createRouterMock();
const navigationMock = {
    ...createNavigationMock(), setOptions: vi.fn(), addListener: vi.fn(() => () => {}), isFocused: () => true,
};
const stackOptionsCapture = createStackOptionsCapture();
const optionsListeners = new Set<() => void>();
let optionsVersion = 0;
const subscribeOptions = (listener: () => void) => {
    optionsListeners.add(listener);
    return () => { optionsListeners.delete(listener); };
};
function useEditorNavigation() {
    React.useSyncExternalStore(subscribeOptions, () => optionsVersion, () => optionsVersion);
    return navigationMock;
}
const alertSpy = vi.fn<IModal['alert']>();
let profileData = '';
let profileId: string | undefined;
let draftId = 'draft-before';

vi.mock('expo-constants', () => ({ default: { statusBarHeight: 0 } }));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));

await installPickerCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            Platform: { isPad: false },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        });
    },
    expoRouter: async () => {
        const base = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            router: { push: routerMock.push, back: routerMock.back, replace: routerMock.replace, setParams: routerMock.setParams },
        }).module;
        const require = createRequire(import.meta.url);
        // Run the installed Screen options effect. Its native navigator is the
        // boundary: setOptions publishes a new navigation snapshot to the route.
        const sdk = await evaluateInstalledExpoModule(require.resolve('expo-router/build/views/Screen'), {
            react: React,
            '@react-navigation/native': { useRoute: () => ({ key: 'profile-edit' }) },
            '../useNavigation': { useNavigation: useEditorNavigation },
            './useSafeLayoutEffect': { useSafeLayoutEffect: React.useLayoutEffect },
        });
        const { Screen } = sdk as { Screen: React.ComponentType<{ options?: Record<string, unknown> }> };
        return {
            ...base,
            Stack: { Screen },
            useNavigation: useEditorNavigation,
            // Installed Expo decodes into a fresh object on every render.
            useLocalSearchParams: () => ({ profileData, profileId, draftId }),
        };
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { alert: alertSpy },
    }).module,
});
const profileRows = new Map<string, Readonly<{ record: ProfileRecordV1; revision: number }>>();
let profileRevision = 1;
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
    }));
    if (path === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') {
        const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain Profile authoring');
        const record = ProfileRecordV1Schema.parse(mutation.content.v);
        profileRows.set(record.id, { record, revision: ++profileRevision });
        return Response.json(ProfileRowMutationResponseV1Schema.parse({ status: 'updated', revision: profileRevision,
            cursor: profileRevision, referenceGuardRevision: profileRevision }));
    }
    if (path === PROFILE_RECORD_READ_ROUTE_V1 && init?.method === 'POST') {
        const { id } = ProfileRowReadRequestV1Schema.parse(JSON.parse(String(init.body)));
        const row = profileRows.get(id);
        return Response.json(ProfileRowReadResponseV1Schema.parse(row
            ? { status: 'present', revision: row.revision, content: { t: 'plain', v: row.record } }
            : { status: 'absent' }));
    }
    if (path === PROFILE_ROWS_ROUTE_V1) return Response.json(ProfileRowsListResponseV1Schema.parse({
        status: 'listed', rows: [...profileRows.values()].map(row => ({ id: row.record.id,
            revision: row.revision, content: { t: 'plain', v: row.record } })),
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: profileRevision,
        transferControl: { status: 'absent' },
    }));
    if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: profileRevision });
    if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
    return null;
} });

beforeEach(async () => {
    const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');
    profileData = JSON.stringify({ ...createEmptyCustomProfile(), id: 'p1', name: 'Test profile' });
    profileId = undefined;
    draftId = 'draft-before';
    profileRows.clear();
    profileRevision = 1;
    stackOptionsCapture.reset();
    alertSpy.mockClear();
    navigationMock.goBack.mockClear();
    navigationMock.dispatch.mockClear();
    navigationMock.setOptions.mockClear();
    navigationMock.setOptions.mockImplementation((options: Record<string, unknown>) => {
        stackOptionsCapture.record({ ...stackOptionsCapture.getResolved(), ...options });
        optionsVersion += 1;
        optionsListeners.forEach(listener => listener());
    });
    routerMock.back.mockClear();
    routerMock.replace.mockClear();
});
afterEach(() => resetProfileCatalogSnapshotsForTests());

async function renderProfileEditor() {
    const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
    const screen = await renderScreen(React.createElement(runtime.Wrapper, {
        children: React.createElement(ProfileEditScreen),
    }));
    return screen;
}

function pressHeaderClose() {
    const button = stackOptionsCapture.getResolved()?.headerLeft?.();
    if (!button?.props.onPress) throw new Error('Expected editor close action');
    button.props.onPress();
}
async function closeAndFlush() {
    await act(async () => { pressHeaderClose(); });
}
async function editName(screen: Awaited<ReturnType<typeof renderProfileEditor>>, name = 'Edited profile') {
    await vi.waitFor(() => expect(screen.findHostByTestId('profile-slim-name') ?? screen.findHostByTestId('profile-legacy-name')).not.toBeNull());
    const field = screen.findHostByTestId('profile-slim-name') ?? screen.findHostByTestId('profile-legacy-name');
    if (!field || typeof field.props.onChangeText !== 'function') throw new Error('Expected actual profile name input');
    await act(async () => field.props.onChangeText(name));
    expect(stackOptionsCapture.getResolved()?.headerRight?.()?.props.disabled).toBe(false);
}
async function chooseDecision(text: string) {
    const buttons = alertSpy.mock.calls.at(-1)?.[2];
    const button = buttons?.find((candidate) => candidate.text === text);
    if (!button?.onPress) throw new Error('Expected unsaved-changes decision: ' + text);
    await act(async () => { button.onPress?.(); });
}
function savedProfiles() {
    return readAiLaunchProfileRecords([...profileRows.values()].map(row => row.record)).entries.map(entry => {
        if (entry.kind === 'opaque') throw new Error('Expected readable saved Profile');
        return entry.profile;
    });
}

describe('ProfileEditScreen (header buttons)', () => {
    it('keeps a pristine form unsaveable and closes it without a prompt through the real keyboard-aware form', async () => {
        const screen = await renderProfileEditor();
        const { KeyboardAwareScreen } = await import('@/components/ui/keyboardAvoidance');
        const { KeyboardAwareScrollView } = await import('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView');
        // The editor's keyboard-aware list is the single keyboard owner; a screen frame would double it.
        expect(screen.findAllByType(KeyboardAwareScreen)).toHaveLength(0);
        expect(screen.findAllByType(KeyboardAwareScrollView)).toHaveLength(1);
        expect(stackOptionsCapture.getResolved()?.headerRight?.()?.props.disabled).toBe(true);
        expect(typeof stackOptionsCapture.getResolved()?.headerLeft).toBe('function');
        await closeAndFlush();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(navigationMock.goBack).toHaveBeenCalledOnce();
    });

    it('uses the latest route fallback when the stable header Cancel is invoked', async () => {
        await renderProfileEditor();
        draftId = 'draft-after';
        await act(async () => { optionsVersion += 1; optionsListeners.forEach(listener => listener()); });
        const state = vi.spyOn(navigationMock, 'getState').mockReturnValue({
            index: 0, routes: [{ key: 'profile-edit' }],
        });
        try {
            await closeAndFlush();
            expect(routerMock.replace).toHaveBeenCalledWith({
                pathname: '/new', params: expect.objectContaining({ draftId: 'draft-after' }),
            });
            expect(navigationMock.goBack).not.toHaveBeenCalled();
        } finally {
            state.mockRestore();
        }
    });

    it('explains a same-Home stale row refusal through the actual save header but stays silent after leaving Home', async () => {
        const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Expected connected runtime Home');
        const record: ProfileRecordV1 = { v: 1, id: 'p1', definition: { kind: 'inline',
            profile: { ...createEmptyCustomProfile(), id: 'p1', name: 'Test profile' } },
            enabled: true, promptStack: [], secretBindings: { MASKED: null }, skillSeeds: [] };
        const publish = (revision: number) => {
            profileRevision = revision;
            profileRows.set(record.id, { record, revision });
            applyProfileCatalogSnapshot(scope, {
            status: 'ready', source: 'destination', authority: 'active', control: null,
            controlRevision: 1, referenceGuardRevision: 1, diagnostics: [], records: [{ record, revision }],
            }, true);
        };
        publish(7);
        profileData = '';
        profileId = 'p1';
        const screen = await renderProfileEditor();
        await editName(screen);
        await act(async () => publish(8));
        const save = stackOptionsCapture.getResolved()?.headerRight?.()?.props.onPress;
        if (!save) throw new Error('Expected actual header save action');
        await act(async () => save());
        expect(alertSpy).toHaveBeenCalledWith('common.error', 'profile_revision_conflict');
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(navigationMock.goBack).not.toHaveBeenCalled();

        alertSpy.mockClear();
        await act(async () => storage.setState({ settingsScope: { ...scope, accountId: 'other-account' } }));
        await act(async () => save());
        expect(alertSpy).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
    });

    it('serializes repeated dirty closes into one presented prompt and discarded continuation', async () => {
        const screen = await renderProfileEditor();
        await editName(screen);
        await act(async () => { pressHeaderClose(); pressHeaderClose(); });
        expect(alertSpy).toHaveBeenCalledOnce();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        await chooseDecision('common.discard');
        expect(navigationMock.goBack).toHaveBeenCalledOnce();
        expect(savedProfiles()).toEqual([]);
    });

    it('keeps the dirty editor open after the presented keep-editing decision', async () => {
        const screen = await renderProfileEditor();
        await editName(screen);
        await closeAndFlush();
        expect(alertSpy).toHaveBeenCalledOnce();
        await chooseDecision('common.keepEditing');
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(savedProfiles()).toEqual([]);
    });

    it('lets a real successful save own the destination instead of continuing dirty close', async () => {
        const screen = await renderProfileEditor();
        await editName(screen);
        await closeAndFlush();
        await chooseDecision('common.save');
        expect(savedProfiles()).toEqual([expect.objectContaining({ id: 'p1', v: 2, name: 'Edited profile' })]);
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        expect(routerMock.replace).toHaveBeenCalledWith({ pathname: '/new', params: expect.objectContaining({ profileId: 'p1' }) });
    });

    it('opens the guided migration before editing a builtin from the picker', async () => {
        const { DEFAULT_PROFILES, getBuiltInProfile } = await import('@/sync/domains/profiles/profileUtils');
        const builtIn = getBuiltInProfile(DEFAULT_PROFILES[0].id);
        if (!builtIn) throw new Error('Expected canonical built-in profile');
        // Match the current picker's Edit producer and its named Profile lookup.
        profileData = '';
        profileId = builtIn.id;
        const screen = await renderProfileEditor();
        const { LegacyProfileMigrationFlow } = await import('@/components/profiles/migration/LegacyProfileMigrationFlow');
        await vi.waitFor(() => expect(screen.findAllByType(LegacyProfileMigrationFlow)).toHaveLength(1));
        expect(screen.findHostByTestId('profile-legacy-name')).toBeNull();
        expect(screen.findHostByTestId('profile-slim-name')).toBeNull();
        expect(stackOptionsCapture.getResolved()?.headerRight?.()?.props.disabled).toBe(true);
        await closeAndFlush();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(savedProfiles()).toEqual([]);
        expect(getBuiltInProfile(builtIn.id)).toEqual(builtIn);
        expect(navigationMock.goBack).toHaveBeenCalledOnce();
    });
});
