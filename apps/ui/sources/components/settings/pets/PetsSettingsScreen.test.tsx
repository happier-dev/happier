import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import {
    PET_DAEMON_RPC_METHODS,
    PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    type AccountPetLibraryEntryV1,
    type DiscoveredPetPackageV1,
    type ImportedLocalPetPackageV1,
    type PetPackageManifestV1,
} from '@happier-dev/protocol';
import type { StoreApi, UseBoundStore } from 'zustand';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { LocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceMetadata';
import type { StorageState } from '@/sync/store/types';
import {
    flushHookEffects,
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
    type RenderScreenResult,
} from '@/dev/testkit';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const featureState = vi.hoisted(() => ({
    companionEnabled: true,
    companionBlockedBy: 'server' as 'server' | 'local_policy' | 'build_policy',
    syncEnabled: false,
}));
const tauriDesktopState = vi.hoisted(() => ({
    current: true,
}));
type TestPetsSelectedPetOverride =
    | { kind: 'inherit' }
    | { kind: 'detectedCodexHome'; sourceKey: string }
    | { kind: 'happierManagedLocal'; sourceKey: string };
const localSettingsState = vi.hoisted(() => ({
    petsDetectCodexPets: true,
    petsSelectedPetOverride: { kind: 'inherit' } as TestPetsSelectedPetOverride,
    petsCompanionSizeScale: 1,
}));
const accountSettingsState = vi.hoisted(() => ({
    petsEnabled: false,
}));

const applySettingsSpy = vi.hoisted(() => vi.fn());
const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resetDesktopPetOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
const accountPetsState = vi.hoisted(() => ({
    current: {} as Record<string, AccountPetLibraryEntryV1>,
}));
const localPetSourcesState = vi.hoisted(() => ({
    current: {} as Record<string, LocalPetSourceMetadata>,
}));
const upsertAccountPetSpy = vi.hoisted(() => vi.fn((pet: AccountPetLibraryEntryV1) => {
    accountPetsState.current = {
        ...accountPetsState.current,
        [pet.accountPetId]: pet,
    };
}));
const upsertLocalPetSourceSpy = vi.hoisted(() => vi.fn((source: LocalPetSourceMetadata) => {
    localPetSourcesState.current = {
        ...localPetSourcesState.current,
        [source.sourceKey]: source,
    };
}));
const removeLocalPetSourceSpy = vi.hoisted(() => vi.fn((sourceKey: string) => {
    const next = { ...localPetSourcesState.current };
    delete next[sourceKey];
    localPetSourcesState.current = next;
}));
const machinesState = vi.hoisted((): { current: Machine[] } => ({
    current: [
        {
            id: 'machine-pets',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: {
                host: 'pets.local',
                platform: 'darwin',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: '/Users/tester/.happy-dev',
                homeDir: '/Users/tester',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        },
    ],
}));
const activeServerSnapshotState = vi.hoisted(() => ({
    current: {
        serverId: 'server-pets',
        serverUrl: 'https://pets.example.test',
        generation: 1,
    },
}));
const serverFetchMock = vi.hoisted(() => vi.fn(async () => ({
    ok: false,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
})));

const petManifest = {
    id: 'blink-e2e-fixture',
    displayName: 'Blink fixture',
    description: 'Test pet fixture',
    spritesheetPath: 'spritesheet.webp',
} satisfies PetPackageManifestV1;

const detectedPet = {
    sourceKey: 'detected:blink-e2e-fixture',
    kind: 'detectedCodexHome',
    petId: petManifest.id,
    displayName: petManifest.displayName,
    description: petManifest.description,
    originLabel: 'Codex pets',
    packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: petManifest,
    previewHandle: {
        kind: 'daemonSourceKey',
        sourceKey: 'detected:blink-e2e-fixture',
    },
    mediaType: 'image/webp',
    digest: 'sha256:detected',
    sizeBytes: 128,
} satisfies DiscoveredPetPackageV1;

const importedLocalPet = {
    sourceKey: 'managed:blink-e2e-fixture',
    kind: 'happierManagedLocal',
    petId: petManifest.id,
    displayName: petManifest.displayName,
    description: petManifest.description,
    originLabel: 'This device',
    digest: 'sha256:managed',
    sizeBytes: 128,
    mediaType: 'image/webp',
    previewHandle: {
        kind: 'daemonSourceKey',
        sourceKey: 'managed:blink-e2e-fixture',
    },
    manifest: petManifest,
} satisfies ImportedLocalPetPackageV1;

const detectedPetTestIds = {
    tile: 'settings-pets-detected-tile-detected-blink-e2e-fixture',
    source: 'settings-pets-detected-source-detected-blink-e2e-fixture',
    preview: 'settings-pets-detected-preview-detected-blink-e2e-fixture',
    importToAccount: 'settings-pets-import-to-account-detected-blink-e2e-fixture',
    useOnThisDevice: 'settings-pets-use-on-this-device-detected-blink-e2e-fixture',
} as const;

const importedLocalPetTestIds = {
    tile: 'settings-pets-local-tile-managed-blink-e2e-fixture',
    source: 'settings-pets-select-source-local-managed-blink-e2e-fixture',
    removeFromDevice: 'settings-pets-remove-from-device-managed-blink-e2e-fixture',
} as const;

const accountPetTestIds = {
    tile: 'settings-pets-account-tile-account-pet-1',
    source: 'settings-pets-select-source-account-account-pet-1',
    preview: 'settings-pets-account-preview-account-pet-1',
} as const;

const importedLocalPetMetadata = {
    kind: 'happierManagedLocal',
    sourceKey: importedLocalPet.sourceKey,
    petId: importedLocalPet.petId,
    displayName: importedLocalPet.displayName,
    mediaType: importedLocalPet.mediaType,
    digest: importedLocalPet.digest,
    sizeBytes: importedLocalPet.sizeBytes,
    daemonTarget: {
        machineId: 'machine-pets',
        serverId: 'server-pets',
    },
} satisfies LocalPetSourceMetadata;

const accountPet = {
    accountPetId: 'account-pet-1',
    packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: petManifest,
    spritesheetAssetRef: {
        assetId: 'asset-pet-1',
        mediaType: 'image/webp',
        digest: 'sha256:asset',
        sizeBytes: 128,
    },
    digest: 'sha256:account',
    sizeBytes: 128,
    createdAt: 1,
    updatedAt: 1,
    origin: { kind: 'detectedCodexHome', homeKind: 'user' },
} satisfies AccountPetLibraryEntryV1;

const expectedBuiltInPetIds = ['blink', 'fury', 'milo', 'oli', 'titi'] as const;

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'pets.companion') return featureState.companionEnabled;
        if (featureId === 'pets.sync') return featureState.syncEnabled;
        return false;
    },
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => {
        const enabled =
            featureId === 'pets.companion'
                ? featureState.companionEnabled
                : featureId === 'pets.sync'
                    ? featureState.syncEnabled
                    : false;
        return enabled
            ? { state: 'enabled' }
            : { state: 'disabled', blockedBy: featureState.companionBlockedBy, blockerCode: 'feature_disabled' };
    },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.current,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.current,
}));

