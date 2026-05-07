import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
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
import { resetDesktopPetOverlayPosition } from '@/components/pets/desktop/bridge/desktopPetOverlayBridge';
import {
    BUILT_IN_PET_IDS,
    resolveBuiltInPetPackage,
} from '@/components/pets/builtIns/builtInPetRegistry';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { createLocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceMetadata';
import { storage, useAllMachines, useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { isTauriDesktop } from '@/utils/platform/tauri';
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
    localPetMetadataToRow,
    localPetSourceMatchesDaemonTarget,
    upsertByKey,
} from './petsSettingsScreen/helpers';
import { usePetSourceActionRows } from './petsSettingsScreen/usePetSourceActionRows';
import {
    consumePendingCodexPetRefresh,
    subscribeCodexPetRefresh,
} from './petSettingsCommandEvents';
import type {
    CodexDetectionState,
    DetectedPet,
    LocalPetImportDiagnostic,
    LocalPetRemovalDiagnostic,
    LocalDevicePetRow,
} from './petsSettingsScreen/types';

export function PetsSettingsScreen() {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const machines = useAllMachines();
    const activeServerSnapshot = useActiveServerSnapshot();
    const accountPetsById = storage((state) => state.accountPetsById);
    const localPetSourcesBySourceKey = storage((state) => state.localPetSourcesBySourceKey);
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const companionDecision = useFeatureDecision('pets.companion');
    const companionEnabled = companionDecision?.state === 'enabled';
    const companionDisabledByServer = companionDecision?.state === 'disabled'
        && companionDecision.blockedBy === 'server';
    const syncEnabled = useFeatureEnabled('pets.sync');
    const [deviceOverrideOpen, setDeviceOverrideOpen] = React.useState(false);
    const [desktopOverlayOverrideOpen, setDesktopOverlayOverrideOpen] = React.useState(false);
    const [desktopOverlayVisibilityModeOpen, setDesktopOverlayVisibilityModeOpen] = React.useState(false);
    const [codexDetectionState, setCodexDetectionState] = React.useState<CodexDetectionState>('idle');
    const [discoveredPets, setDiscoveredPets] = React.useState<DiscoveredPetPackageV1[]>([]);
    const [importedLocalPets, setImportedLocalPets] = React.useState<ImportedLocalPetPackageV1[]>([]);
    const [importedAccountPets, setImportedAccountPets] = React.useState<AccountPetLibraryEntryV1[]>([]);
    const [localImportDiagnostic, setLocalImportDiagnostic] = React.useState<LocalPetImportDiagnostic | null>(null);
    const [localRemovalDiagnostic, setLocalRemovalDiagnostic] = React.useState<LocalPetRemovalDiagnostic | null>(null);
    const importingLocalPetKeysRef = React.useRef(new Set<string>());
    const importingAccountPetKeysRef = React.useRef(new Set<string>());
    const removingLocalPetSourceKeysRef = React.useRef(new Set<string>());
    const showDesktopOverlaySettings = isTauriDesktop();

    const targetMachineId = machines.find((machine) => machine.active)?.id ?? machines[0]?.id ?? '';
    const targetServerId = String(activeServerSnapshot.serverId ?? '').trim();
    const daemonTarget = React.useMemo(
        () => targetMachineId && targetServerId
            ? { machineId: targetMachineId, serverId: targetServerId }
            : null,
        [targetMachineId, targetServerId],
    );

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
            if (!localPetSourceMatchesDaemonTarget(source, daemonTarget)) continue;
            const row = localPetMetadataToRow(source);
            if (row) rows.set(row.sourceKey, row);
        }
        for (const pet of discoveredPets) {
            if (!isManagedLocalPet(pet) || !daemonTarget) continue;
            const row = localPetMetadataToRow(createLocalPetSourceMetadata(pet, daemonTarget) ?? {
                kind: 'happierManagedLocal',
                sourceKey: pet.sourceKey,
                petId: pet.petId,
                displayName: pet.displayName,
                daemonTarget,
            });
            if (row) rows.set(row.sourceKey, row);
        }
        for (const pet of importedLocalPets) {
            if (!isManagedLocalPet(pet) || !daemonTarget) continue;
            const row = localPetMetadataToRow(createLocalPetSourceMetadata(pet, daemonTarget) ?? {
                kind: 'happierManagedLocal',
                sourceKey: pet.sourceKey,
                petId: pet.petId,
                displayName: pet.displayName,
                daemonTarget,
            });
            if (row) rows.set(row.sourceKey, row);
        }
        return Array.from(rows.values());
    }, [daemonTarget, discoveredPets, importedLocalPets, localPetSourcesBySourceKey]);

    const detectedPetRows = React.useMemo(
        () => discoveredPets.filter(isDetectedPet),
        [discoveredPets],
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
        if (codexDetectionState === 'loading') return;
        if (!targetMachineId || !targetServerId) {
            setCodexDetectionState('noTarget');
            return;
        }
        setCodexDetectionState('loading');
        try {
            const payload: DaemonPetDiscoverRequestV1 = {
                includeDetectedCodexHomes: true,
                includeUserCodexHome: true,
                includeConnectedServiceCodexHomes: true,
                includeManagedLocal: true,
            };
            const raw = await machineRpcWithServerScope<unknown, DaemonPetDiscoverRequestV1>({
                machineId: targetMachineId,
                serverId: targetServerId,
                method: PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES,
                payload,
            });
            if (isRpcMethodNotAvailableError(raw)) {
                setDiscoveredPets([]);
                setCodexDetectionState('daemonMismatch');
                return;
            }
            const parsed = DaemonPetDiscoverResponseV1Schema.parse(raw);
            if (parsed.ok) {
                const daemonTarget = { machineId: targetMachineId, serverId: targetServerId };
                for (const pet of parsed.pets) {
                    const metadata = createLocalPetSourceMetadata(pet, daemonTarget);
                    if (metadata) storage.getState().upsertLocalPetSource(metadata);
                }
                setDiscoveredPets(parsed.pets);
                setCodexDetectionState(parsed.pets.some(isDetectedPet) ? 'success' : 'empty');
            } else {
                setDiscoveredPets([]);
                setCodexDetectionState('error');
            }
        } catch (error) {
            setDiscoveredPets([]);
            setCodexDetectionState(isRpcMethodNotAvailableError(error) ? 'daemonMismatch' : 'error');
        }
    }, [codexDetectionState, targetMachineId, targetServerId]);

    React.useEffect(() => {
        const runPendingRefresh = () => {
            if (!consumePendingCodexPetRefresh()) return;
            void discoverPets();
        };
        runPendingRefresh();
        return subscribeCodexPetRefresh(runPendingRefresh);
    }, [discoverPets]);

    const importLocalPet = React.useCallback(async (candidate: DiscoveredPetPackageV1) => {
        if (!targetMachineId || !targetServerId) return;
        const payload = buildImportPayload(candidate);
        if (!payload) return;
        const importKey = payload.sourceKey;
        if (importingLocalPetKeysRef.current.has(importKey)) return;
        importingLocalPetKeysRef.current.add(importKey);
        setLocalImportDiagnostic(null);
        try {
            const raw = await machineRpcWithServerScope<unknown, DaemonPetImportLocalPackageRequestV1>({
                machineId: targetMachineId,
                serverId: targetServerId,
                method: PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE,
                payload,
            });
            const parsed = DaemonPetImportLocalPackageResponseV1Schema.parse(raw);
            if ('ok' in parsed && parsed.ok === false) {
                setLocalImportDiagnostic({
                    code: typeof parsed.errorCode === 'string' ? parsed.errorCode : 'daemon_import_failed',
                });
                return;
            }
            const importedPetResult = ImportedLocalPetPackageV1Schema.safeParse(parsed.importedPet);
            if (!importedPetResult.success || importedPetResult.data.kind !== 'happierManagedLocal') {
                setLocalImportDiagnostic({ code: 'invalid_response' });
                return;
            }
            const importedPet = importedPetResult.data;
            const metadata = createLocalPetSourceMetadata(importedPet, {
                machineId: targetMachineId,
                serverId: targetServerId,
            });
            if (metadata) storage.getState().upsertLocalPetSource(metadata);
            setImportedLocalPets((pets) => upsertByKey(pets, importedPet, (pet) => pet.sourceKey));
            applyLocalSettings({
                petsSelectedPetOverride: {
                    kind: 'happierManagedLocal',
                    sourceKey: importedPet.sourceKey,
                },
            });
        } catch {
            setLocalImportDiagnostic({ code: 'daemon_import_failed' });
            setImportedLocalPets((pets) => pets);
        } finally {
            importingLocalPetKeysRef.current.delete(importKey);
        }
    }, [applyLocalSettings, targetMachineId, targetServerId]);

    const importAccountPet = React.useCallback(async (candidate: DiscoveredPetPackageV1) => {
        if (!syncEnabled || !targetMachineId || !targetServerId) return;
        const importPayload = buildImportPayload(candidate);
        if (!importPayload) return;
        const importKey = importPayload.sourceKey;
        if (importingAccountPetKeysRef.current.has(importKey)) return;
        importingAccountPetKeysRef.current.add(importKey);
        try {
            const payload: DaemonPetImportAccountPackageRequestV1 = {
                ...importPayload,
                petsSyncEnabled: true,
            };
            const raw = await machineRpcWithServerScope<unknown, DaemonPetImportAccountPackageRequestV1>({
                machineId: targetMachineId,
                serverId: targetServerId,
                method: PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE,
                payload,
            });
            const parsed = DaemonPetImportResponseV1Schema.parse(raw);
            if (!parsed.ok || parsed.target !== 'account' || !parsed.account.ok) return;
            const pet = parsed.account.pet;
            storage.getState().upsertAccountPet(pet);
            setImportedAccountPets((pets) => upsertByKey(pets, pet, (entry) => entry.accountPetId));
            applySettings({
                petsSelectedPetRef: { kind: 'accountPet', accountPetId: pet.accountPetId },
            });
        } catch {
            setImportedAccountPets((pets) => pets);
        } finally {
            importingAccountPetKeysRef.current.delete(importKey);
        }
    }, [applySettings, syncEnabled, targetMachineId, targetServerId]);

    const removeLocalPet = React.useCallback(async (pet: LocalDevicePetRow) => {
        if (removingLocalPetSourceKeysRef.current.has(pet.sourceKey)) return;
        removingLocalPetSourceKeysRef.current.add(pet.sourceKey);
        setLocalRemovalDiagnostic(null);
        try {
            if (targetMachineId && targetServerId) {
                const payload: DaemonPetForgetLocalPackageRequestV1 = { sourceKey: pet.sourceKey };
                const raw = await machineRpcWithServerScope<unknown, DaemonPetForgetLocalPackageRequestV1>({
                    machineId: targetMachineId,
                    serverId: targetServerId,
                    method: PET_DAEMON_RPC_METHODS.FORGET_LOCAL_PACKAGE,
                    payload,
                });
                const parsed = DaemonPetForgetLocalPackageResponseV1Schema.safeParse(raw);
                if (!parsed.success || ('ok' in parsed.data && parsed.data.ok === false)) {
                    setLocalRemovalDiagnostic({ code: 'daemon_forget_failed' });
                }
            } else {
                setLocalRemovalDiagnostic({ code: 'daemon_unavailable' });
            }
        } catch {
            setLocalRemovalDiagnostic({ code: 'daemon_forget_failed' });
        } finally {
            removingLocalPetSourceKeysRef.current.delete(pet.sourceKey);
        }

        storage.getState().removeLocalPetSource(pet.sourceKey);
        setImportedLocalPets((pets) => pets.filter((candidate) => candidate.sourceKey !== pet.sourceKey));
        setDiscoveredPets((pets) => pets.filter((candidate) => candidate.sourceKey !== pet.sourceKey));
        if (
            localSettings.petsSelectedPetOverride.kind === 'happierManagedLocal'
            && localSettings.petsSelectedPetOverride.sourceKey === pet.sourceKey
        ) {
            applyLocalSettings({ petsSelectedPetOverride: { kind: 'inherit' } });
        }
    }, [applyLocalSettings, localSettings.petsSelectedPetOverride, targetMachineId, targetServerId]);

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

    const handleResetDesktopPetOverlayPosition = React.useCallback(() => {
        applyLocalSettings({
            desktopPetOverlayOffset: { x: 0, y: 0 },
            desktopPetOverlayAnchor: 'bottomRight',
        });
        fireAndForget(resetDesktopPetOverlayPosition(), {
            tag: 'PetsSettingsScreen.resetDesktopPetOverlayPosition',
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
                        testID="settings-pets-disabled"
                        title={t(companionDisabledByServer
                            ? 'settingsPets.disabledByServerTitle'
                            : 'settingsPets.disabledTitle')}
                        subtitle={t(companionDisabledByServer
                            ? 'settingsPets.disabledByServerSubtitle'
                            : 'settingsPets.disabledSubtitle')}
                        icon={<Ionicons name="paw-outline" size={25} color={theme.colors.textSecondary} />}
                        mode="info"
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <PetsAccountSettingsSection
                companionSizeScale={localSettings.petsCompanionSizeScale}
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
                codexDetectionState={codexDetectionState}
                companionSizeScale={localSettings.petsCompanionSizeScale}
                detectedPetRowsCount={detectedPetRows.length}
                detectedPetTileRows={detectedPetTileRows}
                localPetRows={localSelectorRows}
                onDiscoverPets={discoverPets}
                onSelectBuiltInPet={handleSelectBuiltInPet}
                importDiagnostic={localImportDiagnostic}
                removalDiagnostic={localRemovalDiagnostic}
                selectedBuiltInPetId={selectedBuiltInPetId}
            />

            {syncEnabled ? (
                <PetsAccountLibrarySection
                    accountPets={accountPets}
                    companionSizeScale={localSettings.petsCompanionSizeScale}
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
                    onResetPosition={handleResetDesktopPetOverlayPosition}
                    overrideItems={overrideItems}
                    visibilityModeItems={visibilityModeItems}
                />
            ) : null}
        </ItemList>
    );
}

export default React.memo(PetsSettingsScreen);
