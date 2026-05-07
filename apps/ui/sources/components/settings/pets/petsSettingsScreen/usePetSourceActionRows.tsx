import * as React from 'react';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

import type {
    DetectedDevicePetSelectorItem,
    LocalDevicePetSelectorItem,
} from '../DevicePetSelector';
import {
    IMPORT_TO_ACCOUNT_ACTION_ID,
    REMOVE_FROM_DEVICE_ACTION_ID,
    USE_ON_THIS_DEVICE_ACTION_ID,
    detectedRowTestId,
    importToAccountActionTestId,
    removeFromDeviceActionTestId,
    sanitizeTestIdPart,
    sourceRowTestId,
    useOnDeviceActionTestId,
} from './helpers';
import type {
    DetectedPet,
    LocalDevicePetRow,
    PetSelectedPetOverride,
} from './types';

type UsePetSourceActionRowsParams = Readonly<{
    applyLocalSettings: (patch: { petsSelectedPetOverride: PetSelectedPetOverride }) => void;
    detectedPetRows: readonly DetectedPet[];
    importAccountPet: (pet: DetectedPet) => void | Promise<void>;
    importLocalPet: (pet: DetectedPet) => void | Promise<void>;
    localPetRows: readonly LocalDevicePetRow[];
    petsSelectedPetOverride: PetSelectedPetOverride;
    removeLocalPet: (pet: LocalDevicePetRow) => void | Promise<void>;
    syncEnabled: boolean;
    targetMachineId: string;
    targetServerId: string;
}>;

export function usePetSourceActionRows(params: UsePetSourceActionRowsParams): Readonly<{
    detectedPetTileRows: DetectedDevicePetSelectorItem[];
    localSelectorRows: LocalDevicePetSelectorItem[];
}> {
    const renderLocalPetActions = React.useCallback((pet: LocalDevicePetRow) => (
        <ItemRowActions
            title={pet.displayName}
            actions={[
                {
                    id: REMOVE_FROM_DEVICE_ACTION_ID,
                    title: t('settingsPets.removeFromDeviceTitle'),
                    subtitle: t('settingsPets.removeFromDeviceSubtitle'),
                    icon: 'trash-outline',
                    inlineTestID: removeFromDeviceActionTestId(pet.sourceKey),
                    destructive: true,
                    onPress: () => void params.removeLocalPet(pet),
                },
            ]}
            compactActionIds={[REMOVE_FROM_DEVICE_ACTION_ID]}
        />
    ), [params]);

    const buildDetectedPetActions = React.useCallback((pet: DetectedPet): ItemAction[] => {
        const actions: ItemAction[] = [
            {
                id: USE_ON_THIS_DEVICE_ACTION_ID,
                title: t('settingsPets.useOnThisDeviceTitle'),
                subtitle: t('settingsPets.useOnThisDeviceSubtitle'),
                icon: 'download-outline',
                inlineTestID: useOnDeviceActionTestId(pet.sourceKey),
                onPress: () => void params.importLocalPet(pet),
            },
        ];
        if (params.syncEnabled) {
            actions.push({
                id: IMPORT_TO_ACCOUNT_ACTION_ID,
                title: t('settingsPets.importToAccountTitle'),
                subtitle: t('settingsPets.importToAccountSubtitle'),
                icon: 'cloud-upload-outline',
                inlineTestID: importToAccountActionTestId(pet.sourceKey),
                onPress: () => void params.importAccountPet(pet),
            });
        }
        return actions;
    }, [params]);

    const renderDetectedPetActions = React.useCallback((pet: DetectedPet) => {
        const actions = buildDetectedPetActions(pet);
        return (
            <ItemRowActions
                title={pet.displayName}
                actions={actions}
                compactActionIds={actions.map((action) => action.id)}
            />
        );
    }, [buildDetectedPetActions]);

    const localSelectorRows = React.useMemo(() => params.localPetRows.map((pet) => ({
        ...pet,
        selected:
            params.petsSelectedPetOverride.kind === 'happierManagedLocal'
            && params.petsSelectedPetOverride.sourceKey === pet.sourceKey,
        sourceTestID: sourceRowTestId('local', pet.sourceKey),
        actions: renderLocalPetActions(pet),
        onPress: () => params.applyLocalSettings({
            petsSelectedPetOverride: {
                kind: 'happierManagedLocal',
                sourceKey: pet.sourceKey,
            },
        }),
    })), [params, renderLocalPetActions]);

    const detectedPetTileRows = React.useMemo(() => {
        const daemonTarget = params.targetMachineId && params.targetServerId
            ? { machineId: params.targetMachineId, serverId: params.targetServerId }
            : null;
        if (!daemonTarget) return [];
        return params.detectedPetRows.map((pet) => ({
            sourceKey: pet.sourceKey,
            petId: pet.petId,
            displayName: pet.displayName,
            source: {
                kind: 'detectedCodexHome' as const,
                sourceKey: pet.sourceKey,
                mediaType: pet.mediaType,
                digest: pet.digest,
                daemonTarget,
            },
            sourceTestID: detectedRowTestId(pet.sourceKey),
            previewTestID: `settings-pets-detected-preview-${sanitizeTestIdPart(pet.sourceKey)}`,
            actions: renderDetectedPetActions(pet),
        }));
    }, [params, renderDetectedPetActions]);

    return { detectedPetTileRows, localSelectorRows };
}
