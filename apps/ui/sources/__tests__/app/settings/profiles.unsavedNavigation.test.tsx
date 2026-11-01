import * as React from 'react';
import { LaunchProfileArtifactReferenceV1Schema, readLaunchProfileArtifactV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { storage } from '@/sync/domains/state/storageStore';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { refreshProfileCatalog, resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema, ProfileRowsListResponseV1Schema, ProfileRowMutationV1Schema, ProfileRowMutationResponseV1Schema, ProfileRowReadRequestV1Schema, ProfileRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import type { AiLaunchProfile } from '@happier-dev/protocol';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';


import { installProfilesCommonModuleMocks } from '@/components/profiles/profilesTestHelpers';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

type BeforeRemoveEvent = {
    data: { action: unknown };
    preventDefault: () => void;
};



type CapturedEditFormProps = {
    profile: AiLaunchProfile;
    machineId: string | null;
    serverId?: string | null;
    onSave: (profile: AiLaunchProfile) => Promise<boolean>;
    onCancel: () => void;
    onDirtyChange: (isDirty: boolean) => void;
    saveRef: React.MutableRefObject<(() => boolean | Promise<boolean>) | null>;
    header?: React.ReactNode;
};

const promptUnsavedChangesAlertModule = await import('@/utils/ui/promptUnsavedChangesAlert');
const promptUnsavedChangesAlertSpy = vi.spyOn(promptUnsavedChangesAlertModule, 'promptUnsavedChangesAlert');
const modalDecisions: Array<UnsavedChangesDecision | Promise<UnsavedChangesDecision>> = [];
let defaultModalDecision: UnsavedChangesDecision = 'keepEditing';
function answerModalAlert(...args: Parameters<typeof import('@/modal')['Modal']['alert']>) {
    shareState.alerts.push(args);
    const buttons = args[2];
    if (!buttons?.some(button => button.style === 'destructive') || !buttons.some(button => button.style === 'cancel')) return;
    void Promise.resolve(modalDecisions.shift() ?? defaultModalDecision).then(decision => {
        const style = decision === 'discard' ? 'destructive' : decision === 'save' ? 'default' : 'cancel';
        buttons.find(button => button.style === style)?.onPress?.();
    });
}
const navigationState = vi.hoisted(() => ({
    legacyBeforeRemove: null as null | ((event: BeforeRemoveEvent) => void),
    preventRemoveEnabled: false,
    preventRemoveCallback: null as null | ((event: { data: { action: unknown } }) => void),
    dispatch: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
    values: {
        useProfiles: true,
        lastUsedProfile: null,
        favoriteProfiles: [],
        profileEnabledById: {},
        providerSettingsV1: null,
        secretBindingsByProfileId: {},
    } as Record<string, unknown>,
}));
const machineFixtureState = { available: true };

const shareState = vi.hoisted(() => ({
    shown: [] as Array<{ chrome?: { testID?: string }; props?: Record<string, unknown> }>,
    alerts: [] as unknown[][],
    calls: [] as Array<{ actionId: string; input: unknown; context: unknown }>,

    savedFiles: [] as Array<{ fileName: string; json: string }>,
}));

installProfilesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
        Platform: { OS: 'web' },
    });
    },
    // The modal host is the presentation boundary: the test reads what the page asked it to show.
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const mock = createModalModuleMock({ confirmResult: true, spies: { alert: answerModalAlert } });
        const present = mock.spies.show.getMockImplementation();
        if (!present) throw new Error('Expected the canonical modal presentation boundary');
        mock.spies.show.mockImplementation(config => {
            if (config.chrome?.testID === 'document-share-modal') shareState.shown.push(config as never);
            return present(config);
        });
        return mock.module;
    },

});
// Keep deterministic internal settings and scoped Profile readers real.
vi.doUnmock('@/sync/domains/state/storage');

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
    usePreventRemove: (enabled, callback) => {
        navigationState.preventRemoveEnabled = enabled;
        navigationState.preventRemoveCallback = callback;
    },
});
});

