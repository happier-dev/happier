import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
    DaemonPetDiscoverResponseV1Schema,
    DaemonPetForgetLocalPackageResponseV1Schema,
    DaemonPetImportLocalPackageResponseV1Schema,
    DaemonPetImportResponseV1Schema,
    PET_DAEMON_RPC_METHODS,
    ImportedLocalPetPackageV1Schema,
    type AccountPetLibraryEntryV1,
    type DaemonPetDiscoverRequestV1,
    type DaemonPetForgetLocalPackageRequestV1,
    type DaemonPetImportAccountPackageRequestV1,
    type DaemonPetImportLocalPackageRequestV1,
    type DiscoveredPetPackageV1,
    type ImportedLocalPetPackageV1,
} from '@happier-dev/protocol';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { resetDesktopActivityOverlayPosition } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import {
    BUILT_IN_PET_IDS,
    resolveBuiltInPetPackage,
} from '@/components/pets/builtIns/builtInPetRegistry';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { storage, useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { normalizePetCompanionSizeScale } from '@/sync/domains/pets/companionSizeScale';
import { normalizeLocalPetSourceMetadata } from '@/sync/domains/pets/normalizeLocalPetSources';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { PetsAccountLibrarySection } from './petsSettingsScreen/PetsAccountLibrarySection';
import { PetsAccountSettingsSection } from './petsSettingsScreen/PetsAccountSettingsSection';
import { PetsDesktopOverlaySettingsSection } from './petsSettingsScreen/PetsDesktopOverlaySettingsSection';
import { PetsLocalLibrarySection } from './petsSettingsScreen/PetsLocalLibrarySection';
import {
    buildImportPayload,
    isDetectedPet,
    isManagedLocalPet,
    isRpcMethodNotAvailableError,
    managedPetToLocalPetRow,
    metadataToLocalPetRow,
    upsertByKey,
} from './petsSettingsScreen/helpers';
import { usePetSourceActionRows } from './petsSettingsScreen/usePetSourceActionRows';
import { Icon } from '@/components/ui/icons/Icon';
import {
    consumePendingCodexPetRefresh,
    subscribeCodexPetRefresh,
} from './petSettingsCommandEvents';
import type {
    CodexDetectionState,
    LocalPetImportDiagnostic,
    LocalDevicePetRow,
    PetImportCandidate,
} from './petsSettingsScreen/types';

function machineAdministrationExecutionTargetKey(
    target: FreshMachineAdministrationExecutionTargetV1,
): string {
    return [
        target.target.serverIdentityId,
        target.target.machineId,
        target.serverId,
    ].join('\u0000');
}

export function PetsSettingsScreen() {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.pets,
    );
    const executionTarget = administrationTargetSelection.resolveExecutionTarget();
    const executionTargetKey = executionTarget
        ? machineAdministrationExecutionTargetKey(executionTarget)
        : null;
    const targetMachineId = executionTarget?.machine.id ?? '';
    const targetServerId = executionTarget?.serverId ?? '';
    const isExecutionTargetCurrent = React.useCallback((
        target: FreshMachineAdministrationExecutionTargetV1,
    ) => {
        const current = administrationTargetSelection.resolveExecutionTarget();
        return current !== null
            && current.serverId === target.serverId
            && current.machine.id === target.machine.id
            && machineAdministrationTargetsEqual(current.target, target.target);
    }, [administrationTargetSelection.resolveExecutionTarget]);
    const accountPetsById = storage((state) => state.accountPetsById);
    const localPetSourcesBySourceKey = storage((state) => state.localPetSourcesBySourceKey);
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const companionEnabled = useFeatureEnabled('pets.companion');
    const syncEnabled = useFeatureEnabled('pets.sync');
    const [deviceOverrideOpen, setDeviceOverrideOpen] = React.useState(false);
    const [desktopOverlayOverrideOpen, setDesktopOverlayOverrideOpen] = React.useState(false);
    const [desktopOverlayVisibilityModeOpen, setDesktopOverlayVisibilityModeOpen] = React.useState(false);
    const [codexDetectionState, setCodexDetectionState] = React.useState<CodexDetectionState>('idle');
    const [codexDetectionTargetKey, setCodexDetectionTargetKey] = React.useState<string | null>(null);
    const [discoveredPets, setDiscoveredPets] = React.useState<DiscoveredPetPackageV1[]>([]);
    const [discoveredPetsTargetKey, setDiscoveredPetsTargetKey] = React.useState<string | null>(null);
    const [importedLocalPets, setImportedLocalPets] = React.useState<ImportedLocalPetPackageV1[]>([]);
    const [importedLocalPetsTargetKey, setImportedLocalPetsTargetKey] = React.useState<string | null>(null);
    const [importedAccountPets, setImportedAccountPets] = React.useState<AccountPetLibraryEntryV1[]>([]);
    const [localImportDiagnostic, setLocalImportDiagnostic] = React.useState<LocalPetImportDiagnostic | null>(null);
    const [localImportDiagnosticTargetKey, setLocalImportDiagnosticTargetKey] = React.useState<string | null>(null);
    const removingLocalPetSourceKeysRef = React.useRef(new Set<string>());
    const forgottenLocalPetSourceKeysRef = React.useRef(new Set<string>());
    const showDesktopOverlaySettings = isDesktopHost();
    const companionSizeScale = normalizePetCompanionSizeScale(localSettings.petsCompanionSizeScale);
    const scopedDiscoveredPets = discoveredPetsTargetKey === executionTargetKey ? discoveredPets : [];
    const scopedImportedLocalPets = importedLocalPetsTargetKey === executionTargetKey ? importedLocalPets : [];
    const scopedCodexDetectionState = codexDetectionTargetKey === executionTargetKey
        ? codexDetectionState
        : 'idle';
    const scopedLocalImportDiagnostic = localImportDiagnosticTargetKey === executionTargetKey
        ? localImportDiagnostic
        : null;

    const overrideItems: DropdownMenuItem[] = [
        { id: 'inherit', title: t('settingsPets.overrideInherit') },
        { id: 'enabled', title: t('settingsPets.overrideEnabled') },
        { id: 'disabled', title: t('settingsPets.overrideDisabled') },
    ];
    const visibilityModeItems: DropdownMenuItem[] = [
        { id: 'inherit', title: t('settingsPets.visibilityModeInherit') },
        { id: 'alwaysWhenEnabled', title: t('settingsPets.visibilityModeAlwaysWhenEnabled') },
        { id: 'attentionOrActive', title: t('settingsPets.visibilityModeAttentionOrActive') },
        { id: 'attentionOnly', title: t('settingsPets.visibilityModeAttentionOnly') },
    ];

    const localPetRows = React.useMemo((): LocalDevicePetRow[] => {
        const rows = new Map<string, LocalDevicePetRow>();
        for (const source of Object.values(localPetSourcesBySourceKey)) {
            const row = metadataToLocalPetRow(source);
            if (row) rows.set(row.sourceKey, row);
        }
        const daemonTarget = targetMachineId && targetServerId
            ? { machineId: targetMachineId, serverId: targetServerId }
            : null;
        if (!daemonTarget) {
            return Array.from(rows.values());
        }
        for (const pet of scopedDiscoveredPets) {
            if (isManagedLocalPet(pet)) {
                rows.set(pet.sourceKey, managedPetToLocalPetRow(pet, daemonTarget));
            }
        }
        for (const pet of scopedImportedLocalPets) {
            if (isManagedLocalPet(pet)) {
                rows.set(pet.sourceKey, managedPetToLocalPetRow(pet, daemonTarget));
            }
        }
        return Array.from(rows.values());
    }, [localPetSourcesBySourceKey, scopedDiscoveredPets, scopedImportedLocalPets, targetMachineId, targetServerId]);

    const detectedPetRows = React.useMemo(
        () => scopedDiscoveredPets.filter(isDetectedPet),
        [scopedDiscoveredPets],
    );
    const builtInPetRows = React.useMemo(
        () => BUILT_IN_PET_IDS.map((petId) => resolveBuiltInPetPackage(petId)),
        [],
    );

    const accountPets = React.useMemo(() => {
        const byId = new Map<string, AccountPetLibraryEntryV1>();
        for (const pet of Object.values(accountPetsById)) byId.set(pet.accountPetId, pet);
        for (const pet of importedAccountPets) byId.set(pet.accountPetId, pet);
        return Array.from(byId.values());
    }, [accountPetsById, importedAccountPets]);

    const discoverPets = React.useCallback(async () => {
        const target = administrationTargetSelection.resolveExecutionTarget();
        if (!target) {
            setCodexDetectionTargetKey(null);
            setCodexDetectionState('noTarget');
            return;
        }
        const targetKey = machineAdministrationExecutionTargetKey(target);
        if (codexDetectionState === 'loading' && codexDetectionTargetKey === targetKey) return;
        setCodexDetectionTargetKey(targetKey);
        setCodexDetectionState('loading');
        try {
            const payload: DaemonPetDiscoverRequestV1 = {
                includeDetectedCodexHomes: true,
                includeUserCodexHome: true,
                includeConnectedServiceCodexHomes: true,
                includeManagedLocal: true,
            };
            const raw = await machineRpcWithServerScope<unknown, DaemonPetDiscoverRequestV1>({
                machineId: target.machine.id,
                serverId: target.serverId,
                method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
                payload,
            });
            if (!isExecutionTargetCurrent(target)) return;
            if (isRpcMethodNotAvailableError(raw)) {
                setDiscoveredPets([]);
                setDiscoveredPetsTargetKey(targetKey);
                setCodexDetectionTargetKey(targetKey);
                setCodexDetectionState('daemonMismatch');
                return;
            }
            const parsed = DaemonPetDiscoverResponseV1Schema.parse(raw);
            if (parsed.ok) {
                const visiblePets = parsed.pets.filter((pet) => (
                    !isManagedLocalPet(pet)
                    || !forgottenLocalPetSourceKeysRef.current.has(pet.sourceKey)
                ));
                setDiscoveredPets(visiblePets);
                setDiscoveredPetsTargetKey(targetKey);
                storage.getState().upsertLocalPetSources(normalizeLocalPetSourceMetadata(visiblePets, {
                    serverId: target.serverId,
                    machineId: target.machine.id,
                }));
                setCodexDetectionTargetKey(targetKey);
                setCodexDetectionState(visiblePets.some(isDetectedPet) ? 'success' : 'empty');
            } else {
                setDiscoveredPets([]);
                setDiscoveredPetsTargetKey(targetKey);
                setCodexDetectionTargetKey(targetKey);
                setCodexDetectionState('error');
            }
        } catch (error) {
            if (!isExecutionTargetCurrent(target)) return;
            setDiscoveredPets([]);
            setDiscoveredPetsTargetKey(targetKey);
            setCodexDetectionTargetKey(targetKey);
            setCodexDetectionState(isRpcMethodNotAvailableError(error) ? 'daemonMismatch' : 'error');
        }
    }, [administrationTargetSelection.resolveExecutionTarget, codexDetectionState, codexDetectionTargetKey, isExecutionTargetCurrent]);

    React.useEffect(() => {
        const refreshIfRequested = () => {
            if (!consumePendingCodexPetRefresh()) return;
            void discoverPets();
        };
        refreshIfRequested();
        return subscribeCodexPetRefresh(refreshIfRequested);
    }, [discoverPets]);

    const importLocalPet = React.useCallback(async (candidate: PetImportCandidate) => {
        const target = administrationTargetSelection.resolveExecutionTarget();
        if (!target) return;
        const targetKey = machineAdministrationExecutionTargetKey(target);
        const payload = buildImportPayload(candidate);
        if (!payload) return;
        setLocalImportDiagnosticTargetKey(targetKey);
        setLocalImportDiagnostic(null);
        try {
            const raw = await machineRpcWithServerScope<unknown, DaemonPetImportLocalPackageRequestV1>({
                machineId: target.machine.id,
                serverId: target.serverId,
                method: PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE,
                payload,
            });
            if (!isExecutionTargetCurrent(target)) return;
            const parsed = DaemonPetImportLocalPackageResponseV1Schema.parse(raw);
            if ('ok' in parsed && parsed.ok === false) {
                setLocalImportDiagnosticTargetKey(targetKey);
                setLocalImportDiagnostic({
                    code: typeof parsed.errorCode === 'string' ? parsed.errorCode : 'daemon_import_failed',
                });
                return;
            }
            const importedPetResult = ImportedLocalPetPackageV1Schema.safeParse(parsed.importedPet);
            if (!importedPetResult.success || importedPetResult.data.source.kind !== 'happierManagedLocal') {
                setLocalImportDiagnostic({ code: 'invalid_response' });
                return;
            }
            const importedPet = importedPetResult.data;
            forgottenLocalPetSourceKeysRef.current.delete(importedPet.sourceKey);
            setImportedLocalPets((pets) => upsertByKey(pets, importedPet, (pet) => pet.sourceKey));
            setImportedLocalPetsTargetKey(targetKey);
            storage.getState().upsertLocalPetSources(normalizeLocalPetSourceMetadata([importedPet], {
                serverId: target.serverId,
                machineId: target.machine.id,
            }));
            applyLocalSettings({
                petsSelectedPetOverride: {
                    kind: 'happierManagedLocal',
                    sourceKey: importedPet.sourceKey,
                },
            });
        } catch {
            if (!isExecutionTargetCurrent(target)) return;
            setLocalImportDiagnosticTargetKey(targetKey);
            setLocalImportDiagnostic({ code: 'daemon_import_failed' });
        }
    }, [administrationTargetSelection.resolveExecutionTarget, applyLocalSettings, isExecutionTargetCurrent]);

    const importAccountPet = React.useCallback(async (candidate: PetImportCandidate) => {
        if (!syncEnabled) return;
        const target = administrationTargetSelection.resolveExecutionTarget();
        if (!target) return;
        const importPayload = buildImportPayload(candidate);
        if (!importPayload) return;
        try {
            const payload: DaemonPetImportAccountPackageRequestV1 = {
                ...importPayload,
                petsSyncEnabled: true,
            };
            const raw = await machineRpcWithServerScope<unknown, DaemonPetImportAccountPackageRequestV1>({
                machineId: target.machine.id,
                serverId: target.serverId,
                method: PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE,
                payload,
            });
            if (!isExecutionTargetCurrent(target)) return;
            const parsed = DaemonPetImportResponseV1Schema.parse(raw);
            if (!parsed.ok || parsed.target !== 'account' || !parsed.account.ok) return;
            const pet = parsed.account.pet;
            storage.getState().upsertAccountPet(pet);
            setImportedAccountPets((pets) => upsertByKey(pets, pet, (entry) => entry.accountPetId));
            applySettings({
                petsSelectedPetRef: { kind: 'accountPet', accountPetId: pet.accountPetId },
            });
            if (localSettings.petsSelectedPetOverride.kind !== 'inherit') {
                applyLocalSettings({ petsSelectedPetOverride: { kind: 'inherit' } });
            }
        } catch {
            if (!isExecutionTargetCurrent(target)) return;
        }
    }, [administrationTargetSelection.resolveExecutionTarget, applyLocalSettings, applySettings, isExecutionTargetCurrent, localSettings.petsSelectedPetOverride.kind, syncEnabled]);

    const removeLocalPet = React.useCallback(async (pet: LocalDevicePetRow) => {
        if (removingLocalPetSourceKeysRef.current.has(pet.sourceKey)) return;
        removingLocalPetSourceKeysRef.current.add(pet.sourceKey);
        try {
            // The persisted local-source record owns cleanup routing. Administration
            // selection only authorizes new discovery/import work, never relocation.
            const payload: DaemonPetForgetLocalPackageRequestV1 = { sourceKey: pet.sourceKey };
            const raw = await machineRpcWithServerScope<unknown, DaemonPetForgetLocalPackageRequestV1>({
                machineId: pet.previewAsset.target.machineId,
                serverId: pet.previewAsset.target.serverId,
                method: PET_DAEMON_RPC_METHODS.FORGET_LOCAL_PACKAGE,
                payload,
            });
            DaemonPetForgetLocalPackageResponseV1Schema.safeParse(raw);
        } catch {
            // Removal from the device list is local user intent; daemon cleanup is best effort.
        } finally {
            removingLocalPetSourceKeysRef.current.delete(pet.sourceKey);
        }

        forgottenLocalPetSourceKeysRef.current.add(pet.sourceKey);
        storage.getState().removeLocalPetSource(pet.sourceKey);
        setImportedLocalPets((pets) => pets.filter((candidate) => candidate.sourceKey !== pet.sourceKey));
        setDiscoveredPets((pets) => pets.filter((candidate) => candidate.sourceKey !== pet.sourceKey));
        if (
            localSettings.petsSelectedPetOverride.kind === 'happierManagedLocal'
            && localSettings.petsSelectedPetOverride.sourceKey === pet.sourceKey
        ) {
            applyLocalSettings({ petsSelectedPetOverride: { kind: 'inherit' } });
        }
    }, [applyLocalSettings, localSettings.petsSelectedPetOverride]);

    const handleSelectBuiltInPet = React.useCallback((petId: string) => {
        applySettings({ petsSelectedPetRef: { kind: 'builtIn', petId } });
        if (localSettings.petsSelectedPetOverride.kind !== 'inherit') {
            applyLocalSettings({ petsSelectedPetOverride: { kind: 'inherit' } });
        }
    }, [applyLocalSettings, applySettings, localSettings.petsSelectedPetOverride.kind]);

    const handleSelectAccountPet = React.useCallback((accountPetId: string) => {
        applySettings({
            petsSelectedPetRef: {
                kind: 'accountPet',
                accountPetId,
            },
        });
        if (localSettings.petsSelectedPetOverride.kind !== 'inherit') {
            applyLocalSettings({ petsSelectedPetOverride: { kind: 'inherit' } });
        }
    }, [applyLocalSettings, applySettings, localSettings.petsSelectedPetOverride.kind]);

    const handleResetDesktopOverlayPosition = React.useCallback(() => {
        applyLocalSettings({
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0,
            desktopOverlayOffsetY: 0,
        });
        fireAndForget(resetDesktopActivityOverlayPosition(), {
            tag: 'PetsSettingsScreen.resetDesktopActivityOverlayPosition',
        });
    }, [applyLocalSettings]);

    const selectedBuiltInPetId =
        localSettings.petsSelectedPetOverride.kind === 'inherit'
        && settings.petsSelectedPetRef.kind === 'builtIn'
            ? settings.petsSelectedPetRef.petId
            : null;

    const { detectedPetTileRows, localSelectorRows } = usePetSourceActionRows({
        applyLocalSettings,
        detectedPetRows,
        importAccountPet,
        importLocalPet,
        localPetRows,
        petsSelectedPetOverride: localSettings.petsSelectedPetOverride,
        removeLocalPet,
        syncEnabled,
        targetMachineId,
        targetServerId,
    });

    if (!companionEnabled) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup>
                    <Item
                        title={t('settingsPets.disabledTitle')}
                        subtitle={t('settingsPets.disabledSubtitle')}
                        icon={<Icon name="paw-print" size={24} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <MachineAdministrationTargetSelector
                selection={administrationTargetSelection}
                testIDPrefix="pets-settings-target"
            />
            <PetsAccountSettingsSection
                companionSizeScale={companionSizeScale}
                deviceOverrideOpen={deviceOverrideOpen}
                onDeviceOverrideOpenChange={setDeviceOverrideOpen}
                onCompanionSizeScaleChange={(value) => applyLocalSettings({ petsCompanionSizeScale: value })}
                onPetsEnabledChange={(value) => applySettings({ petsEnabled: value })}
                onPetsEnabledOverrideChange={(override) => applyLocalSettings({ petsEnabledOverride: override })}
                overrideItems={overrideItems}
                petsEnabled={settings.petsEnabled}
                petsEnabledOverride={localSettings.petsEnabledOverride}
            />

            <PetsLocalLibrarySection
                builtInPetRows={builtInPetRows}
                codexDetectionState={scopedCodexDetectionState}
                companionSizeScale={companionSizeScale}
                detectedPetRowsCount={detectedPetRows.length}
                detectedPetTileRows={detectedPetTileRows}
                localPetRows={localSelectorRows}
                onDiscoverPets={discoverPets}
                onSelectBuiltInPet={handleSelectBuiltInPet}
                importDiagnostic={scopedLocalImportDiagnostic}
                selectedBuiltInPetId={selectedBuiltInPetId}
            />

            {syncEnabled ? (
                <PetsAccountLibrarySection
                    accountPets={accountPets}
                    companionSizeScale={companionSizeScale}
                    onSelectAccountPet={handleSelectAccountPet}
                    selectedAccountPetId={
                        settings.petsSelectedPetRef.kind === 'accountPet'
                            ? settings.petsSelectedPetRef.accountPetId
                            : null
                    }
                />
            ) : null}

            {showDesktopOverlaySettings ? (
                <PetsDesktopOverlaySettingsSection
                    desktopOverlayDefaultEnabled={settings.petsDesktopOverlayDefaultEnabled}
                    desktopOverlayOverrideOpen={desktopOverlayOverrideOpen}
                    desktopOverlayVisibilityModeOpen={desktopOverlayVisibilityModeOpen}
                    desktopPetOverlayEnabledOverride={localSettings.desktopPetOverlayEnabledOverride}
                    desktopPetOverlayVisibilityModeOverride={localSettings.desktopPetOverlayVisibilityModeOverride}
                    onDefaultEnabledChange={(value) => applySettings({ petsDesktopOverlayDefaultEnabled: value })}
                    onDesktopOverlayOverrideChange={(override) => applyLocalSettings({ desktopPetOverlayEnabledOverride: override })}
                    onDesktopOverlayOverrideOpenChange={setDesktopOverlayOverrideOpen}
                    onDesktopOverlayVisibilityModeOverrideChange={(override) => applyLocalSettings({ desktopPetOverlayVisibilityModeOverride: override })}
                    onDesktopOverlayVisibilityModeOpenChange={setDesktopOverlayVisibilityModeOpen}
                    onResetPosition={handleResetDesktopOverlayPosition}
                    overrideItems={overrideItems}
                    visibilityModeItems={visibilityModeItems}
                />
            ) : null}
        </ItemList>
    );
}

export default React.memo(PetsSettingsScreen);
