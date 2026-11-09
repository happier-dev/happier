import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ProfileRowMutationV1Schema, PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { AlertButton } from '@/modal/types';
import { HeaderHeightContext } from '@react-navigation/elements';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), dispatch: vi.fn(), dirty: false,
    beforeRemove: null as ((event: { data: { action: unknown } }) => void) | null,
}));
const alerts = vi.hoisted(() => vi.fn<(title: string, message?: string, buttons?: AlertButton[]) => void>());
const routeParams = vi.hoisted(() => ({ agentType: 'claude', cloneFromProfileId: undefined as string | undefined }));
// Platform navigation, native styling and modal presentation are external boundaries.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
}));
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

installDisconnectedServerSocketBoundary();

const { storage } = await import('@/sync/domains/state/storageStore');
const { refreshProfileCatalog, resetProfileCatalogEngineForTests } = await import('@/sync/engine/settings/profileCatalogEngine');
const { getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { ProfileDetailScreen } = await import('./ProfileDetailScreen');
const { ProfileCollectionRail } = await import('./ProfileCollectionList');
const { ProfileSettingsIndex } = await import('./ProfileSettingsIndex');
const { CollectionList } = await import('@/components/ui/lists/collection/CollectionList');
const { default: ProfileEditScreen } = await import('@/app/(app)/new/pick/profile-edit');
const { LaunchProfileEditForm } = await import('@/components/profiles/edit');
const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');

async function setupAcknowledgedSave(options: Readonly<{ initialRecord?: ProfileRecordV1; holdInitialCatalog?: boolean; useProfiles?: boolean }> = {}) {
        await loadSyncSingletonForTests();
        const initial = storage.getState();
        navigation.replace.mockClear();
        navigation.back.mockClear();
        navigation.dispatch.mockClear();
        alerts.mockClear();
        routeParams.cloneFromProfileId = undefined;
        const acknowledgement = createDeferred<Response>();
        const catalogRelease = createDeferred<void>();
        const displayRefreshStarted = createDeferred<void>();
        const displayRefreshRelease = createDeferred<void>();
        let holdNextCatalogRead = false;
        let holdCatalog = options.holdInitialCatalog ?? false;
        let catalogFailed = false;
        const rows: Array<{ id: string; revision: number; content: unknown }> = options.initialRecord
            ? [{ id: options.initialRecord.id, revision: 1, content: { t: 'plain', v: options.initialRecord } }] : [];
        let writtenId: string | null = null;
        let writtenRecord: ProfileRecordV1 | null = null;
        let writtenRevision = 1;
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://profile-save.example.test', accountId: 'alice', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain',
                v: options.useProfiles === undefined ? {} : { useProfiles: options.useProfiles } } });
            // An exact-kind read (shared launch Profiles) answers the filtered envelope.
            if (path === '/v1/artifacts') return createArtifactListHttpResponse(new URL(String(url)), []);
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_ROWS_ROUTE_V1) {
                if (holdNextCatalogRead) {
                    holdNextCatalogRead = false;
                    displayRefreshStarted.resolve();
                    await displayRefreshRelease.promise;
                }
                if (holdCatalog) await catalogRelease.promise;
                if (catalogFailed) return new Response(null, { status: 503 });
                return Response.json({ status: 'listed', rows, nextCursor: null, complete: true,
                    diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } });
            }
            if (path === PROFILE_RECORDS_ROUTE_V1) {
                const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
                writtenId = mutation.id;
                writtenRecord = mutation.content?.t === 'plain' ? mutation.content.v : null;
                writtenRevision = (rows.find(row => row.id === mutation.id)?.revision ?? 0) + 1;
                const response = await acknowledgement.promise;
                const outcome: unknown = await response.clone().json();
                if (typeof outcome === 'object' && outcome !== null && 'status' in outcome && outcome.status === 'updated') {
                    const index = rows.findIndex(row => row.id === mutation.id);
                    const row = { id: mutation.id, revision: writtenRevision, content: mutation.content };
                    if (index === -1) rows.push(row);
                    else rows[index] = row;
                }
                return response;
            }
            return new Response(null, { status: 404 });
        } });
        onTestFinished(async () => {
            catalogRelease.resolve();
            displayRefreshRelease.resolve();
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
            recoverCatalog: () => { catalogFailed = false; },
            retire: () => connection.dispose(),
            refreshWhilePending: () => { holdCatalog = true; return refreshProfileCatalog(scope); },
            holdDisplayRefresh: () => {
                holdNextCatalogRead = true;
                return { started: displayRefreshStarted.promise, completed: refreshProfileCatalog(scope),
                    release: () => displayRefreshRelease.resolve() };
            },
            catalog: () => getProfileCatalogSnapshot(scope),
            writtenId: () => writtenId,
            writtenRecord: () => writtenRecord,
            acknowledge: () => acknowledgement.resolve(Response.json({ status: 'updated', revision: writtenRevision, cursor: 1, referenceGuardRevision: 3 })),
            refuse: () => acknowledgement.resolve(Response.json({ status: 'conflict', revision: 1 })),
        };
}