const routerSpies = vi.hoisted(() => ({
    replace: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({
        navigation: {
            addListener: (event: string, callback: (event: BeforeRemoveEvent) => void) => {
                if (event === 'beforeRemove') {
                    navigationState.legacyBeforeRemove = callback;
                }
                return { remove: vi.fn() };
            },
            dispatch: navigationState.dispatch,
        },
    });
    routerSpies.replace = mock.spies.replace;
    return mock.module;
});

const applyProfileSaveSpy = vi.hoisted(() => vi.fn());




// The document file boundary (web download / native share sheet) is the platform edge of "Send a copy".
vi.mock('@/sync/domains/workflows/workflowDocumentFile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/workflows/workflowDocumentFile')>()),
    saveWorkflowDocument: async (file: { fileName: string; json: string }) => { shareState.savedFiles.push(file); },
}));












let capturedEditFormProps: CapturedEditFormProps | null = null;










function currentBeforeRemoveCallback(): (event: BeforeRemoveEvent) => void {
    if (navigationState.preventRemoveEnabled && navigationState.preventRemoveCallback) {
        return navigationState.preventRemoveCallback;
    }
    if (navigationState.legacyBeforeRemove) {
        return navigationState.legacyBeforeRemove;
    }
    throw new Error('The profile detail did not register an unsaved-navigation guard');
}

const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');
const savedV2Profile = { ...createEmptyCustomProfile(), id: 'profile-v2', name: 'Saved profile', createdAt: 1, updatedAt: 1 };

const profileFixture = { profiles: [] as Array<AiLaunchProfile | ReturnType<typeof LaunchProfileArtifactReferenceV1Schema.parse>> };
const profileRows = new Map<string, Readonly<{ record: ProfileRecordV1; revision: number }>>();
let profileRevision = 1;
let publishedArtifactId: string | null = null;
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/artifacts' || path.startsWith('/v1/artifacts/')) {
        // The Profile catalog filters its Artifact census by kind on the query string.
        const response = await artifactStore.handle(`${path}${new URL(String(url)).search}`, init ?? {});
        if (response?.ok && path === '/v1/artifacts' && init?.method === 'POST') publishedArtifactId = artifactStore.list().at(-1)?.id ?? null;
        if (response) return response;
    }
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
    }));
    if (path === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') {
        const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        applyProfileSaveSpy(mutation);
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
const artifactStore = createArtifactStoreBoundary({ ownerAccountId: () => storage.getState().settingsScope?.accountId ?? null, encryptionMode: 'plain' });
const actionRuntime = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const createFrontDoorActionExecute = actionRuntime.createFrontDoorActionExecute;
vi.spyOn(actionRuntime, 'createFrontDoorActionExecute').mockImplementation((...factoryArgs) => {
    const execute = createFrontDoorActionExecute(...factoryArgs);
    return Object.assign((...args: Parameters<typeof execute>) => {
        const [actionId, input, context] = args;
        shareState.calls.push({ actionId, input, context });
        return execute(...args);
    }, { confirmed: execute.confirmed, prepare: execute.prepare });
});
const profileEditModule = await import('@/components/profiles/edit');
const realLaunchProfileEditForm = profileEditModule.LaunchProfileEditForm;
vi.spyOn(profileEditModule, 'LaunchProfileEditForm').mockImplementation((props) => {
    capturedEditFormProps = props as CapturedEditFormProps;
    return React.createElement(realLaunchProfileEditForm, props);
});
async function editProfileName(screen: RenderScreenResult, name = 'Edited profile') {
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('profile-slim-name') ?? screen.findHostByTestId('profile-legacy-name')).not.toBeNull());
    const field = screen.findHostByTestId('profile-slim-name') ?? screen.findHostByTestId('profile-legacy-name');
    if (!field || typeof field.props.onChangeText !== 'function') throw new Error('Expected actual profile name input');
    await act(async () => field.props.onChangeText(name));

}



type DetailTarget =
    | { kind: 'profile'; profileId: string }
    | { kind: 'draft'; cloneFrom: string | null };

async function renderDetail(target: DetailTarget) {
    await seedFocusedAccount();
    const { ProfileDetailScreen } = await import('@/components/settings/profiles/ProfileDetailScreen');
    return renderScreen(React.createElement(ProfileDetailScreen, { target }), { wrapper: runtime.Wrapper });
}

async function renderDirtyEditor(target: DetailTarget = { kind: 'profile', profileId: savedV2Profile.id }) {
    const screen = await renderDetail(target);
    expect(capturedEditFormProps).not.toBeNull();
    await editProfileName(screen, 'Edited Profile');
    return screen;
}