vi.mock('@/components/pets/desktop/bridge/desktopPetOverlayBridge', () => ({
    resetDesktopPetOverlayPosition: resetDesktopPetOverlayPositionMock,
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: openExternalUrlMock,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');

    const createPetsStorageStore = () => {
        const state = {
            accountPetsById: accountPetsState.current,
            upsertAccountPet: upsertAccountPetSpy,
            localPetSourcesBySourceKey: localPetSourcesState.current,
            upsertLocalPetSource: upsertLocalPetSourceSpy,
            removeLocalPetSource: removeLocalPetSourceSpy,
        } satisfies Partial<StorageState> & Pick<
            StorageState,
            | 'accountPetsById'
            | 'upsertAccountPet'
            | 'localPetSourcesBySourceKey'
            | 'upsertLocalPetSource'
            | 'removeLocalPetSource'
        >;
        return createStorageStoreMock(state);
    };
    function storageStub(): StorageState;
    function storageStub<U>(selector: (state: StorageState) => U): U;
    function storageStub<U>(selector?: (state: StorageState) => U): StorageState | U {
        const store = createPetsStorageStore();
        return selector ? store(selector) : store();
    }
    const storage = Object.assign(storageStub, {
        getState: () => createPetsStorageStore().getState(),
        getInitialState: () => createPetsStorageStore().getInitialState(),
        setState: () => undefined,
        subscribe: () => () => undefined,
        destroy: () => undefined,
    }) satisfies UseBoundStore<StoreApi<StorageState>>;

    return createStorageModuleMock({
        importOriginal,
        overrides: {
            ...actual,
            useSettings: () => ({
                ...settingsDefaults,
                petsEnabled: accountSettingsState.petsEnabled,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
                petsDesktopOverlayDefaultEnabled: true,
                petsDesktopOverlayDefaultVisibilityMode: 'attentionOrActive',
            }),
            useLocalSettings: () => ({
                ...localSettingsDefaults,
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: localSettingsState.petsSelectedPetOverride,
                petsCompanionSizeScale: localSettingsState.petsCompanionSizeScale,
                petsDetectCodexPets: localSettingsState.petsDetectCodexPets,
                desktopPetOverlayEnabledOverride: 'inherit',
                desktopPetOverlayVisibilityModeOverride: 'inherit',
                desktopPetOverlayAnchor: 'bottomRight',
                desktopPetOverlayOffset: { x: 0, y: 0 },
                desktopPetOverlayLocked: false,
            }),
            useAllMachines: () => machinesState.current,
            storage,
        },
    });
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsSpy,
    useApplyLocalSettings: () => applyLocalSettingsSpy,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));

function findAllSourceRows(screen: RenderScreenResult) {
    return screen.findAll((node) => {
        const testID = node.props?.testID;
        return typeof testID === 'string' && testID.startsWith('settings-pets-select-source');
    });
}

function findSettingsItemByTestId(screen: RenderScreenResult, testID: string) {
    return screen.findAll((node) => (
        node.props?.testID === testID
        && typeof node.props?.title !== 'undefined'
    ))[0] ?? null;
}

function hasDescendantTestId(node: ReturnType<RenderScreenResult['findByTestId']>, testID: string): boolean {
    if (!node) return false;
    return node.findAll((candidate) => candidate.props?.testID === testID).length > 0;
}

function readNumericStyleValue(node: ReturnType<RenderScreenResult['findByTestId']>, key: 'width' | 'height'): number | null {
    const value = StyleSheet.flatten(node?.props?.style)?.[key];
    return typeof value === 'number' ? value : null;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe('PetsSettingsScreen', () => {
    afterEach(async () => {
        standardCleanup();
        featureState.companionEnabled = true;
        featureState.companionBlockedBy = 'server';
        featureState.syncEnabled = false;
        tauriDesktopState.current = true;
        localSettingsState.petsDetectCodexPets = true;
        localSettingsState.petsSelectedPetOverride = { kind: 'inherit' };
        localSettingsState.petsCompanionSizeScale = 1;
        accountSettingsState.petsEnabled = false;
        applySettingsSpy.mockClear();
        applyLocalSettingsSpy.mockClear();
        machineRpcWithServerScopeMock.mockReset();
        serverFetchMock.mockClear();
        resetDesktopPetOverlayPositionMock.mockClear();
        openExternalUrlMock.mockClear();
        upsertAccountPetSpy.mockClear();
        upsertLocalPetSourceSpy.mockClear();
        removeLocalPetSourceSpy.mockClear();
        accountPetsState.current = {};
        localPetSourcesState.current = {};
        machinesState.current = [createMachineFixture({ id: 'machine-pets' })];
        activeServerSnapshotState.current = {
            serverId: 'server-pets',
            serverUrl: 'https://pets.example.test',
            generation: 1,
        };
    });

    it('shows local-only pet controls when companion is enabled and sync is unavailable', async () => {
        featureState.companionEnabled = true;
        featureState.syncEnabled = false;

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-preview')).toBeNull();
        expect(screen.findByTestId('settings-pets-preview-sprite')).toBeNull();
        expect(screen.findByTestId('settings-pets-local-library-list')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-codex-library-list')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-codex-detect-group')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).toBeNull();
        expect(screen.findByTestId('settings-pets-detect-codex-pets')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-use-on-this-device')).toBeNull();
        expect(screen.findByTestId('settings-pets-built-in-source-blink')).not.toBeNull();
        expect(findAllSourceRows(screen)).toHaveLength(0);
        expect(screen.findByTestId('settings-pets-account-library-list')).toBeNull();
        expect(screen.findByTestId('settings-pets-import-to-account')).toBeNull();
    });

    it('renders bundled built-in pets as selectable account default sources', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-device-pet-grid')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-built-in-card-grid')).not.toBeNull();
        for (const petId of expectedBuiltInPetIds) {
            expect(screen.findByTestId(`settings-pets-built-in-tile-${petId}`)).not.toBeNull();
            expect(screen.findByTestId(`settings-pets-built-in-card-${petId}`)).not.toBeNull();
            expect(screen.findByTestId(`settings-pets-built-in-source-${petId}`)).not.toBeNull();
            expect(screen.findByTestId(`settings-pets-built-in-preview-${petId}`)).not.toBeNull();
            expect(readNumericStyleValue(
                screen.findByTestId(`settings-pets-built-in-preview-${petId}`),
                'width',
            )).toBeGreaterThanOrEqual(104);
            expect(readNumericStyleValue(
                screen.findByTestId(`settings-pets-built-in-preview-${petId}`),
                'height',
            )).toBeGreaterThanOrEqual(112);
        }
        expect(screen.findByTestId('settings-pets-built-in-source-holly')).toBeNull();
        expect(screen.findByTestId('settings-pets-selection-control-blink')?.props.accessibilityRole).toBe('checkbox');
        expect(screen.findByTestId('settings-pets-selection-control-blink')?.props.accessibilityState).toEqual({
            checked: true,
        });

        await screen.pressByTestIdAsync('settings-pets-built-in-source-milo');

        expect(applySettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
        });
    });

    it('lets this device choose one companion size for pet surfaces and previews', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        const slider = screen.findByTestId('settings-pets-companion-size-slider');
        const track = screen.findByTestId('settings-pets-companion-size-slider-track');

        expect(slider).not.toBeNull();
        expect(track).not.toBeNull();

        await act(async () => {
            invokeTestInstanceHandler(track, 'onLayout', {
                nativeEvent: {
                    layout: { width: 200, height: 40, x: 0, y: 0 },
                },
            });
        });
        await act(async () => {
            invokeTestInstanceHandler(track, 'onResponderGrant', {
                nativeEvent: {
                    locationX: 200,
                },
            });
        });

        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsCompanionSizeScale: 1.5,
        });
    });

    it('applies the local companion size scale to settings pet previews', async () => {
        localSettingsState.petsCompanionSizeScale = 1.5;
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        const preview = screen.findByTestId('settings-pets-built-in-preview-blink');
        const previewImage = preview?.findAllByType('Image')[0];
        const previewImageStyle = StyleSheet.flatten(previewImage?.props.style);

        expect(previewImageStyle?.width).toBeGreaterThan(430);
        expect(previewImageStyle?.height).toBeGreaterThan(600);
    });

    it('lays out device pets as responsive tiles instead of sparse full-width rows', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);
        const grid = screen.findByTestId('settings-pets-device-pet-grid');

        await act(async () => {
            grid?.props.onLayout?.({
                nativeEvent: {
                    layout: { width: 900, height: 320, x: 0, y: 0 },
                },
            });
        });

        for (const petId of expectedBuiltInPetIds) {
            expect(readNumericStyleValue(
                screen.findByTestId(`settings-pets-built-in-tile-${petId}`),
                'width',
            )).toBeLessThanOrEqual(168);
        }
    });

    it('selects a built-in pet as the effective device pet when a local override was active', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        localSettingsState.petsSelectedPetOverride = {
            kind: 'happierManagedLocal',
            sourceKey: importedLocalPetMetadata.sourceKey,
        };

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-built-in-source-fury');

        expect(applySettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetRef: { kind: 'builtIn', petId: 'fury' },
        });
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetOverride: { kind: 'inherit' },
        });
    });

    it('hides desktop overlay controls outside the Tauri desktop shell', async () => {
        tauriDesktopState.current = false;

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-desktop-overlay-enabled')).toBeNull();
        expect(screen.findByTestId('settings-pets-desktop-overlay-device-override')).toBeNull();
        expect(screen.findByTestId('settings-pets-desktop-overlay-reset-position')).toBeNull();
    });

    it('resets the native desktop pet overlay position from the reset row', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-desktop-overlay-reset-position');

        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            desktopPetOverlayOffset: { x: 0, y: 0 },
            desktopPetOverlayAnchor: 'bottomRight',
        });
        expect(resetDesktopPetOverlayPositionMock).toHaveBeenCalledTimes(1);
    });

    it('opens the pets docs help entry from settings', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-help-docs');

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://docs.happier.dev');
    });

    it('lets desktop users choose attention-or-active overlay visibility for this device', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        const visibilityDropdown = screen.root.findAll((node) => (
            String(node.type) === 'DropdownMenu'
            && Array.isArray(node.props.items)
            && node.props.items.some((item: { id?: string }) => item.id === 'attentionOrActive')
        ))[0] ?? null;

        expect(screen.findByTestId('settings-pets-desktop-overlay-visibility-mode')).not.toBeNull();
        expect(visibilityDropdown).not.toBeNull();

        await act(async () => {
            visibilityDropdown?.props.onSelect?.('attentionOrActive');
        });

        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            desktopPetOverlayVisibilityModeOverride: 'attentionOrActive',
        });
    });

    it('does not scan Codex pets until the user requests detection', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        await renderScreen(<PetsSettingsScreen />);

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('detects Codex pets from the explicit detect action row', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [detectedPet],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-pets-detect-codex-pets')?.props.onPress).toBeTypeOf('function');
        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
            payload: expect.objectContaining({
                includeDetectedCodexHomes: true,
                includeUserCodexHome: true,
                includeConnectedServiceCodexHomes: true,
                includeManagedLocal: true,
            }),
        });
        expect(screen.findByTestId('settings-pets-codex-library-list')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).not.toBeNull();
        expect(screen.findByTestId(detectedPetTestIds.tile)).not.toBeNull();
        expect(screen.findByTestId(detectedPetTestIds.source)).not.toBeNull();
        expect(screen.findByTestId(detectedPetTestIds.preview)).not.toBeNull();
        expect(hasDescendantTestId(
            screen.findByTestId('settings-pets-codex-detect-group'),
            detectedPetTestIds.tile,
        )).toBe(false);
        expect(hasDescendantTestId(
            screen.findByTestId('settings-pets-detected-codex-pets-list'),
            detectedPetTestIds.tile,
        )).toBe(true);
        expect(screen.findByTestId(detectedPetTestIds.useOnThisDevice)).not.toBeNull();
        expect(findSettingsItemByTestId(screen, detectedPetTestIds.useOnThisDevice)).toBeNull();

        expect(screen.findByTestId(detectedPetTestIds.source)?.props.onPress).toBeUndefined();

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
            method: PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE,
        }));
    });

    it('shows a progress state while Codex pet detection is running', async () => {
        const discovery = createDeferred<{ ok: true; pets: DiscoveredPetPackageV1[] }>();
        machineRpcWithServerScopeMock.mockReturnValueOnce(discovery.promise);

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await act(async () => {
            screen.findByTestId('settings-pets-detect-codex-pets')?.props.onPress?.();
        });

        expect(findSettingsItemByTestId(screen, 'settings-pets-detect-codex-pets')?.props.loading).toBe(true);
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).toBeNull();

        await act(async () => {
            discovery.resolve({ ok: true, pets: [detectedPet] });
            await discovery.promise;
        });

        expect(screen.findByTestId('settings-pets-detect-codex-pets')?.props.loading).toBeFalsy();
        expect(screen.findByTestId(detectedPetTestIds.source)).not.toBeNull();
    });

    it('keeps previously detected pets visible while a refresh is in flight and replaces them when the refresh completes empty', async () => {
        const refreshDetectedPet = {
            ...detectedPet,
            sourceKey: 'detected:milo-e2e-fixture',
            petId: 'milo-e2e-fixture',
            displayName: 'Milo fixture',
            manifest: {
                ...detectedPet.manifest,
                id: 'milo-e2e-fixture',
                displayName: 'Milo fixture',
            },
            previewHandle: {
                kind: 'daemonSourceKey',
                sourceKey: 'detected:milo-e2e-fixture',
            },
            digest: 'sha256:milo-detected',
        } satisfies DiscoveredPetPackageV1;
        const refresh = createDeferred<{ ok: true; pets: DiscoveredPetPackageV1[] }>();
        let discoverCallCount = 0;
        machineRpcWithServerScopeMock.mockImplementation(({ method, payload }: { method: string; payload?: { sourceKey?: string } }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                discoverCallCount += 1;
                if (discoverCallCount === 1) return Promise.resolve({ ok: true, pets: [refreshDetectedPet] });
                return refresh.promise;
            }
            if (method === PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET) {
                return Promise.resolve({
                    sourceKey: payload?.sourceKey ?? refreshDetectedPet.sourceKey,
                    mediaType: refreshDetectedPet.mediaType,
                    digest: refreshDetectedPet.digest,
                    dataBase64: 'AQID',
                    sizeBytes: refreshDetectedPet.sizeBytes,
                });
            }
            return Promise.reject(new Error(`Unexpected RPC method ${method}`));
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        expect(screen.findByTestId('settings-pets-detected-source-detected-milo-e2e-fixture')).not.toBeNull();

        await act(async () => {
            void screen.findByTestId('settings-pets-detect-codex-pets')?.props.onPress?.();
        });

        expect(screen.findByTestId('settings-pets-detected-source-detected-milo-e2e-fixture')).not.toBeNull();

        await act(async () => {
            refresh.resolve({ ok: true, pets: [] });
            await refresh.promise;
        });

        expect(screen.findByTestId('settings-pets-detected-codex-pets-empty')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).toBeNull();
    });

    it('shows a skeleton while detected Codex pet previews are loading', async () => {
        const preview = createDeferred<{
            sourceKey: string;
            mediaType: 'image/webp';
            digest: string;
            dataBase64: string;
            sizeBytes: number;
        }>();
        machineRpcWithServerScopeMock.mockImplementation(({ method }: { method: string }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return Promise.resolve({ ok: true, pets: [detectedPet] });
            }
            if (method === PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET) {
                return preview.promise;
            }
            return Promise.reject(new Error(`Unexpected RPC method ${method}`));
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(screen.findByTestId(`${detectedPetTestIds.preview}-skeleton`)).not.toBeNull();

        await act(async () => {
            preview.resolve({
                sourceKey: detectedPet.sourceKey,
                mediaType: 'image/webp',
                digest: detectedPet.digest,
                dataBase64: 'AQID',
                sizeBytes: 3,
            });
            await preview.promise;
        });
        await flushHookEffects();

        expect(screen.findByTestId(`${detectedPetTestIds.preview}-skeleton`)).toBeNull();
        expect(screen.root.findAllByType('Image').some((node) => (
            node.props.source === 'data:image/webp;base64,AQID'
        ))).toBe(true);
    });


    it('shows an empty state after Codex pet detection finds no compatible pets', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(screen.findByTestId('settings-pets-detected-codex-pets-empty')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).toBeNull();
    });

    it('shows an error state when Codex pet detection fails', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('daemon unavailable'));

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(screen.findByTestId('settings-pets-detected-codex-pets-error')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).toBeNull();
    });

    it('shows a daemon refresh state when the connected daemon lacks pet discovery', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(
            new Error('RPC method not available'),
            { errorCode: 'RPC_METHOD_NOT_AVAILABLE' },
        ));

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(screen.findByTestId('settings-pets-detected-codex-pets-daemon-mismatch')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-error')).toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).toBeNull();
    });

    it('replaces stale detected pets with the latest daemon refresh state', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                pets: [detectedPet],
            })
            .mockRejectedValueOnce(Object.assign(
                new Error('RPC method not available'),
                { errorCode: 'RPC_METHOD_NOT_AVAILABLE' },
            ));

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).not.toBeNull();

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(screen.findByTestId('settings-pets-detected-codex-pets-daemon-mismatch')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).toBeNull();
    });

    it('detects Codex pets against an active daemon machine instead of the first listed machine', async () => {
        machinesState.current = [
            createMachineFixture({ id: 'machine-inactive', active: false }),
            createMachineFixture({ id: 'machine-active', active: true }),
        ];
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [detectedPet],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-active',
            serverId: 'server-pets',
        }));
    });

    it('shows a no-target state when no daemon machine is available for detection', async () => {
        machinesState.current = [];

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-no-target')).not.toBeNull();
    });

    it('detects Codex pets from the action row even when the old local detection toggle is disabled', async () => {
        localSettingsState.petsDetectCodexPets = false;
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [detectedPet],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                includeDetectedCodexHomes: true,
            }),
        }));
    });

    it('hides pet library controls when the companion feature is denied even if sync is enabled', async () => {
        featureState.companionEnabled = false;
        featureState.companionBlockedBy = 'server';
        featureState.syncEnabled = true;

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-disabled')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-account-library-list')).toBeNull();
        expect(screen.findByTestId('settings-pets-local-library-list')).toBeNull();
        expect(screen.findByTestId('settings-pets-import-to-account')).toBeNull();
        expect(screen.getTextContent()).toContain('Pets are disabled by this server');
        expect(screen.getTextContent()).toContain('Your administrator has turned off pet companions for this server.');
    });

    it('uses the feature-toggle disabled copy when pets are locally disabled', async () => {
        featureState.companionEnabled = false;
        featureState.companionBlockedBy = 'local_policy';

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-disabled')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Pets are disabled');
        expect(screen.getTextContent()).toContain('Enable Pets in Features to use companions on this device.');
        expect(screen.getTextContent()).not.toContain('Pets are disabled by this server');
    });

    it('renders synced account pets as selectable account default sources', async () => {
        featureState.companionEnabled = true;
        featureState.syncEnabled = true;
        accountPetsState.current = {
            [accountPet.accountPetId]: accountPet,
        };

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-account-pet-grid')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-account-pet-card-grid')).not.toBeNull();
        expect(screen.findByTestId(accountPetTestIds.tile)).not.toBeNull();
        expect(screen.findByTestId(accountPetTestIds.preview)).not.toBeNull();
        expect(screen.findByTestId(`${accountPetTestIds.preview}-skeleton`)).not.toBeNull();
        expect(findSettingsItemByTestId(screen, accountPetTestIds.source)).toBeNull();
        expect(screen.findByTestId(accountPetTestIds.source)).not.toBeNull();
        await screen.pressByTestIdAsync(accountPetTestIds.source);

        expect(applySettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetRef: { kind: 'accountPet', accountPetId: accountPet.accountPetId },
        });
    });

    it('selects an account pet as the effective device pet when a local override was active', async () => {
        featureState.companionEnabled = true;
        featureState.syncEnabled = true;
        accountPetsState.current = {
            [accountPet.accountPetId]: accountPet,
        };
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        localSettingsState.petsSelectedPetOverride = {
            kind: 'happierManagedLocal',
            sourceKey: importedLocalPetMetadata.sourceKey,
        };

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync(accountPetTestIds.source);

        expect(applySettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetRef: { kind: 'accountPet', accountPetId: accountPet.accountPetId },
        });
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetOverride: { kind: 'inherit' },
        });
    });

    it('discovers daemon pets from the active machine and server scope', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [detectedPet],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-detect-codex-pets')?.props.onPress).toBeTypeOf('function');
        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
            payload: expect.objectContaining({
                includeDetectedCodexHomes: true,
                includeUserCodexHome: true,
                includeConnectedServiceCodexHomes: true,
                includeManagedLocal: true,
            }),
        });
        expect(screen.findByTestId(detectedPetTestIds.source)).not.toBeNull();
        expect(screen.findByTestId(detectedPetTestIds.useOnThisDevice)).not.toBeNull();
        expect(findSettingsItemByTestId(screen, detectedPetTestIds.useOnThisDevice)).toBeNull();
        expect(upsertLocalPetSourceSpy).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'detectedCodexHome',
            sourceKey: detectedPet.sourceKey,
            petId: detectedPet.petId,
            displayName: detectedPet.displayName,
            daemonTarget: {
                machineId: 'machine-pets',
                serverId: 'server-pets',
            },
        }));
        expect(JSON.stringify(localPetSourcesState.current)).not.toContain('/Users/tester');
    });

    it('imports a discovered daemon pet for local managed selection', async () => {
        machineRpcWithServerScopeMock.mockImplementation(({ method }: { method: string }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return Promise.resolve({ ok: true, pets: [detectedPet] });
            }
            if (method === PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET) {
                return Promise.resolve({
                    sourceKey: detectedPet.sourceKey,
                    mediaType: 'image/webp',
                    digest: detectedPet.digest,
                    dataBase64: 'AQID',
                    sizeBytes: 3,
                });
            }
            if (method === PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE) {
                return Promise.resolve({ importedPet: importedLocalPet });
            }
            return Promise.reject(new Error(`Unexpected RPC method ${method}`));
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        expect(screen.findByTestId('settings-pets-use-on-this-device')).toBeNull();
        expect(screen.findByTestId(detectedPetTestIds.useOnThisDevice)?.props.onPress).toBeTypeOf('function');
        await screen.pressByTestIdAsync(detectedPetTestIds.useOnThisDevice);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE,
            payload: { sourceKey: detectedPet.sourceKey },
        });
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetOverride: {
                kind: 'happierManagedLocal',
                sourceKey: importedLocalPet.sourceKey,
            },
        });
        expect(upsertLocalPetSourceSpy).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'happierManagedLocal',
            sourceKey: importedLocalPet.sourceKey,
            petId: importedLocalPet.petId,
            displayName: importedLocalPet.displayName,
            daemonTarget: {
                machineId: 'machine-pets',
                serverId: 'server-pets',
            },
        }));
        expect(JSON.stringify(localPetSourcesState.current)).not.toContain('/Users/tester');
        expect(screen.findByTestId(importedLocalPetTestIds.source)).not.toBeNull();
    });

    it('shows an error when a discovered daemon pet cannot be imported locally', async () => {
        machineRpcWithServerScopeMock.mockImplementation(({ method }: { method: string }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return Promise.resolve({ ok: true, pets: [detectedPet] });
            }
            if (method === PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE) {
                return Promise.resolve({
                    ok: false,
                    errorCode: 'not_found',
                    error: 'The detected pet is no longer available.',
                });
            }
            return Promise.reject(new Error(`Unexpected RPC method ${method}`));
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        await screen.pressByTestIdAsync(detectedPetTestIds.useOnThisDevice);

        expect(screen.findByTestId('settings-pets-import-local-daemon-error')).not.toBeNull();
        expect(screen.findByTestId(detectedPetTestIds.source)).not.toBeNull();
        expect(applyLocalSettingsSpy).not.toHaveBeenCalledWith(expect.objectContaining({
            petsSelectedPetOverride: expect.objectContaining({
                kind: 'happierManagedLocal',
            }),
        }));
    });

    it('deduplicates repeated local import presses while daemon import is running', async () => {
        const importLocal = createDeferred<{ importedPet: ImportedLocalPetPackageV1 }>();
        machineRpcWithServerScopeMock.mockImplementation(({ method }: { method: string }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return Promise.resolve({ ok: true, pets: [detectedPet] });
            }
            if (method === PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE) {
                return importLocal.promise;
            }
            return Promise.reject(new Error(`Unexpected RPC method ${method}`));
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        await act(async () => {
            screen.findByTestId(detectedPetTestIds.useOnThisDevice)?.props.onPress?.({
                stopPropagation: vi.fn(),
            });
        });
        await act(async () => {
            screen.findByTestId(detectedPetTestIds.useOnThisDevice)?.props.onPress?.({
                stopPropagation: vi.fn(),
            });
        });

        expect(machineRpcWithServerScopeMock.mock.calls.filter((call) => (
            call[0]?.method === PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE
        ))).toHaveLength(1);

        await act(async () => {
            importLocal.resolve({ importedPet: importedLocalPet });
            await importLocal.promise;
        });
    });

    it('renders persisted imported Codex pets without running detection', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            sourceKey: importedLocalPetMetadata.sourceKey,
            mediaType: 'image/webp',
            digest: importedLocalPetMetadata.digest,
            dataBase64: 'AQID',
            sizeBytes: 3,
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);
        await flushHookEffects();

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
            method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET,
            payload: { sourceKey: importedLocalPetMetadata.sourceKey },
        });
        expect(screen.findByTestId(importedLocalPetTestIds.source)).not.toBeNull();
        expect(screen.findByTestId(importedLocalPetTestIds.removeFromDevice)).not.toBeNull();
        expect(screen.root.findAllByType('Image').some((node) => (
            node.props.source === 'data:image/webp;base64,AQID'
        ))).toBe(true);
    });

    it('filters persisted local pets to the active daemon target scope', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
            'managed:other-server': {
                ...importedLocalPetMetadata,
                sourceKey: 'managed:other-server',
                displayName: 'Other server pet',
                daemonTarget: {
                    machineId: 'machine-other',
                    serverId: 'server-other',
                },
            },
        };

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId(importedLocalPetTestIds.source)).not.toBeNull();
        expect(screen.findByTestId('settings-pets-select-source-local-managed-other-server')).toBeNull();
    });

    it('uses unique source and account keys for dynamic pet test ids', async () => {
        featureState.syncEnabled = true;
        accountPetsState.current = {
            [accountPet.accountPetId]: accountPet,
            'account-pet-2': {
                ...accountPet,
                accountPetId: 'account-pet-2',
            },
        };
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
            'managed:blink-second': {
                ...importedLocalPetMetadata,
                sourceKey: 'managed:blink-second',
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [
                detectedPet,
                {
                    ...detectedPet,
                    sourceKey: 'detected:blink-second',
                },
            ],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(screen.findByTestId('settings-pets-select-source-local-managed-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-select-source-local-managed-blink-second')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-select-source-account-account-pet-1')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-select-source-account-account-pet-2')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-remove-from-device-managed-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-remove-from-device-managed-blink-second')).not.toBeNull();
    });

    it('removes a persisted imported Codex pet from this device and clears the local selection', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        localSettingsState.petsSelectedPetOverride = {
            kind: 'happierManagedLocal',
            sourceKey: importedLocalPetMetadata.sourceKey,
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            sourceKey: importedLocalPetMetadata.sourceKey,
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync(importedLocalPetTestIds.removeFromDevice);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: 'pets.forgetLocalPackage',
            payload: { sourceKey: importedLocalPetMetadata.sourceKey },
        });
        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetOverride: { kind: 'inherit' },
        });
    });

    it('removes a persisted imported Codex pet without clearing a different local selection', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        localSettingsState.petsSelectedPetOverride = {
            kind: 'happierManagedLocal',
            sourceKey: 'managed:different-pet',
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            sourceKey: importedLocalPetMetadata.sourceKey,
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync(importedLocalPetTestIds.removeFromDevice);

        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
        expect(applyLocalSettingsSpy).not.toHaveBeenCalled();
    });

    it('removes a persisted imported Codex pet from the device list when daemon removal fails', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        machineRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET) {
                return {
                    sourceKey: importedLocalPetMetadata.sourceKey,
                    mediaType: importedLocalPetMetadata.mediaType,
                    digest: importedLocalPetMetadata.digest,
                    dataBase64: 'cGV0LXByZXZpZXc=',
                    sizeBytes: importedLocalPetMetadata.sizeBytes,
                };
            }
            if (params.method === PET_DAEMON_RPC_METHODS.FORGET_LOCAL_PACKAGE) {
                throw new Error('daemon unavailable');
            }
            return null;
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync(importedLocalPetTestIds.removeFromDevice);
        await flushHookEffects();

        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
        expect(applyLocalSettingsSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId(importedLocalPetTestIds.source)).toBeNull();
        expect(screen.findByTestId('settings-pets-remove-local-daemon-error')).not.toBeNull();
        expect(findSettingsItemByTestId(screen, 'settings-pets-remove-local-daemon-error')?.props.detail).toBe('daemon_forget_failed');
    });

    it('keeps persisted imported Codex pets removable when no daemon target is available', async () => {
        machinesState.current = [];
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        machineRpcWithServerScopeMock.mockClear();
        await screen.pressByTestIdAsync(importedLocalPetTestIds.removeFromDevice);

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
            method: PET_DAEMON_RPC_METHODS.FORGET_LOCAL_PACKAGE,
        }));
        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
        expect(screen.findByTestId(importedLocalPetTestIds.source)).toBeNull();
        expect(findSettingsItemByTestId(screen, 'settings-pets-remove-local-daemon-error')?.props.detail).toBe('daemon_unavailable');
    });

    it('deduplicates repeated remove presses while daemon removal is running', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        const removal = createDeferred<{ ok: true; sourceKey: string }>();
        machineRpcWithServerScopeMock.mockReturnValueOnce(removal.promise);

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await act(async () => {
            screen.findByTestId(importedLocalPetTestIds.removeFromDevice)?.props.onPress?.({
                stopPropagation: vi.fn(),
            });
        });
        await act(async () => {
            screen.findByTestId(importedLocalPetTestIds.removeFromDevice)?.props.onPress?.({
                stopPropagation: vi.fn(),
            });
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            removal.resolve({ ok: true, sourceKey: importedLocalPetMetadata.sourceKey });
            await removal.promise;
        });

        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
    });

    it('imports a discovered daemon pet into the account library', async () => {
        featureState.syncEnabled = true;
        machineRpcWithServerScopeMock.mockImplementation(({ method }: { method: string }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return Promise.resolve({
                    ok: true,
                    pets: [detectedPet],
                });
            }
            if (method === PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET) {
                return Promise.resolve({
                    sourceKey: detectedPet.sourceKey,
                    mediaType: 'image/webp',
                    digest: detectedPet.digest,
                    dataBase64: 'AQID',
                    sizeBytes: 3,
                });
            }
            if (method === PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE) {
                return Promise.resolve({
                    ok: true,
                    target: 'account',
                    account: {
                        ok: true,
                        pet: accountPet,
                    },
                });
            }
            return Promise.reject(new Error(`Unexpected RPC method ${method}`));
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        expect(screen.findByTestId('settings-pets-import-to-account')).toBeNull();
        expect(screen.findByTestId(detectedPetTestIds.importToAccount)?.props.onPress).toBeTypeOf('function');
        expect(findSettingsItemByTestId(screen, detectedPetTestIds.importToAccount)).toBeNull();
        await screen.pressByTestIdAsync(detectedPetTestIds.importToAccount);

        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE,
            payload: { sourceKey: detectedPet.sourceKey, petsSyncEnabled: true },
        });
        expect(applySettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetRef: { kind: 'accountPet', accountPetId: accountPet.accountPetId },
        });
        expect(screen.findByTestId(accountPetTestIds.source)).not.toBeNull();
    });

    it('renders account pets disabled by default', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-enabled')?.props.value).toBe(false);
    });

    it('persists account pet enablement when toggled on', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        invokeTestInstanceHandler(
            screen.findByTestId('settings-pets-enabled'),
            'onValueChange',
            true,
            'settings-pets-enabled',
        );

        expect(applySettingsSpy).toHaveBeenCalledWith({ petsEnabled: true });
    });

    it('persists account pet enablement when toggled off', async () => {
        accountSettingsState.petsEnabled = true;
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-enabled')?.props.value).toBe(true);
        invokeTestInstanceHandler(
            screen.findByTestId('settings-pets-enabled'),
            'onValueChange',
            false,
            'settings-pets-enabled',
        );

        expect(applySettingsSpy).toHaveBeenCalledWith({ petsEnabled: false });
    });

    it('persists local device override actions', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        const deviceOverrideMenu = screen.findAllByType('DropdownMenu')[0];
        invokeTestInstanceHandler(
            deviceOverrideMenu,
            'onSelect',
            'disabled',
            'settings-pets-device-override',
        );

        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({ petsEnabledOverride: 'disabled' });
    });

    it('exposes one device override test id for each override control', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findAllByTestId('settings-pets-device-override')).toHaveLength(1);
        expect(screen.findAllByTestId('settings-pets-desktop-overlay-device-override')).toHaveLength(1);
        const deviceOverrideMenu = screen.findAllByType('DropdownMenu')[0];
        expect(deviceOverrideMenu?.props.itemTrigger?.itemProps?.testID).toBeUndefined();
        const desktopOverrideMenu = screen.findAllByType('DropdownMenu')[1];
        expect(desktopOverrideMenu?.props.itemTrigger?.itemProps?.testID).toBeUndefined();
    });
});