describe('Profile editor acknowledged save', () => {
    it('isolates draft title publication and retirement between profile destinations', async () => {
        await setupAcknowledgedSave({ useProfiles: true });
        const { ProfileSettingsLayout } = await import('./ProfileSettingsLayout');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { WorkspaceRouteOutlet } = await import('@/components/appShell/workspace/WorkspaceRouteOutlet');
        const { router } = await import('expo-router');
        storage.setState(state => ({ settings: { ...state.settings, useProfiles: true } }));
        const renderDestination = async (id: string) => {
            const screen = await renderScreen(<DestinationInstanceHost tabId={id} ref={{ kind: 'settings', params: {} }}
                pathname="/settings/profiles/new" navigation={router} focused visible>
                <WorkspaceRouteOutlet.Provider value={<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />}>
                    <ProfileSettingsLayout />
                </WorkspaceRouteOutlet.Provider>
            </DestinationInstanceHost>);
            await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('settings-profiles-layout'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 1000 } },
            }); });
            return screen;
        };
        const first = await renderDestination('first-profile');
        await act(async () => { first.changeTextByTestId('profile-slim-name', 'First profile'); });
        const second = await renderDestination('second-profile');
        await act(async () => { second.changeTextByTestId('profile-slim-name', 'Second profile'); });
        const titles = (screen: typeof first) => screen.findAll(node => node.props.testID === 'settings.profiles.rail.draft'
            && typeof node.props.title === 'string').map(node => node.props.title);
        expect(titles(first)).toContain('First profile');
        expect(titles(first)).not.toContain('Second profile');
        expect(titles(second)).toContain('Second profile');
        await act(async () => { second.unmount(); });
        expect(titles(first)).toContain('First profile');
    });

    it('keeps the collection rail loading before inventory arrives and retains it during refresh', async () => {
        const source = { ...createEmptyCustomProfile(), name: 'Research' };
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true, initialRecord: { v: 1, id: source.id,
            definition: { kind: 'inline', profile: source }, enabled: true, promptStack: [], skillSeeds: [], secretBindings: {} } });
        const screen = await renderScreen(<ProfileCollectionRail />);
        expect(screen.tree.findByTestId('settings.profiles.rail.loading')).not.toBeNull();
        expect(screen.tree.findByType(CollectionList).props.count).toBeUndefined();
        expect(screen.tree.findByTestId(`settings.profiles.row.${source.id}`)).toBeNull();
        await act(async () => { save.loadCatalog(); });
        await vi.waitFor(() => expect(screen.tree.findByTestId(`settings.profiles.row.${source.id}`)).not.toBeNull());
        expect(screen.tree.findByTestId('settings.profiles.rail.loading')).toBeNull();
        const count = screen.tree.findByType(CollectionList).props.count;
        let refresh: Promise<void> = Promise.resolve();
        await act(async () => { refresh = save.refreshWhilePending(); });
        expect(screen.tree.findByTestId(`settings.profiles.row.${source.id}`)).not.toBeNull();
        expect(screen.tree.findByType(CollectionList).props.count).toBe(count);
        await act(async () => { save.loadCatalog(); await refresh; });
    });

    it('renders the standalone collection loading, then its genuinely empty default environment', async () => {
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true, useProfiles: true });
        storage.setState(state => ({ settings: { ...state.settings, useProfiles: true } }));
        const page = await renderScreen(<ProfileSettingsIndex />);
        const rail = await renderScreen(<ProfileCollectionRail />);
        expect(page.tree.findHostByTestId('settings.profiles.collection.loading'), page.getTextContent()).not.toBeNull();
        expect(rail.tree.findHostByTestId('settings.profiles.row.defaultEnvironment')).toBeNull();
        await act(async () => { save.loadCatalog(); });
        await vi.waitFor(() => expect(rail.tree.findHostByTestId('settings.profiles.row.defaultEnvironment')).not.toBeNull());
        expect(page.tree.findHostByTestId('settings.profiles.collection.loading')).toBeNull();
        expect(rail.tree.findByType(CollectionList).props.count).toBe(1);
    });

    it('keeps the header to Save and the menu: whether pickers offer the profile is a menu action', async () => {
        const source = { ...createEmptyCustomProfile(), name: 'Research' };
        const record: ProfileRecordV1 = { v: 1, id: source.id, definition: { kind: 'inline', profile: source },
            enabled: true, promptStack: [], skillSeeds: [], secretBindings: {} };
        await setupAcknowledgedSave({ initialRecord: record });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'profile', profileId: source.id }} />);
        await vi.waitFor(() => expect(screen.findAll((node) => node.props.testID === 'settings.profiles.detail.menu').length).toBeGreaterThan(0));
        expect(screen.findAll((node) => node.props.testID === 'settings.profiles.detail.enabled' && 'onValueChange' in node.props)).toHaveLength(0);
        const menu = screen.findAll((node) => node.props.testID === 'settings.profiles.detail.menu' && Array.isArray(node.props.actions)).at(0);
        expect(menu?.props.actions.map((action: { id: string }) => action.id)).toContain('enabled');
    });

    it('keeps Save disabled on a new draft until it has a name, instead of refusing the press with an alert', async () => {
        await setupAcknowledgedSave();
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />);
        const saveDisabled = () => screen.findAll((node) => node.props.testID === 'settings.profiles.detail.save'
            && typeof node.props.disabled === 'boolean').at(0)?.props.disabled;
        expect(saveDisabled()).toBe(true);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', '   '); });
        expect(saveDisabled()).toBe(true);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research'); });
        expect(saveDisabled()).toBe(false);
        expect(alerts).not.toHaveBeenCalled();
    });

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

    it('acknowledges the edited Profile while its display catalog HTTP refresh remains held', async () => {
        const source = { ...createEmptyCustomProfile(), name: 'Research' };
        const record: ProfileRecordV1 = { v: 1, id: source.id, definition: { kind: 'inline', profile: source },
            enabled: true, promptStack: [], skillSeeds: [], secretBindings: { MASKED: null } };
        const save = await setupAcknowledgedSave({ initialRecord: record });
        const screen = await renderScreen(<ProfileDetailScreen target={{ kind: 'profile', profileId: source.id }} />);
        await act(async () => { screen.tree.changeTextByTestId('profile-slim-name', 'Research updated'); });
        const refresh = save.holdDisplayRefresh();
        let refreshSettled = false;
        void refresh.completed.then(() => { refreshSettled = true; });
        try {
            await act(async () => { await refresh.started; });
            expect(save.catalog()).toMatchObject({ catalog: { status: 'loading' }, stale: true, dataComplete: true });
            await act(async () => { screen.tree.pressByTestId('settings.profiles.detail.save'); });
            await vi.waitFor(() => expect(save.writtenId()).toBe(source.id));
            expect(save.writtenRecord()).toMatchObject({ secretBindings: { MASKED: null },
                definition: { profile: { name: 'Research updated' } } });
            expect(refreshSettled).toBe(false);
            await act(async () => { save.acknowledge(); });
            await vi.waitFor(() => expect(screen.tree.findByTestId('profile-slim-name')?.props.value).toBe('Research updated'));
            await vi.waitFor(() => expect(navigation.dirty).toBe(false));
            expect(save.catalog()?.data?.find(row => row.record.id === source.id)).toMatchObject({ revision: 2,
                record: { secretBindings: { MASKED: null }, definition: { profile: { name: 'Research updated' } } } });
            expect(refreshSettled).toBe(false);
            expect(alerts).not.toHaveBeenCalled();
        } finally {
            await act(async () => { refresh.release(); await refresh.completed; });
        }
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
            enabled: false, promptStack: [], skillSeeds: [], secretBindings: { API_KEY: null } };
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
            definition: { kind: 'inline', profile: source }, enabled: true, promptStack: [], skillSeeds: [], secretBindings: {} } });
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

    it.each(['profile', 'clone'] as const)('keeps a failed %s read distinct from absence and retries the same source', async kind => {
        const source = { ...createEmptyCustomProfile(), name: 'Research' };
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true, initialRecord: { v: 1, id: source.id,
            definition: { kind: 'inline', profile: source }, enabled: true, promptStack: [], skillSeeds: [], secretBindings: {} } });
        const screen = await renderScreen(<ProfileDetailScreen target={kind === 'profile'
            ? { kind: 'profile', profileId: source.id } : { kind: 'draft', cloneFrom: source.id }} />);
        expect(screen.tree.findByTestId('settings.profiles.detail.loading')).not.toBeNull();
        await act(async () => { save.failCatalog(); });
        await vi.waitFor(() => expect(screen.tree.findByTestId('settings.profiles.detail.unavailable')).not.toBeNull());
        expect(screen.tree.findByTestId('settings.profiles.detail.notFound')).toBeNull();
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const failure = screen.tree.findByType(SurfaceStateCard);
        // Keep the reader's typed HTTP503 reason intact through the refusal presenter.
        expect(failure.props.diagnosticCode).toBe('unreachable');
        expect(failure.props.action).toMatchObject({ label: expect.any(String), onPress: expect.any(Function) });
        save.recoverCatalog();
        await act(async () => { await failure.props.action.onPress(); });
        await vi.waitFor(() => expect(screen.tree.findByTestId('profile-slim-name')?.props.value)
            .toBe(kind === 'profile' ? 'Research' : 'Research (Copy)'));
        expect(screen.tree.findByTestId('settings.profiles.detail.unavailable')).toBeNull();
    });

    it('keeps a saved-profile lookup loading until hydration can prove whether it exists', async () => {
        const source = { ...createEmptyCustomProfile(), name: 'Research' };
        const save = await setupAcknowledgedSave({ holdInitialCatalog: true, initialRecord: { v: 1, id: source.id,
            definition: { kind: 'inline', profile: source }, enabled: true, promptStack: [], skillSeeds: [], secretBindings: {} } });
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
        expect(save.writtenRecord()).toMatchObject({ id: save.writtenId(), definition: { kind: 'inline', profile: { name: 'Research' } } });
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
        expect(save.writtenRecord()).toMatchObject({ id: save.writtenId(), definition: { kind: 'inline', profile: { name: 'Research' } } });
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