function hasEditor(screen: RenderScreenResult): boolean {
    return screen.findAllByType(realLaunchProfileEditForm).length > 0;
}

function goBack(key: string) {
    return () => currentBeforeRemoveCallback()({
        data: { action: { type: 'GO_BACK', key } },
        preventDefault: vi.fn(),
    });
}

async function invokeAndFlush(callback: () => void): Promise<void> {
    await act(async () => {
        callback();
    });
    await flushHookEffects({ cycles: 4, turns: 4 });
}

describe('Settings › Profiles detail: machine scope and unsaved navigation', () => {
    beforeEach(async () => {
        // Profile readers resolve Settings rows for the focused Account only (U13 hydration).
        await seedFocusedAccount();

        capturedEditFormProps = null;
        navigationState.legacyBeforeRemove = null;
        navigationState.preventRemoveEnabled = false;
        navigationState.preventRemoveCallback = null;
        navigationState.dispatch.mockReset();
        promptUnsavedChangesAlertSpy.mockClear();
        settingsState.values.useProfiles = true;
        profileFixture.profiles = [savedV2Profile];
    profileRows.clear();
    profileRevision = 1;
        applyProfileSaveSpy.mockReset();
        routerSpies.replace?.mockClear();

        machineFixtureState.available = true;
    });

    afterEach(() => {
        standardCleanup();
        resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
});

    it('uses the exact Administration target for V2 profile reads instead of an active or first machine', async () => {
        const screen = await renderDirtyEditor();
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');
        const selectedHome = getServerProfileById(runtime.serverId);
        if (!selectedHome) throw new Error('Expected the Administration target Home');

        expect(capturedEditFormProps).toMatchObject({
            machineId: 'machine-b',
            serverId: selectedHome.id,
        });
        // The machine chip rides on the header of a machine-scoped (V2) profile.
        const chips = screen.findAllByType(MachineAdministrationTargetSelector);
        expect(chips).toHaveLength(1);
        expect(chips[0]?.props).toMatchObject({ presentation: 'chip', selection: { selectedTarget: {
            machineId: 'machine-b', serverIdentityId: runtime.serverIdentityId,
        } } });
    });

    it('does not substitute another machine when the selected Administration target is no longer executable', async () => {
        machineFixtureState.available = false;

        await renderDirtyEditor();

        expect(capturedEditFormProps).toMatchObject({
            machineId: null,
            serverId: null,
        });
    });

    it('keeps legacy profile preview selection explicit', async () => {
        // A stored pre-V2 custom Profile opens in the legacy editor. Built-in presets no longer do:
        // creating from a legacy API-key preset is refused and routed to Provider migration.
        const { AIBackendProfileSchema } = await import('@happier-dev/protocol');
        const legacy = AIBackendProfileSchema.parse({ id: 'legacy-custom', name: 'Legacy custom', isBuiltIn: false, createdAt: 1, updatedAt: 1 });
        profileFixture.profiles = [legacy as never];
        await seedFocusedAccount();

        const screen = await renderDetail({ kind: 'profile', profileId: legacy.id });
        const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');

        expect(capturedEditFormProps?.profile).toMatchObject({ id: legacy.id });
        expect(capturedEditFormProps).toMatchObject({
            machineId: null,
            serverId: null,
        });
        // Only machine-scoped (V2) profiles carry the machine chip in their header.
        expect(screen.findAllByType(MachineAdministrationTargetSelector)).toHaveLength(0);
    });

    it('serializes repeated navigator exits while the first decision is pending', async () => {
        const decision = createDeferred<UnsavedChangesDecision>();
        modalDecisions.push(decision.promise);
        await renderDirtyEditor();
        const beforeRemove = currentBeforeRemoveCallback();

        await act(async () => {
            beforeRemove({
                data: { action: { type: 'GO_BACK', key: 'first' } },
                preventDefault: vi.fn(),
            });
            beforeRemove({
                data: { action: { type: 'GO_BACK', key: 'second' } },
                preventDefault: vi.fn(),
            });
            await Promise.resolve();
        });

        await act(async () => {
            decision.resolve('keepEditing');
            await decision.promise;
            await Promise.resolve();
        });

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).not.toHaveBeenCalled();
        expect(capturedEditFormProps).not.toBeNull();
    });

    it('keeps the dirty editor on Keep editing and continues the exit on Discard', async () => {
        promptUnsavedChangesAlertSpy
            .mockResolvedValueOnce('keepEditing')
            .mockResolvedValueOnce('discard');
        const screen = await renderDirtyEditor();

        await invokeAndFlush(goBack('keep'));

        expect(hasEditor(screen)).toBe(true);
        expect(navigationState.dispatch).not.toHaveBeenCalled();

        await invokeAndFlush(goBack('discard'));

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledTimes(2);
        expect(navigationState.dispatch).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK', key: 'discard' });
    });

    it('keeps the dirty editor and navigation blocked on save failure, then continues after save succeeds', async () => {
        defaultModalDecision = 'save';
        const screen = await renderDirtyEditor();
        const firstEditForm = capturedEditFormProps;
        if (!firstEditForm) throw new Error('Expected the profile editor');
        await editProfileName(screen, '');

        await invokeAndFlush(goBack('save-fails'));

        expect(hasEditor(screen)).toBe(true);
        expect(navigationState.dispatch).not.toHaveBeenCalled();

        const currentEditForm = capturedEditFormProps;
        if (!currentEditForm) throw new Error('Expected the profile editor after save failure');
        await editProfileName(screen, 'Renamed profile');

        await invokeAndFlush(goBack('save-succeeds'));

        await waitForHomeGovernance(() => {
            expect(applyProfileSaveSpy).toHaveBeenCalledWith(expect.objectContaining({ id: savedV2Profile.id }));
        expect(navigationState.dispatch).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).toHaveBeenCalledWith({
            type: 'GO_BACK',
            key: 'save-succeeds',
        });
        });
    });

    it('selects a saved draft in the collection, but lets a save on the way out keep the exit', async () => {
        await renderDetail({ kind: 'draft', cloneFrom: null });
        const draftForm = capturedEditFormProps;
        if (!draftForm) throw new Error('Expected the draft editor');

        let saved = false;
        await act(async () => {
            saved = await draftForm.onSave({ ...draftForm.profile, name: 'Fresh profile' });
        });

        expect(saved).toBe(true);
        expect(applyProfileSaveSpy).toHaveBeenCalledWith(expect.objectContaining({ id: draftForm.profile.id }));
        expect(routerSpies.replace).toHaveBeenCalledWith(`/settings/profiles/${encodeURIComponent(draftForm.profile.id)}`);

        routerSpies.replace.mockClear();
        defaultModalDecision = 'save';
        const exitingScreen = await renderDirtyEditor({ kind: 'draft', cloneFrom: null });
        const exitingForm = capturedEditFormProps;
        if (!exitingForm) throw new Error('Expected the second draft editor');
        await editProfileName(exitingScreen, 'Saved on exit');

        await invokeAndFlush(goBack('save-on-exit'));

        expect(routerSpies.replace).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => {
            expect(navigationState.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK', key: 'save-on-exit' });
        });
    });

    it('keeps built-in Save As prompt semantics', async () => {
        const { DEFAULT_PROFILES } = await import('@/sync/domains/profiles/profileUtils');
        const builtInDefinition = DEFAULT_PROFILES[0];
        if (!builtInDefinition) throw new Error('Expected at least one built-in Profile fixture');
        defaultModalDecision = 'keepEditing';

        await renderDirtyEditor({ kind: 'profile', profileId: builtInDefinition.id });
        await invokeAndFlush(goBack('built-in'));

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                saveText: 'common.saveAs',
                message: expect.stringContaining('profiles.builtInSaveAsHint'),
            }),
        );
    });

    it('uses the shared browser-unload guard only while the editor is dirty', async () => {
        const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        type BeforeUnloadHandler = (event: {
            preventDefault: () => void;
            returnValue?: string;
        }) => void;
        const beforeUnloadHandlerRef: { current: BeforeUnloadHandler | null } = { current: null };
        const addEventListener = vi.fn((type: string, handler: BeforeUnloadHandler) => {
            if (type === 'beforeunload') beforeUnloadHandlerRef.current = handler;
        });
        const removeEventListener = vi.fn((type: string, handler: BeforeUnloadHandler) => {
            if (type === 'beforeunload' && beforeUnloadHandlerRef.current === handler) {
                beforeUnloadHandlerRef.current = null;
            }
        });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { addEventListener, removeEventListener },
        });

        try {
            const screen = await renderDirtyEditor();

            expect(addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            const preventDefault = vi.fn();
            const event = { preventDefault, returnValue: undefined as string | undefined };
            beforeUnloadHandlerRef.current?.(event);
            expect(preventDefault).toHaveBeenCalledOnce();
            expect(event.returnValue).toBe('');

            await editProfileName(screen, savedV2Profile.name);

            expect(removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            expect(beforeUnloadHandlerRef.current).toBeNull();
        } finally {
            if (originalWindowDescriptor) {
                Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'window');
            }
        }
    });
});

