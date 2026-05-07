import * as React from 'react';
import { View } from 'react-native';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { DevicePetSelector, type AccountDevicePetSelectorItem } from '../DevicePetSelector';
import { sanitizeTestIdPart, sourceRowTestId } from './helpers';

type PetsAccountLibrarySectionProps = Readonly<{
    accountPets: readonly AccountPetLibraryEntryV1[];
    companionSizeScale: number;
    onSelectAccountPet: (accountPetId: string) => void;
    selectedAccountPetId: string | null;
}>;

export function PetsAccountLibrarySection(props: PetsAccountLibrarySectionProps): React.ReactElement {
    const accountPetRows = React.useMemo((): AccountDevicePetSelectorItem[] => (
        props.accountPets.map((pet) => ({
            accountPetId: pet.accountPetId,
            petId: pet.manifest.id,
            displayName: pet.manifest.displayName,
            selected: props.selectedAccountPetId === pet.accountPetId,
            source: {
                kind: 'accountPet' as const,
                accountPetId: pet.accountPetId,
                sourceKey: pet.accountPetId,
                mediaType: pet.spritesheetAssetRef.mediaType,
                digest: pet.spritesheetAssetRef.digest,
            },
            sourceTestID: sourceRowTestId('account', pet.accountPetId),
            previewTestID: `settings-pets-account-preview-${sanitizeTestIdPart(pet.accountPetId)}`,
            actions: null,
            onPress: () => props.onSelectAccountPet(pet.accountPetId),
        }))
    ), [props]);

    return (
        <View testID="settings-pets-account-library-list">
            <ItemGroup title={t('settingsPets.accountLibraryTitle')} footer={t('settingsPets.accountLibraryFooter')}>
                <DevicePetSelector
                    builtInPets={[]}
                    companionSizeScale={props.companionSizeScale}
                    selectedBuiltInPetId={null}
                    localPets={[]}
                    accountPets={accountPetRows}
                    gridTestID="settings-pets-account-pet-grid"
                    contentsTestID="settings-pets-account-pet-card-grid"
                    onSelectBuiltInPet={() => undefined}
                />
            </ItemGroup>
        </View>
    );
}
