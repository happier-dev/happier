import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { MachineSetupTextField } from '@/components/settings/machines/shared/MachineSetupTextField';
import type { SshCredentialsDraft } from '@/components/settings/machines/shared/SshCredentialsFields';
import { WizardSshCredentialsFields } from '@/components/onboardingWizard/ssh/WizardSshCredentialsFields';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';

import type { RemoteSshChecklistCopy } from './remoteSshChecklistCopy';
import { remoteSshChecklistStyles } from './remoteSshChecklistStyles';

export type RemoteSshChecklistCredentialsPhaseProps = Readonly<{
    testID?: string;
    copy: RemoteSshChecklistCopy;

    remoteHostsCount: number;
    hostPickerOpen: boolean;
    onChangeHostPickerOpen: (open: boolean) => void;
    hostPickerItems: readonly DropdownMenuItem[];
    selectedHostPickerId: string;
    onSelectHostPickerId: (itemId: string) => void;
    usingSavedHost: boolean;

    draft: SshCredentialsDraft;
    onChangeDraft: (next: SshCredentialsDraft) => void;

    remoteHostsManagementEnabled: boolean;
    remoteHostsSecretMaterialEnabled: boolean;
    saveHost: boolean;
    onToggleSaveHost: () => void;
    saveSecretMaterial: boolean;
    onToggleSaveSecretMaterial: () => void;
    privateKeyMaterialDraft: string;
    onChangePrivateKeyMaterialDraft: (next: string) => void;
}>;

export const RemoteSshChecklistCredentialsPhase = React.memo(function RemoteSshChecklistCredentialsPhase(
    props: RemoteSshChecklistCredentialsPhaseProps,
) {
    const { theme } = useUnistyles();
    const styles = remoteSshChecklistStyles;

    const renderToggleRow = React.useCallback((params: Readonly<{
        testID: string;
        selected: boolean;
        title: string;
        subtitle: string;
        icon: React.ComponentProps<typeof Ionicons>['name'];
        onPress: () => void;
    }>) => (
        <SelectableRow
            testID={params.testID}
            variant="selectable"
            selected={params.selected}
            onPress={params.onPress}
            left={(
                <Ionicons
                    name={params.icon}
                    size={18}
                    color={params.selected ? theme.colors.accent.blue : theme.colors.textSecondary}
                />
            )}
            title={params.title}
            subtitle={params.subtitle}
            right={(
                <Ionicons
                    name={params.selected ? 'checkmark-circle' : 'ellipse-outline'}
                    size={18}
                    color={params.selected ? theme.colors.accent.blue : theme.colors.textSecondary}
                />
            )}
        />
    ), [theme.colors.accent.blue, theme.colors.textSecondary]);

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.heading}>
                <Text style={styles.title}>{props.copy.credentialsTitle}</Text>
                <Text style={styles.subtitle}>{props.copy.credentialsSubtitle}</Text>
            </View>

            {props.remoteHostsCount > 0 ? (
                <View style={styles.sectionBlock}>
                    <DropdownMenu
                        open={props.hostPickerOpen}
                        onOpenChange={props.onChangeHostPickerOpen}
                        items={props.hostPickerItems}
                        selectedId={props.selectedHostPickerId}
                        onSelect={props.onSelectHostPickerId}
                        placement="bottom"
                        matchTriggerWidth={true}
                        variant="slim"
                        trigger={({ toggle, selectedItem }) => (
                            <SelectableRow
                                testID={props.testID ? `${props.testID}-remote-host-picker` : 'remote-ssh-checklist-remote-host-picker'}
                                variant="selectable"
                                selected={props.hostPickerOpen}
                                onPress={toggle}
                                left={<Ionicons name="server-outline" size={18} color={theme.colors.textSecondary} />}
                                title={selectedItem?.title ?? t('setupOnboarding.remoteHosts.hostPickerTitle')}
                                subtitle={selectedItem?.subtitle ?? t('setupOnboarding.remoteHosts.hostPickerSubtitle')}
                                right={<Ionicons name="chevron-down" size={18} color={theme.colors.textSecondary} />}
                            />
                        )}
                    />
                </View>
            ) : null}

            {props.usingSavedHost ? null : (
                <>
                    <WizardSshCredentialsFields
                        testIDPrefix={props.testID ? `${props.testID}-ssh` : 'remote-ssh-checklist-ssh'}
                        testIdStyle="wizard"
                        value={props.draft}
                        onChange={props.onChangeDraft}
                    />
                    {props.remoteHostsManagementEnabled ? (
                        <View style={styles.toggleList}>
                            {renderToggleRow({
                                testID: props.testID ? `${props.testID}-save-host` : 'remote-ssh-checklist-save-host',
                                selected: props.saveHost,
                                title: t('setupOnboarding.remoteHosts.saveHostTitle'),
                                subtitle: t('setupOnboarding.remoteHosts.saveHostSubtitle'),
                                icon: 'bookmark-outline',
                                onPress: props.onToggleSaveHost,
                            })}

                            {props.saveHost && props.remoteHostsSecretMaterialEnabled && props.draft.authMode === 'password'
                                ? renderToggleRow({
                                    testID: props.testID ? `${props.testID}-save-password` : 'remote-ssh-checklist-save-password',
                                    selected: props.saveSecretMaterial,
                                    title: t('setupOnboarding.remoteHosts.savePasswordTitle'),
                                    subtitle: t('setupOnboarding.remoteHosts.savePasswordSubtitle'),
                                    icon: 'key-outline',
                                    onPress: props.onToggleSaveSecretMaterial,
                                })
                                : null}

                            {props.saveHost && props.remoteHostsSecretMaterialEnabled && props.draft.authMode === 'keyfile'
                                ? (
                                    <>
                                        {renderToggleRow({
                                            testID: props.testID ? `${props.testID}-save-private-key` : 'remote-ssh-checklist-save-private-key',
                                            selected: props.saveSecretMaterial,
                                            title: t('setupOnboarding.remoteHosts.savePrivateKeyTitle'),
                                            subtitle: t('setupOnboarding.remoteHosts.savePrivateKeySubtitle'),
                                            icon: 'key-outline',
                                            onPress: props.onToggleSaveSecretMaterial,
                                        })}
                                        {props.saveSecretMaterial ? (
                                            <View style={styles.sectionBlock}>
                                                <MachineSetupTextField
                                                    testID={props.testID ? `${props.testID}-private-key` : 'remote-ssh-checklist-private-key'}
                                                    label={t('setupOnboarding.remoteHosts.privateKeyLabel')}
                                                    value={props.privateKeyMaterialDraft}
                                                    multiline
                                                    autoCapitalize="none"
                                                    autoCorrect={false}
                                                    onChangeText={props.onChangePrivateKeyMaterialDraft}
                                                />
                                            </View>
                                        ) : null}
                                    </>
                                )
                                : null}
                        </View>
                    ) : null}
                </>
            )}
        </View>
    );
});