const publishedProfileContent = {
    kind: 'launch-profile.v1' as const,
    profile: { ...savedV2Profile, ...savedV2Profile, id: 'team-v2', name: 'Team profile' },
    secretBindings: {},
};

async function seedFocusedAccount(artifacts: Record<string, DecryptedArtifact> = storage.getState().artifacts) {
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected the real fixture Home Account scope');
    storage.setState({ settings: settingsParse({ ...storage.getState().settings, ...settingsState.values }), artifacts });
    const previewTarget = { serverIdentityId: runtime.serverIdentityId, machineId: 'machine-b' };
    storage.setState(state => ({ settings: { ...state.settings, machineAdministrationTargetsLocalV1: {
        ...state.settings.machineAdministrationTargetsLocalV1, [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents]: previewTarget,
    } } }));
    const machines = [createMachineFixture({ id: 'machine-first', active: true, activeAt: Date.now() })];
    if (machineFixtureState.available) machines.push(createMachineFixture({ id: previewTarget.machineId, active: true, activeAt: Date.now() }));
    storage.getState().applyMachines(machines, true, { sourceServerId: runtime.serverId, sourceAccountId: scope.accountId });
    artifactStore.clear();
    for (const artifact of Object.values(artifacts)) {
        if (!artifact.isDecrypted || !artifact.header) throw new Error('Expected readable plain fixture Artifact');
        artifactStore.replaceStoredRow({
            id: artifact.id, ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent(artifact.rawHeader ?? artifact.header),
            body: encodePlainArtifactStoredContent({ body: artifact.body ?? null }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion,
            seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
        });
    }
    profileRows.clear();
    for (const source of profileFixture.profiles) {
        const artifactId = source.artifactId;
        let profileId: string;
        if (artifactId) {
            const artifact = artifacts[artifactId];
            const content = artifact?.isDecrypted && artifact.header && typeof artifact.body === 'string'
                ? readLaunchProfileArtifactV1({ artifactId, header: artifact.header, body: artifact.body }) : null;
            if (!content) throw new Error('Expected readable canonical Profile Artifact content');
            profileId = content.profile.id;
            if ('id' in source && source.id !== profileId) throw new Error('Profile row identity must match its Artifact');
        } else {
            if (!('id' in source)) throw new Error('Expected an inline Profile definition');
            profileId = source.id;
        }
        const record = ProfileRecordV1Schema.parse({ v: 1, id: profileId,
            // A pre-V2 definition is stored as a legacy row; only V2 bodies are inline definitions.
            definition: artifactId ? { kind: 'artifact', artifactId }
                : 'v' in source && source.v === 2 ? { kind: 'inline', profile: source } : { kind: 'legacy', profile: source },
            enabled: true, secretBindings: {}, promptStack: [], skillSeeds: [] });
        profileRows.set(record.id, { record, revision: profileRevision });
    }
    await refreshProfileCatalog(scope);
}

function headerMenuActions(screen: RenderScreenResult): ReadonlyArray<{ id: string; onSelect: () => unknown }> {
    const menu = screen.findAllByTestId("settings.profiles.detail.menu").find(node => Array.isArray(node.props.actions));
    if (!menu) throw new Error('Expected the rendered Profile action menu');
    return menu.props.actions;
}

describe('Settings › Profiles detail: Share…', () => {
    beforeEach(async () => {
    modalDecisions.length = 0;
    defaultModalDecision = 'keepEditing';
    publishedArtifactId = null;
    artifactStore.clear();
    storage.setState({ artifacts: {} });
        capturedEditFormProps = null;
        shareState.shown = [];
        shareState.alerts = [];
        shareState.calls = [];
        shareState.savedFiles = [];
        promptUnsavedChangesAlertSpy.mockReset();
        profileFixture.profiles = [savedV2Profile];

    });

    afterEach(() => {
        standardCleanup();
    });

    it('opens the one document share sheet on a published profile without publishing it again', async () => {
        profileFixture.profiles = [{ artifactId: 'artifact-team' }];
        await seedFocusedAccount({
            'artifact-team': {
                id: 'artifact-team', isDecrypted: true, title: 'Team profile',
                header: { kind: 'launch-profile.v1', profileId: 'team-v2', name: 'Team profile', title: 'Team profile' },
                body: JSON.stringify(publishedProfileContent),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            },
        });
        const screen = await renderDetail({ kind: 'profile', profileId: 'team-v2' });
        const share = headerMenuActions(screen).find((action) => action.id === 'share');
        expect(share).toBeDefined();
        await act(async () => { await share!.onSelect(); });

        expect(shareState.calls).toEqual([]);
        expect(shareState.shown).toHaveLength(1);
        expect(shareState.shown[0]).toMatchObject({
            chrome: { testID: 'document-share-modal' },
            props: { kind: 'launch-profile.v1', artifactId: 'artifact-team', linkPath: '/settings/profiles/team-v2' },
        });

        // "Send a copy instead" hands over the value-free document itself, never Settings values.
        await act(async () => { await (shareState.shown[0]!.props!.onSendCopy as () => unknown)(); });
        await vi.waitFor(() => expect(shareState.savedFiles).toHaveLength(1));
        const { LaunchProfileArtifactV1Schema } = await import('@happier-dev/protocol');
        expect(LaunchProfileArtifactV1Schema.parse(JSON.parse(shareState.savedFiles[0]!.json)))
            .toEqual(LaunchProfileArtifactV1Schema.parse(publishedProfileContent));
    });

    it('publishes a saved inline profile once, as the person on this Home, then shares the new Artifact', async () => {
        const screen = await renderDetail({ kind: 'profile', profileId: savedV2Profile.id });
        await act(async () => { await headerMenuActions(screen).find((action) => action.id === 'share')!.onSelect(); });

        await waitForHomeGovernance(() => {
            expect(shareState.calls).toEqual([{
            actionId: 'launch_profiles.publish',
            input: { profileId: savedV2Profile.id },
            context: expect.objectContaining({ surface: 'ui', authority: 'present_user', serverId: runtime.serverId }),
        }]);
        expect(shareState.shown[0]).toMatchObject({
            chrome: { testID: 'document-share-modal' },
            props: { kind: 'launch-profile.v1', artifactId: publishedArtifactId },
        });
        });
    });

    it('explains a secret-value refusal and opens no sheet', async () => {
        profileFixture.profiles = [{ ...savedV2Profile,
            extraEnvironmentVariables: [{ name: 'PROJECT_REGION', value: 'example-region' }] }];
        const screen = await renderDetail({ kind: 'profile', profileId: savedV2Profile.id });
        await act(async () => { await headerMenuActions(screen).find((action) => action.id === 'share')!.onSelect(); });

        await waitForHomeGovernance(() => {
            expect(shareState.shown).toEqual([]);
        expect(shareState.alerts).toEqual([[
            'roles.profiles.shareFailedTitle',
            'roles.profiles.shareNeedsSavedSecrets',
        ]]);
        });
    });

    it('does not publish over unsaved edits the person chose to keep editing', async () => {
        defaultModalDecision = 'keepEditing';
        const screen = await renderDirtyEditor();
        await act(async () => { await headerMenuActions(screen).find((action) => action.id === 'share')!.onSelect(); });

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(shareState.calls).toEqual([]);
        expect(shareState.shown).toEqual([]);
    });

    it('offers no Share on a built-in profile or a draft', async () => {
        const { DEFAULT_PROFILES } = await import('@/sync/domains/profiles/profileUtils');
        // A legacy built-in preset opens Provider migration, which has no Profile action menu at all.
        let screen = await renderDetail({ kind: 'profile', profileId: DEFAULT_PROFILES[0]!.id });
        expect(screen.findAllByTestId('settings.profiles.detail.menu')).toHaveLength(0);
        expect(hasEditor(screen)).toBe(false);
        screen = await renderDetail({ kind: 'draft', cloneFrom: null });
        expect(headerMenuActions(screen).map((action) => action.id)).not.toContain('share');
    });
});
