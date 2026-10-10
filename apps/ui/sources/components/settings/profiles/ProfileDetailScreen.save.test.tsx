import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ProfileRowMutationV1Schema, PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { AlertButton } from '@/modal/types';
import { HeaderHeightContext } from '@react-navigation/elements';
import { LaunchProfileEditForm } from '@/components/profiles/edit';
import { createEmptyCustomProfile } from '@/sync/domains/profiles/profileMutations';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), dispatch: vi.fn(), dirty: false,
    beforeRemove: null as ((event: { data: { action: unknown } }) => void) | null,
}));
const alerts = vi.hoisted(() => vi.fn<(title: string, message?: string, buttons?: AlertButton[]) => void>());
const routeParams = vi.hoisted(() => ({ agentType: 'claude', cloneFromProfileId: undefined as string | undefined }));
// Platform navigation, native styling and modal presentation are external boundaries.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => routeParams,
    router: { replace: navigation.replace, back: navigation.back, canGoBack: () => true },
    navigation: { dispatch: navigation.dispatch, setOptions: () => undefined, canGoBack: () => true,
        getState: () => ({ index: 1, routes: [{ key: 'composer', name: 'new' }, { key: 'editor', name: 'new/pick/profile-edit' }] }),
    },
}).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({
    usePreventRemove: (enabled, callback) => { navigation.dirty = enabled; navigation.beforeRemove = callback; },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert: alerts } }).module);

import { storage } from '@/sync/domains/state/storageStore';
import { refreshProfileCatalog, resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { ProfileDetailScreen } from './ProfileDetailScreen';
import ProfileEditScreen from '@/app/(app)/new/pick/profile-edit';

installDisconnectedServerSocketBoundary();

async function setupAcknowledgedSave(options: Readonly<{ initialRecord?: ProfileRecordV1; holdInitialCatalog?: boolean }> = {}) {
        await loadSyncSingletonForTests();
        const initial = storage.getState();
        navigation.replace.mockClear();
        navigation.back.mockClear();
        navigation.dispatch.mockClear();
        alerts.mockClear();
        routeParams.cloneFromProfileId = undefined;
        const acknowledgement = createDeferred<Response>();
        const catalogRelease = createDeferred<void>();
        let holdCatalog = options.holdInitialCatalog ?? false;
        let catalogFailed = false;
        const rows: Array<{ id: string; revision: number; content: unknown }> = options.initialRecord
            ? [{ id: options.initialRecord.id, revision: 1, content: { t: 'plain', v: options.initialRecord } }] : [];
        let writtenId: string | null = null;
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://profile-save.example.test', accountId: 'alice', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_ROWS_ROUTE_V1) {
                if (holdCatalog) await catalogRelease.promise;
                if (catalogFailed) return new Response(null, { status: 503 });
                return Response.json({ status: 'listed', rows, nextCursor: null, complete: true,
                    diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } });
            }
            if (path === PROFILE_RECORDS_ROUTE_V1) {
                const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
                writtenId = mutation.id;
                const response = await acknowledgement.promise;
                const outcome: unknown = await response.clone().json();
                if (typeof outcome === 'object' && outcome !== null && 'status' in outcome && outcome.status === 'updated') {
                    rows.push({ id: mutation.id, revision: 1, content: mutation.content });
                }
                return response;
            }
            return new Response(null, { status: 404 });
        } });
        onTestFinished(async () => {
            catalogRelease.resolve();
            acknowledgement.resolve(Response.json({ status: 'conflict', revision: 1 }));
            await connection.dispose();
            resetProfileCatalogEngineForTests();
            resetProfileCatalogSnapshotsForTests();
            storage.setState(initial, true);
        });
        const scope = { serverId: connection.home.id, accountId: 'alice' };
        storage.getState().activateProfileScope(scope);
        if (!options.holdInitialCatalog) await refreshProfileCatalog(scope);
        return {
            loadCatalog: () => { holdCatalog = false; catalogRelease.resolve(); },
            failCatalog: () => { catalogFailed = true; holdCatalog = false; catalogRelease.resolve(); },
            retire: () => connection.dispose(),
            refreshWhilePending: () => { holdCatalog = true; return refreshProfileCatalog(scope); },
            writtenId: () => writtenId,
            acknowledge: () => acknowledgement.resolve(Response.json({ status: 'updated', revision: 1, cursor: 1, referenceGuardRevision: 3 })),
            refuse: () => acknowledgement.resolve(Response.json({ status: 'conflict', revision: 1 })),
        };
}

