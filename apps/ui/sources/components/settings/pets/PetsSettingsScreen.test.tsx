import * as React from 'react';
import { StyleSheet } from 'react-native';
import {
    PET_DAEMON_RPC_METHODS,
    PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    type AccountPetLibraryEntryV1,
    type DiscoveredPetPackageV1,
    type ImportedLocalPetPackageV1,
} from '@happier-dev/protocol';
import type { StoreApi, UseBoundStore } from 'zustand';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { LocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
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
    syncEnabled: false,
}));
const tauriDesktopState = vi.hoisted(() => ({
    current: true,
}));
const localSettingsState = vi.hoisted(() => ({
    petsDetectCodexPets: true,
    petsCompanionSizeScale: 1,
    petsSelectedPetOverride: { kind: 'inherit' } as
        | { kind: 'inherit' }
        | { kind: 'detectedCodexHome'; sourceKey: string }
        | { kind: 'happierManagedLocal'; sourceKey: string },
}));

const applySettingsSpy = vi.hoisted(() => vi.fn());
const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resetDesktopActivityOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
const accountPetsState = vi.hoisted(() => ({
    current: {} as Record<string, AccountPetLibraryEntryV1>,
}));
const upsertAccountPetSpy = vi.hoisted(() => vi.fn((pet: AccountPetLibraryEntryV1) => {
    accountPetsState.current = {
        ...accountPetsState.current,
        [pet.accountPetId]: pet,
    };
}));
const localPetSourcesState = vi.hoisted(() => ({
    current: {} as Record<string, LocalPetSourceMetadata>,
}));
const upsertLocalPetSourcesSpy = vi.hoisted(() => vi.fn((sources: readonly LocalPetSourceMetadata[]) => {
    localPetSourcesState.current = {
        ...localPetSourcesState.current,
        ...Object.fromEntries(sources.map((source) => [source.sourceKey, source])),
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
const administrationTargetState = vi.hoisted(() => {
    const state: {
        current: {
            target: { serverIdentityId: string; machineId: string };
            serverId: string;
            machine: { id: string };
        } | null;
    } = {
        current: {
            target: { serverIdentityId: 'identity-pets', machineId: 'machine-pets' },
            serverId: 'server-pets',
            machine: { id: 'machine-pets' },
        },
    };
    return Object.assign(state, {
        resolveExecutionTarget: () => state.current,
    });
});
let translationPrefix = 'en';

const petManifest = {
    id: 'blink-e2e-fixture',
    displayName: 'Blink fixture',
    description: 'Test pet fixture',
    spritesheetPath: 'spritesheet.webp',
} as const;

const detectedPet = {
    sourceKey: 'detected:blink-e2e-fixture',
    petId: petManifest.id,
    displayName: petManifest.displayName,
    packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: petManifest,
    source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: '/Users/tester/.codex',
        packagePath: '/Users/tester/.codex/pets/blink-e2e-fixture',
        sourceKey: 'detected:blink-e2e-fixture',
    },
    packagePath: '/Users/tester/.codex/pets/blink-e2e-fixture',
    spritesheetPath: '/Users/tester/.codex/pets/blink-e2e-fixture/spritesheet.webp',
    mediaType: 'image/webp',
    digest: 'sha256:detected',
    sizeBytes: 128,
} satisfies DiscoveredPetPackageV1;

const alternatePetManifest = {
    id: 'milo-e2e-fixture',
    displayName: 'Milo fixture',
    description: 'Alternate test pet fixture',
    spritesheetPath: 'spritesheet.webp',
} as const;

const alternateDetectedPet = {
    sourceKey: 'detected:milo-e2e-fixture',
    petId: alternatePetManifest.id,
    displayName: alternatePetManifest.displayName,
    packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: alternatePetManifest,
    source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: '/Users/tester/.codex',
        packagePath: '/Users/tester/.codex/pets/milo-e2e-fixture',
        sourceKey: 'detected:milo-e2e-fixture',
    },
    packagePath: '/Users/tester/.codex/pets/milo-e2e-fixture',
    spritesheetPath: '/Users/tester/.codex/pets/milo-e2e-fixture/spritesheet.webp',
    mediaType: 'image/webp',
    digest: 'sha256:alternate-detected',
    sizeBytes: 256,
} satisfies DiscoveredPetPackageV1;

const importedLocalPet = {
    sourceKey: 'managed:blink-e2e-fixture',
    petId: petManifest.id,
    displayName: petManifest.displayName,
    digest: 'sha256:managed',
    sizeBytes: 128,
    mediaType: 'image/webp',
    source: {
        kind: 'happierManagedLocal',
        packagePath: '/Users/tester/.happy-dev/pets/imports/blink-e2e-fixture',
        sourceKey: 'managed:blink-e2e-fixture',
    },
    manifest: petManifest,
} satisfies ImportedLocalPetPackageV1;

const importedLocalPetMetadata = {
    sourceKey: importedLocalPet.sourceKey,
    source: importedLocalPet.source,
    displayName: importedLocalPet.displayName,
    manifest: importedLocalPet.manifest,
    mediaType: importedLocalPet.mediaType,
    digest: importedLocalPet.digest,
    sizeBytes: importedLocalPet.sizeBytes,
    daemonTarget: {
        serverId: 'server-pets',
        machineId: 'machine-pets',
    },
} satisfies LocalPetSourceMetadata;

const alternateImportedLocalPet = {
    sourceKey: 'managed:milo-e2e-fixture',
    petId: alternatePetManifest.id,
    displayName: alternatePetManifest.displayName,
    digest: 'sha256:alternate-managed',
    sizeBytes: 256,
    mediaType: 'image/webp',
    source: {
        kind: 'happierManagedLocal',
        packagePath: '/Users/tester/.happy-dev/pets/imports/milo-e2e-fixture',
        sourceKey: 'managed:milo-e2e-fixture',
    },
    manifest: alternatePetManifest,
} satisfies ImportedLocalPetPackageV1;

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
            : { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' };
    },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.current,
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => {
        const target = administrationTargetState.current;
        return {
            selectedTarget: target?.target ?? null,
            canExecute: target !== null,
            resolveExecutionTarget: administrationTargetState.resolveExecutionTarget,
        };
    },
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.current,
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    resetDesktopActivityOverlayPosition: resetDesktopActivityOverlayPositionMock,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `${translationPrefix}:${key}`,
        translateLoose: (key: string) => `${translationPrefix}:${key}`,
        getPreferredLanguage: () => translationPrefix,
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');

    const createPetsStorageStore = () =>
        createStorageStoreMock({
            accountPetsById: accountPetsState.current,
            upsertAccountPet: upsertAccountPetSpy,
            localPetSourcesBySourceKey: localPetSourcesState.current,
            upsertLocalPetSources: upsertLocalPetSourcesSpy,
            removeLocalPetSource: removeLocalPetSourceSpy,
        } as Partial<StorageState> & {
            upsertLocalPetSources: typeof upsertLocalPetSourcesSpy;
            removeLocalPetSource: typeof removeLocalPetSourceSpy;
        });
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
                petsEnabled: false,
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

type TestRowAction = Readonly<{
    id: string;
    onPress: () => void | Promise<void>;
}>;

function findSettingsItemByTestId(screen: RenderScreenResult, testID: string): ReactTestInstance | null {
    return screen.findAll((node) => (
        node.props?.testID === testID
        && typeof node.props?.title !== 'undefined'
    ))[0] ?? null;
}

function hasDescendantTestId(node: ReactTestInstance | null, testID: string): boolean {
    if (!node) return false;
    return node.findAll((candidate) => candidate.props?.testID === testID).length > 0;
}

function readNumericStyleValue(node: ReactTestInstance | null, key: 'width' | 'height'): number | null {
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

function findRowAction(screen: RenderScreenResult, rowTestID: string, actionId: string): TestRowAction | null {
    const row = findSettingsItemByTestId(screen, rowTestID);
    expect(row).not.toBeNull();
    const rightElement: unknown = row?.props.rightElement;
    expect(React.isValidElement<{ actions?: readonly TestRowAction[] }>(rightElement)).toBe(true);
    if (!React.isValidElement<{ actions?: readonly TestRowAction[] }>(rightElement)) return null;
    const action = rightElement.props.actions?.find((candidate) => candidate.id === actionId) ?? null;
    expect(action).not.toBeNull();
    return action;
}

async function pressRowAction(screen: RenderScreenResult, rowTestID: string, actionId: string): Promise<void> {
    const action = findRowAction(screen, rowTestID, actionId);
    if (!action) return;
    await act(async () => {
        await action.onPress();
    });
}

describe('PetsSettingsScreen', () => {
    afterEach(async () => {
        standardCleanup();
        featureState.companionEnabled = true;
        featureState.syncEnabled = false;
        tauriDesktopState.current = true;
        localSettingsState.petsDetectCodexPets = true;
        localSettingsState.petsCompanionSizeScale = 1;
        localSettingsState.petsSelectedPetOverride = { kind: 'inherit' };
        applySettingsSpy.mockClear();
        applyLocalSettingsSpy.mockClear();
        machineRpcWithServerScopeMock.mockReset();
        resetDesktopActivityOverlayPositionMock.mockClear();
        upsertAccountPetSpy.mockClear();
        upsertLocalPetSourcesSpy.mockClear();
        removeLocalPetSourceSpy.mockClear();
        accountPetsState.current = {};
        localPetSourcesState.current = {};
        machinesState.current = [createMachineFixture({ id: 'machine-pets' })];
        activeServerSnapshotState.current = {
            serverId: 'server-pets',
            serverUrl: 'https://pets.example.test',
            generation: 1,
        };
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-pets', machineId: 'machine-pets' },
            serverId: 'server-pets',
            machine: { id: 'machine-pets' },
        };
        translationPrefix = 'en';
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
            expect(screen.findByTestId(`settings-pets-built-in-source-${petId}`)).not.toBeNull();
            expect(screen.findByTestId(`settings-pets-built-in-card-${petId}`)).not.toBeNull();
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
            )).toBeLessThanOrEqual(180);
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

    it('resets the existing desktop activity overlay position from the pet reset row', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-desktop-overlay-reset-position');

        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0,
            desktopOverlayOffsetY: 0,
        });
        expect(resetDesktopActivityOverlayPositionMock).toHaveBeenCalledTimes(1);
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

    it('detects Codex pets when a command palette action requests a refresh', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [detectedPet],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const { requestCodexPetRefresh } = await import('./petSettingsCommandEvents');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();

        await act(async () => {
            requestCodexPetRefresh();
        });
        await flushHookEffects();

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
            payload: expect.objectContaining({
                includeDetectedCodexHomes: true,
            }),
        }));
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).not.toBeNull();
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
        expect(screen.findByTestId('settings-pets-detect-codex-pets')?.props.rightElement).toBeUndefined();
        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                includeDetectedCodexHomes: true,
            }),
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
        expect(screen.findByTestId('settings-pets-detected-source-blink-e2e-fixture')).not.toBeNull();
    });

    it('does not apply discovery results after their Administration target stops being current', async () => {
        const discovery = createDeferred<{ ok: true; pets: DiscoveredPetPackageV1[] }>();
        machineRpcWithServerScopeMock.mockReturnValueOnce(discovery.promise);

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await act(async () => {
            void screen.findByTestId('settings-pets-detect-codex-pets')?.props.onPress?.();
        });
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-next', machineId: 'machine-next' },
            serverId: 'server-next',
            machine: { id: 'machine-next' },
        };
        await act(async () => {
            await screen.update(<PetsSettingsScreen />);
        });

        await act(async () => {
            discovery.resolve({ ok: true, pets: [detectedPet] });
            await discovery.promise;
        });

        expect(upsertLocalPetSourcesSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-pets-detected-source-blink-e2e-fixture')).toBeNull();
    });

    it('keeps previously detected pets visible while a refresh is in flight and replaces them when the refresh completes empty', async () => {
        const refresh = createDeferred<{ ok: true; pets: DiscoveredPetPackageV1[] }>();
        const refreshDetectedPet = alternateDetectedPet;
        let discoverCallCount = 0;
        machineRpcWithServerScopeMock.mockImplementation(({ method, payload }: { method: string; payload?: { sourceKey?: string } }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                discoverCallCount += 1;
                if (discoverCallCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        pets: [refreshDetectedPet],
                    });
                }
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
        expect(screen.findByTestId('settings-pets-detected-source-milo-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).not.toBeNull();

        await act(async () => {
            void screen.findByTestId('settings-pets-detect-codex-pets')?.props.onPress?.();
        });

        expect(screen.findByTestId('settings-pets-detected-source-milo-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-list')).not.toBeNull();

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

        expect(screen.findByTestId('settings-pets-detected-preview-blink-e2e-fixture-skeleton')).not.toBeNull();

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

        expect(screen.findByTestId('settings-pets-detected-preview-blink-e2e-fixture-skeleton')).toBeNull();
        expect(screen.root.findAllByType('Image').some((node) => {
            const source = node.props.source;
            return source === 'data:image/webp;base64,AQID' || source?.uri === 'data:image/webp;base64,AQID';
        })).toBe(true);
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

    it('shows a daemon refresh state when the unavailable RPC code is only in the error message', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('RPC_METHOD_NOT_AVAILABLE'));

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(screen.findByTestId('settings-pets-detected-codex-pets-daemon-mismatch')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-error')).toBeNull();
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

    it('detects Codex pets against the exact Administration target rather than an active or first machine', async () => {
        machinesState.current = [
            createMachineFixture({ id: 'machine-inactive', active: false }),
            createMachineFixture({ id: 'machine-active', active: true }),
        ];
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-admin', machineId: 'machine-admin' },
            serverId: 'server-admin',
            machine: { id: 'machine-admin' },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [detectedPet],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-admin',
            serverId: 'server-admin',
        }));
    });

    it('shows a no-target state when Administration has no executable target for detection', async () => {
        machinesState.current = [];
        administrationTargetState.current = null;

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-pets-detected-codex-pets-no-target')).not.toBeNull();
    });

    it('shows account library and import controls only when companion and sync are both enabled', async () => {
        featureState.companionEnabled = true;
        featureState.syncEnabled = true;

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-account-library-list')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-import-to-account')).toBeNull();
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
        expect(screen.findByTestId('settings-pets-account-tile-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-account-preview-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-account-preview-blink-e2e-fixture-skeleton')).not.toBeNull();
        expect(findSettingsItemByTestId(screen, 'settings-pets-select-source-account-blink-e2e-fixture')).toBeNull();
        expect(screen.findByTestId('settings-pets-select-source-account-blink-e2e-fixture')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-pets-select-source-account-blink-e2e-fixture');

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

        await screen.pressByTestIdAsync('settings-pets-select-source-account-blink-e2e-fixture');

        expect(applySettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetRef: { kind: 'accountPet', accountPetId: accountPet.accountPetId },
        });
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetOverride: { kind: 'inherit' },
        });
    });

    it('detects daemon pets from the selected Administration machine and server scope', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            pets: [detectedPet],
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-pets-detect-codex-pets')?.props.onPress).toBeTypeOf('function');
        expect(screen.findByTestId('settings-pets-detect-codex-pets')?.props.rightElement).toBeUndefined();
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
        expect(screen.findByTestId('settings-pets-detected-tile-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-source-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-preview-blink-e2e-fixture')).not.toBeNull();
        expect(hasDescendantTestId(
            screen.findByTestId('settings-pets-codex-detect-group'),
            'settings-pets-detected-tile-blink-e2e-fixture',
        )).toBe(false);
        expect(hasDescendantTestId(
            screen.findByTestId('settings-pets-detected-codex-pets-list'),
            'settings-pets-detected-tile-blink-e2e-fixture',
        )).toBe(true);
        expect(screen.findByTestId('settings-pets-use-on-this-device-blink-e2e-fixture')).not.toBeNull();
        expect(findSettingsItemByTestId(screen, 'settings-pets-use-on-this-device-blink-e2e-fixture')).toBeNull();
        expect(screen.findByTestId('settings-pets-detected-source-blink-e2e-fixture')?.props.onPress).toBeUndefined();
        expect(upsertLocalPetSourcesSpy).toHaveBeenCalledWith([
            expect.objectContaining({
                sourceKey: detectedPet.sourceKey,
                source: detectedPet.source,
                displayName: detectedPet.displayName,
                manifest: detectedPet.manifest,
                mediaType: detectedPet.mediaType,
                digest: detectedPet.digest,
                sizeBytes: detectedPet.sizeBytes,
                daemonTarget: {
                    serverId: 'server-pets',
                    machineId: 'machine-pets',
                },
            }),
        ]);
    });

    it('imports a discovered daemon pet for local managed selection', async () => {
        machineRpcWithServerScopeMock.mockImplementation(({ method, payload }: { method: string; payload?: { sourceKey?: string } }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return Promise.resolve({ ok: true, pets: [detectedPet, alternateDetectedPet] });
            }
            if (method === PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET) {
                return Promise.resolve({
                    sourceKey: payload?.sourceKey ?? detectedPet.sourceKey,
                    mediaType: 'image/webp',
                    digest: detectedPet.digest,
                    dataBase64: 'AQID',
                    sizeBytes: 3,
                });
            }
            if (method === PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE) {
                return Promise.resolve({ importedPet: alternateImportedLocalPet });
            }
            return Promise.reject(new Error(`Unexpected RPC method ${method}`));
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        await screen.pressByTestIdAsync('settings-pets-use-on-this-device-milo-e2e-fixture');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE,
            payload: { sourceKey: alternateDetectedPet.sourceKey },
        });
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsSelectedPetOverride: {
                kind: 'happierManagedLocal',
                sourceKey: alternateImportedLocalPet.sourceKey,
            },
        });
        expect(upsertLocalPetSourcesSpy).toHaveBeenCalledWith([
            expect.objectContaining({
                sourceKey: alternateImportedLocalPet.sourceKey,
                source: alternateImportedLocalPet.source,
                displayName: alternateImportedLocalPet.displayName,
                manifest: alternateImportedLocalPet.manifest,
                mediaType: alternateImportedLocalPet.mediaType,
                digest: alternateImportedLocalPet.digest,
                sizeBytes: alternateImportedLocalPet.sizeBytes,
                daemonTarget: {
                    serverId: 'server-pets',
                    machineId: 'machine-pets',
                },
            }),
        ]);
        expect(screen.findByTestId('settings-pets-select-source-local-milo-e2e-fixture')).not.toBeNull();
    });

    it('does not persist a local import after its Administration target stops being current', async () => {
        const localImport = createDeferred<{ importedPet: ImportedLocalPetPackageV1 }>();
        machineRpcWithServerScopeMock.mockImplementation(({ method }: { method: string }) => {
            if (method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return Promise.resolve({ ok: true, pets: [detectedPet] });
            }
            if (method === PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE) {
                return localImport.promise;
            }
            return Promise.resolve(null);
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);
        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        upsertLocalPetSourcesSpy.mockClear();
        applyLocalSettingsSpy.mockClear();

        await act(async () => {
            void screen.findByTestId('settings-pets-use-on-this-device-blink-e2e-fixture')?.props.onPress?.();
        });
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-next', machineId: 'machine-next' },
            serverId: 'server-next',
            machine: { id: 'machine-next' },
        };
        await act(async () => {
            await screen.update(<PetsSettingsScreen />);
        });

        await act(async () => {
            localImport.resolve({ importedPet: importedLocalPet });
            await localImport.promise;
        });

        expect(upsertLocalPetSourcesSpy).not.toHaveBeenCalled();
        expect(applyLocalSettingsSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-pets-select-source-local-blink-e2e-fixture')).toBeNull();
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
        await screen.pressByTestIdAsync('settings-pets-use-on-this-device-blink-e2e-fixture');

        expect(screen.findByTestId('settings-pets-import-local-daemon-error')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-detected-source-blink-e2e-fixture')).not.toBeNull();
        expect(applyLocalSettingsSpy).not.toHaveBeenCalledWith(expect.objectContaining({
            petsSelectedPetOverride: expect.objectContaining({
                kind: 'happierManagedLocal',
            }),
        }));
    });

    it('renders persisted imported Codex pets without running detection', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
            method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET,
            payload: { sourceKey: importedLocalPetMetadata.sourceKey },
        });
        expect(screen.findByTestId('settings-pets-select-source-local-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-local-tile-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-local-preview-blink-e2e-fixture')).not.toBeNull();
        expect(screen.findByTestId('settings-pets-remove-from-device-blink-e2e-fixture')).not.toBeNull();
    });

    it('removes a persisted imported Codex pet through its stored daemon target, not the Administration target', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        machinesState.current = [createMachineFixture({ id: 'machine-active', active: true })];
        activeServerSnapshotState.current = {
            serverId: 'server-active',
            serverUrl: 'https://active.example.test',
            generation: 1,
        };
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-admin', machineId: 'machine-admin' },
            serverId: 'server-admin',
            machine: { id: 'machine-admin' },
        };
        localSettingsState.petsSelectedPetOverride = {
            kind: 'happierManagedLocal',
            sourceKey: importedLocalPetMetadata.sourceKey,
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
            if (params.method === 'pets.forgetLocalPackage') {
                return {
                    ok: true,
                    sourceKey: importedLocalPetMetadata.sourceKey,
                };
            }
            return null;
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-remove-from-device-blink-e2e-fixture');

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
            if (params.method === 'pets.forgetLocalPackage') {
                return {
                    ok: true,
                    sourceKey: importedLocalPetMetadata.sourceKey,
                };
            }
            return null;
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-remove-from-device-blink-e2e-fixture');

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
            if (params.method === 'pets.forgetLocalPackage') {
                throw new Error('daemon unavailable');
            }
            return null;
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-remove-from-device-blink-e2e-fixture');
        await flushHookEffects();

        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
        expect(applyLocalSettingsSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-pets-select-source-local-blink-e2e-fixture')).toBeNull();
    });

    it('deduplicates repeated remove presses while daemon removal is running', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        const removal = createDeferred<{ ok: true; sourceKey: string }>();
        machineRpcWithServerScopeMock.mockImplementation((params: { method?: string }) => {
            if (params.method === PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET) {
                return Promise.resolve({
                    sourceKey: importedLocalPetMetadata.sourceKey,
                    mediaType: importedLocalPetMetadata.mediaType,
                    digest: importedLocalPetMetadata.digest,
                    dataBase64: 'cGV0LXByZXZpZXc=',
                    sizeBytes: importedLocalPetMetadata.sizeBytes,
                });
            }
            if (params.method === 'pets.forgetLocalPackage') {
                return removal.promise;
            }
            return Promise.resolve(null);
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await act(async () => {
            screen.findByTestId('settings-pets-remove-from-device-blink-e2e-fixture')?.props.onPress?.({
                stopPropagation: vi.fn(),
            });
        });
        await act(async () => {
            screen.findByTestId('settings-pets-remove-from-device-blink-e2e-fixture')?.props.onPress?.({
                stopPropagation: vi.fn(),
            });
        });

        expect(machineRpcWithServerScopeMock.mock.calls.filter(([params]) => (
            (params as { method?: string }).method === 'pets.forgetLocalPackage'
        ))).toHaveLength(1);

        await act(async () => {
            removal.resolve({ ok: true, sourceKey: importedLocalPetMetadata.sourceKey });
            await removal.promise;
        });

        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
    });

    it('does not re-add a removed managed local pet from a stale discovery rescan', async () => {
        localPetSourcesState.current = {
            [importedLocalPetMetadata.sourceKey]: importedLocalPetMetadata,
        };
        const staleManagedPet = {
            ...importedLocalPet,
            sourceKey: importedLocalPetMetadata.sourceKey,
            source: importedLocalPetMetadata.source,
        } satisfies ImportedLocalPetPackageV1;
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
            if (params.method === 'pets.forgetLocalPackage') {
                return {
                    ok: true,
                    sourceKey: importedLocalPetMetadata.sourceKey,
                };
            }
            if (params.method === PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES) {
                return {
                    ok: true,
                    pets: [staleManagedPet],
                };
            }
            return null;
        });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-remove-from-device-blink-e2e-fixture');
        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');

        expect(removeLocalPetSourceSpy).toHaveBeenCalledWith(importedLocalPetMetadata.sourceKey);
        expect(upsertLocalPetSourcesSpy).not.toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ sourceKey: importedLocalPetMetadata.sourceKey }),
        ]));
        expect(screen.findByTestId('settings-pets-select-source-local-blink-e2e-fixture')).toBeNull();
    });

    it('uses only the scoped local import action test id for one detected pet', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                pets: [detectedPet],
            })
            .mockResolvedValueOnce({
                importedPet: importedLocalPet,
            });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        expect(screen.findByTestId('settings-pets-use-on-this-device')).toBeNull();
        expect(screen.findByTestId('settings-pets-use-on-this-device-blink-e2e-fixture')).not.toBeNull();
        expect(findSettingsItemByTestId(screen, 'settings-pets-use-on-this-device-blink-e2e-fixture')).toBeNull();
        await screen.pressByTestIdAsync('settings-pets-use-on-this-device-blink-e2e-fixture');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE,
            payload: { sourceKey: detectedPet.sourceKey },
        });
    });

    it('uses only the scoped account import action test id for one detected pet', async () => {
        featureState.syncEnabled = true;
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                pets: [detectedPet],
            })
            .mockResolvedValueOnce({
                ok: true,
                target: 'account',
                account: {
                    ok: true,
                    pet: accountPet,
                },
            });

        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        await screen.pressByTestIdAsync('settings-pets-detect-codex-pets');
        expect(screen.findByTestId('settings-pets-import-to-account')).toBeNull();
        expect(screen.findByTestId('settings-pets-import-to-account-blink-e2e-fixture')).not.toBeNull();
        expect(findSettingsItemByTestId(screen, 'settings-pets-import-to-account-blink-e2e-fixture')).toBeNull();
        await screen.pressByTestIdAsync('settings-pets-import-to-account-blink-e2e-fixture');

        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE,
            payload: { sourceKey: detectedPet.sourceKey, petsSyncEnabled: true },
        });
    });

    it('persists explicit account enablement and local device override actions', async () => {
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        expect(screen.findByTestId('settings-pets-enabled')?.props.value).toBe(false);

        invokeTestInstanceHandler(
            screen.findByTestId('settings-pets-enabled'),
            'onValueChange',
            true,
            'settings-pets-enabled',
        );
        const deviceOverrideMenu = screen.findAllByType('DropdownMenu')[0];
        invokeTestInstanceHandler(
            deviceOverrideMenu,
            'onSelect',
            'disabled',
            'settings-pets-device-override',
        );

        expect(applySettingsSpy).toHaveBeenCalledWith({ petsEnabled: true });
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({ petsEnabledOverride: 'disabled' });
    });

    it('refreshes the device override dropdown labels when the language changes and the screen rerenders', async () => {
        translationPrefix = 'en';
        const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
        const screen = await renderScreen(<PetsSettingsScreen />);

        const readOverrideTitles = () => {
            const deviceOverrideMenu = screen.findAllByType('DropdownMenu' as never)[0];
            return deviceOverrideMenu?.props?.items?.map((item: { title: string }) => item.title) ?? [];
        };

        expect(readOverrideTitles()).toEqual([
            'en:settingsPets.overrideInherit',
            'en:settingsPets.overrideEnabled',
            'en:settingsPets.overrideDisabled',
        ]);

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(<PetsSettingsScreen />);
        });

        expect(readOverrideTitles()).toEqual([
            'fr:settingsPets.overrideInherit',
            'fr:settingsPets.overrideEnabled',
            'fr:settingsPets.overrideDisabled',
        ]);
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
