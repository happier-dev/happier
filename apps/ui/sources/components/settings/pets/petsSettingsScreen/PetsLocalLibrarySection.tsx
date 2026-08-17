import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { BuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { DevicePetSelector, type DetectedDevicePetSelectorItem, type LocalDevicePetSelectorItem } from '../DevicePetSelector';
import type { CodexDetectionState, LocalPetImportDiagnostic } from './types';
import { Icon } from '@/components/ui/icons/Icon';

type PetsLocalLibrarySectionProps = Readonly<{
    builtInPetRows: readonly BuiltInPetPackage[];
    codexDetectionState: CodexDetectionState;
    companionSizeScale: number;
    detectedPetRowsCount: number;
    detectedPetTileRows: readonly DetectedDevicePetSelectorItem[];
    localPetRows: readonly LocalDevicePetSelectorItem[];
    onDiscoverPets: () => void;
    onSelectBuiltInPet: (petId: string) => void;
    importDiagnostic: LocalPetImportDiagnostic | null;
    selectedBuiltInPetId: string | null;
}>;

export function PetsLocalLibrarySection(props: PetsLocalLibrarySectionProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <View testID="settings-pets-source-list">
            <View testID="settings-pets-local-library-list">
                <ItemGroup title={t('settingsPets.localLibraryTitle')} footer={t('settingsPets.localLibraryFooter')}>
                    <DevicePetSelector
                        builtInPets={props.builtInPetRows}
                        companionSizeScale={props.companionSizeScale}
                        selectedBuiltInPetId={props.selectedBuiltInPetId}
                        localPets={props.localPetRows}
                        onSelectBuiltInPet={props.onSelectBuiltInPet}
                    />
                </ItemGroup>
                <View testID="settings-pets-codex-library-list">
                    <View testID="settings-pets-codex-detect-group">
                        <ItemGroup>
                            <Item
                                testID="settings-pets-detect-codex-pets"
                                title={t('settingsPets.detectCodexPetsTitle')}
                                subtitle={t('settingsPets.detectCodexPetsSubtitle')}
                                icon={<Icon name="magnifying-glass" size={24} color={theme.colors.accent.blue} />}
                                detail={props.codexDetectionState === 'loading' ? t('common.scanning') : undefined}
                                loading={props.codexDetectionState === 'loading'}
                                onPress={props.onDiscoverPets}
                            />
                        </ItemGroup>
                    </View>
                    <PetsDetectedCodexState
                        codexDetectionState={props.codexDetectionState}
                        companionSizeScale={props.companionSizeScale}
                        detectedPetRowsCount={props.detectedPetRowsCount}
                        detectedPetTileRows={props.detectedPetTileRows}
                        importDiagnostic={props.importDiagnostic}
                    />
                </View>
            </View>
        </View>
    );
}

function PetsDetectedCodexState(props: Readonly<{
    codexDetectionState: CodexDetectionState;
    companionSizeScale: number;
    detectedPetRowsCount: number;
    detectedPetTileRows: readonly DetectedDevicePetSelectorItem[];
    importDiagnostic: LocalPetImportDiagnostic | null;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const { codexDetectionState } = props;

    if (props.detectedPetRowsCount > 0) {
        return (
            <View testID="settings-pets-detected-codex-pets-list">
                <ItemGroup>
                    <DevicePetSelector
                        builtInPets={[]}
                        companionSizeScale={props.companionSizeScale}
                        selectedBuiltInPetId={null}
                        localPets={[]}
                        detectedPets={props.detectedPetTileRows}
                        gridTestID="settings-pets-detected-codex-pets-grid"
                        contentsTestID="settings-pets-detected-codex-pets-card-grid"
                        onSelectBuiltInPet={() => undefined}
                    />
                </ItemGroup>
                {props.importDiagnostic ? (
                    <ItemGroup>
                        <Item
                            testID="settings-pets-import-local-daemon-error"
                            title={t('settingsPets.importToDeviceDaemonErrorTitle')}
                            subtitle={t('settingsPets.importToDeviceDaemonErrorSubtitle', {
                                code: props.importDiagnostic.code,
                            })}
                            icon={<Icon name="warning" size={24} color={theme.colors.state.danger.foreground} />}
                            detail={props.importDiagnostic.code}
                            mode="info"
                        />
                    </ItemGroup>
                ) : null}
            </View>
        );
    }

    if (codexDetectionState === 'empty') {
        return (
            <View testID="settings-pets-detected-codex-pets-empty">
                <ItemGroup>
                    <Item
                        title={t('settingsPets.detectedCodexPetsEmptyTitle')}
                        subtitle={t('settingsPets.detectedCodexPetsEmptySubtitle')}
                        icon={<Icon name="tray" size={24} color={theme.colors.text.secondary} />}
                        mode="info"
                    />
                </ItemGroup>
            </View>
        );
    }

    if (codexDetectionState === 'noTarget') {
        return (
            <View testID="settings-pets-detected-codex-pets-no-target">
                <ItemGroup>
                    <Item
                        title={t('settingsPets.detectedCodexPetsNoTargetTitle')}
                        subtitle={t('settingsPets.detectedCodexPetsNoTargetSubtitle')}
                        icon={<Icon name="cloud-slash" size={24} color={theme.colors.state.danger.foreground} />}
                        mode="info"
                    />
                </ItemGroup>
            </View>
        );
    }

    if (codexDetectionState === 'error') {
        return (
            <View testID="settings-pets-detected-codex-pets-error">
                <ItemGroup>
                    <Item
                        title={t('settingsPets.detectedCodexPetsErrorTitle')}
                        subtitle={t('settingsPets.detectedCodexPetsErrorSubtitle')}
                        icon={<Icon name="warning" size={24} color={theme.colors.state.danger.foreground} />}
                        mode="info"
                    />
                </ItemGroup>
            </View>
        );
    }

    if (codexDetectionState === 'daemonMismatch') {
        return (
            <View testID="settings-pets-detected-codex-pets-daemon-mismatch">
                <ItemGroup>
                    <Item
                        title={t('settingsPets.detectedCodexPetsDaemonMismatchTitle')}
                        subtitle={t('settingsPets.detectedCodexPetsDaemonMismatchSubtitle')}
                        icon={<Icon name="arrow-clockwise" size={24} color={theme.colors.state.danger.foreground} />}
                        mode="info"
                    />
                </ItemGroup>
            </View>
        );
    }

    return null;
}