describe('Profile editor acknowledged save', () => {
    it('awaits the pending catalog through the canonical save owner without refusing the new draft', async () => {
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        await act(async () => { screen.tree.pressByTestId('settings.profiles.detail.save'); });
        expect(save.writtenId()).toBeNull();
        expect(alerts).not.toHaveBeenCalled();
        await act(async () => { save.loadCatalog(); });
        await vi.waitFor(() => expect(save.writtenId()).not.toBeNull());
        await act(async () => { save.acknowledge(); });
        await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(`/settings/profiles/${save.writtenId()}`));
        expect(alerts).not.toHaveBeenCalled();
    });

    it('preserves the draft without writing when pending catalog hydration fails', async () => {
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        await act(async () => { screen.tree.pressByTestId('settings.profiles.detail.save'); });
        await act(async () => { save.failCatalog(); });
        await vi.waitFor(() => expect(alerts).toHaveBeenCalled());
        expect(save.writtenId()).toBeNull();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('Research');
        expect(navigation.dirty).toBe(true);
    });

    it('does not admit a pending save after its Account lifetime retires', async () => {
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        await act(async () => { screen.tree.pressByTestId('settings.profiles.detail.save'); });
        await act(async () => { await save.retire(); save.loadCatalog(); });
        await vi.waitFor(() => expect(alerts).toHaveBeenCalled());
        expect(save.writtenId()).toBeNull();
        expect(navigation.replace).not.toHaveBeenCalled();
    });

    it.each(['detail', 'composer'] as const)('waits for the clone source on first hydration in the %s editor', async editor => {
        const source = createEmptyCustomProfile();
        source.name = 'Research';
        const record: ProfileRecordV1 = { v: 1, id: source.id, definition: { kind: 'inline', profile: source },
            enabled: false, promptStack: [], secretBindings: { API_KEY: null } };
        const save = await setupAcknowledgedSave({ initialRecord: record, holdInitialCatalog: true });
        routeParams.cloneFromProfileId = source.id;
        const screen = await renderScreen(editor === 'detail'
            ? <ProfileDetailScreen target={{ kind: 'draft', cloneFrom: source.id }} />
            : <HeaderHeightContext.Provider value={0}><ProfileEditScreen /></HeaderHeightContext.Provider>);
        expect(screen.tree.findByTestId('profile-slim-name') === null).toBe(true);
        expect(screen.tree.findByTestId('settings.profiles.detail.notFound') === null).toBe(true);
        await act(async () => { save.loadCatalog(); });
        await vi.waitFor(() => expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('Research (Copy)'));
        const form = screen.tree.findByType(LaunchProfileEditForm);
        const copiedId: string = form.props.profile.id;
        expect(copiedId).not.toBe(source.id);
        expect(form.props.profile.enabled).toBe(false);
        expect(form.props.profile.artifactId).toBeUndefined();
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'My research'); });
        let refresh: Promise<void> = Promise.resolve();
        await act(async () => { refresh = save.refreshWhilePending(); });
        expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('My research');
        await act(async () => { save.loadCatalog(); await refresh; });
        expect(screen.tree.findByType(LaunchProfileEditForm).props.profile.id).toBe(copiedId);
        expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('My research');
    });

    it('initializes a clone from the retained source after its pending refresh settles', async () => {
        const source = { ...createEmptyCustomProfile(), name: 'Research' };
        const save = await setupAcknowledgedSave({ initialRecord: { v: 1, id: source.id,
            definition: { kind: 'inline', profile: source }, enabled: true, promptStack: [], secretBindings: {} } });
        const refresh = save.refreshWhilePending();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: source.id }} />);
        expect(screen.tree.findByTestId('settings.profiles.detail.notFound') === null).toBe(true);
        await act(async () => { save.loadCatalog(); await refresh; });
        await vi.waitFor(() => expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('Research (Copy)'));
    });

    it('reports a genuinely missing clone after hydration and never offers an empty copy', async () => {
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: 'missing-profile' }} />);
        expect(screen.tree.findByTestId('profile-slim-name')).toBeNull();
        expect(screen.tree.findByTestId('settings.profiles.detail.notFound')).toBeNull();
        await act(async () => { save.loadCatalog(); });
        await vi.waitFor(() => expect(screen.tree.findByTestId('settings.profiles.detail.notFound')).not.toBeNull());
        expect(screen.tree.findByTestId('profile-slim-name')).toBeNull();
    });

    it('keeps a saved-profile lookup loading until hydration can prove whether it exists', async () => {
        const source = { ...createEmptyCustomProfile(), name: 'Research' };
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true, initialRecord: { v: 1, id: source.id,
            definition: { kind: 'inline', profile: source }, enabled: true, promptStack: [], secretBindings: {} } });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'profile', profileId: source.id }} />);
        expect(screen.tree.findByTestId('settings.profiles.detail.loading')).not.toBeNull();
        expect(screen.tree.findByTestId('settings.profiles.detail.notFound') === null).toBe(true);
        await act(async () => { save.loadCatalog(); });
        await vi.waitFor(() => expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('Research'));
    });

    it('does not recreate an intentionally discarded draft on a later catalog publication', async () => {
        const save = await setupAcknowledgedSave();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        // Menu presentation is native; its real domain action remains the rendered header's action.
        const menu = screen.tree.findAll(node => Array.isArray(node.props.actions))
            .find(node => node.props.actions.some((action: { id: string }) => action.id === 'discard'));
        await act(async () => { menu?.props.actions.find((action: { id: string }) => action.id === 'discard').onSelect(); });
        expect(navigation.replace).toHaveBeenCalledWith('/settings/profiles');
        let refresh: Promise<void> = Promise.resolve();
        await act(async () => { refresh = save.refreshWhilePending(); });
        await act(async () => { save.loadCatalog(); await refresh; });
        expect(screen.tree.findByTestId('profile-slim-name')).toBeNull();
    });

    it('keeps the real detail draft dirty until its row HTTP acknowledgement, then selects the created profile', async () => {
        const save = await setupAcknowledgedSave();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        await act(async () => { screen.tree.pressByTestId('settings.profiles.detail.save'); });
        await vi.waitFor(() => expect(save.writtenId()).not.toBeNull());
        expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('Research');
        expect(navigation.dirty).toBe(true);
        expect(navigation.replace).not.toHaveBeenCalled();
        await act(async () => { save.acknowledge(); });
        await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(`/settings/profiles/${save.writtenId()}`));
        expect(alerts).not.toHaveBeenCalled();
    });

    it('returns the acknowledged Profile row to the existing New Session composer without replacing its route', async () => {
        const save = await setupAcknowledgedSave();
        const screen = await renderScreen(<HeaderHeightContext.Provider value={0}><ProfileEditScreen /></HeaderHeightContext.Provider>);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        await act(async () => { screen.tree.pressByTestId('profile-edit-save'); });
        await vi.waitFor(() => expect(save.writtenId()).not.toBeNull());
        expect(navigation.dirty).toBe(true);
        expect(navigation.dispatch).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
        await act(async () => { save.acknowledge(); });
        await vi.waitFor(() => expect(navigation.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS', source: 'composer', payload: { params: expect.objectContaining({ profileId: save.writtenId() }) },
        })));
        expect(navigation.back).toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(alerts).not.toHaveBeenCalled();
    });

    it('retains the detail draft and guard when the canonical row owner refuses the save', async () => {
        const save = await setupAcknowledgedSave();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        await act(async () => { screen.tree.pressByTestId('settings.profiles.detail.save'); });
        await vi.waitFor(() => expect(save.writtenId()).not.toBeNull());
        await act(async () => { save.refuse(); });
        await vi.waitFor(() => expect(alerts).toHaveBeenCalled());
        expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('Research');
        expect(navigation.dirty).toBe(true);
        expect(navigation.replace).not.toHaveBeenCalled();
    });

    it('awaits Save on exit and continues the original removal instead of selecting the new profile', async () => {
        const save = await setupAcknowledgedSave();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        const action = { type: 'GO_BACK', source: 'editor' };
        await act(async () => { navigation.beforeRemove?.({ data: { action } }); });
        const saveButton = alerts.mock.calls.at(-1)?.[2]?.find(button => button.style === 'default');
        expect(saveButton).toBeDefined();
        await act(async () => { saveButton?.onPress?.(); });
        await vi.waitFor(() => expect(save.writtenId()).not.toBeNull());
        expect(navigation.dispatch).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        await act(async () => { save.acknowledge(); });
        await vi.waitFor(() => expect(navigation.dispatch).toHaveBeenCalledWith(action));
        expect(navigation.replace).not.toHaveBeenCalled();
    });

    it('does not navigate an editor that unmounted before the HTTP acknowledgement', async () => {
        const save = await setupAcknowledgedSave();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        let completion: Promise<unknown> = Promise.resolve();
        await act(async () => {
            const saveRef: React.MutableRefObject<(() => boolean | Promise<boolean>) | null> = screen.tree.findByType(LaunchProfileEditForm).props.saveRef;
            completion = Promise.resolve(saveRef.current?.());
        });
        await vi.waitFor(() => expect(save.writtenId()).not.toBeNull());
        await act(async () => { screen.tree.unmount(); });
        await act(async () => { save.acknowledge(); expect(await completion).toBe(false); });
        expect(navigation.replace).not.toHaveBeenCalled();
    });
});
