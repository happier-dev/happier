import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SshAuthMode, SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { SshCredentialsFields } from '@/components/ssh/SshCredentialsFields';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Switch } from '@/components/ui/forms/Switch';
import { Typography } from '@/constants/Typography';

import type { RemoteSshChecklistCopy } from './copy';
import { remoteSshChecklistStyles } from './styles';
import { StepForm } from '@/components/onboarding/unauthShell/StepFormParts';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

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
    supportedAuthModes?: readonly SshAuthMode[];

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
        icon: IconName;
        onPress: () => void;
    }>) => (
        // One saved-or-not choice is a switch on its label's line (lab direction A "Save this host"); what saving
        // means stays the switch's hint.
        <View style={toggleStyles.row}>
            <Text style={[toggleStyles.label, { color: theme.colors.text.primary }]}>{params.title}</Text>
            <Switch
                testID={params.testID}
                accessibilityLabel={params.title}
                accessibilityHint={params.subtitle}
                value={params.selected}
                onValueChange={() => params.onPress()}
            />
        </View>
    ), [theme]);

    return (
        // The step's fields in its 420 px form column (lab direction A "New host"), groups 16 px apart.
        <StepForm testID={props.testID}>
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
                                left={<Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />}
                                title={selectedItem?.title ?? t('setupOnboarding.remoteHosts.hostPickerTitle')}
                                subtitle={selectedItem?.subtitle ?? t('setupOnboarding.remoteHosts.hostPickerSubtitle')}
                                right={<Icon name="caret-down" size={16} color={theme.colors.text.secondary} />}
                            />
                        )}
                    />
                </View>
            ) : null}

            {props.usingSavedHost ? null : (
                    <>
                    <SshCredentialsFields
                        testIDPrefix={props.testID ? `${props.testID}-ssh` : 'remote-ssh-checklist-ssh'}
                        layoutVariant="step"
                        value={props.draft}
                        onChange={props.onChangeDraft}
                        supportedAuthModes={props.supportedAuthModes}
                        privateKeyMaterial={props.privateKeyMaterialDraft}
                        onChangePrivateKeyMaterial={props.onChangePrivateKeyMaterialDraft}
                    />
                    {props.remoteHostsManagementEnabled ? (
                        <View style={styles.toggleList}>
                            {renderToggleRow({
                                testID: props.testID ? `${props.testID}-save-host` : 'remote-ssh-checklist-save-host',
                                selected: props.saveHost,
                                title: t('setupOnboarding.remoteHosts.saveHostTitle'),
                                subtitle: t('setupOnboarding.remoteHosts.saveHostSubtitle'),
                                icon: 'bookmark',
                                onPress: props.onToggleSaveHost,
                            })}

                            {props.saveHost && props.remoteHostsSecretMaterialEnabled && props.draft.authMode === 'password'
                                ? renderToggleRow({
                                    testID: props.testID ? `${props.testID}-save-password` : 'remote-ssh-checklist-save-password',
                                    selected: props.saveSecretMaterial,
                                    title: t('setupOnboarding.remoteHosts.savePasswordTitle'),
                                    subtitle: t('setupOnboarding.remoteHosts.savePasswordSubtitle'),
                                    icon: 'key',
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
                                            icon: 'key',
                                            onPress: props.onToggleSaveSecretMaterial,
                                        })}
                                    </>
                                )
                                : null}
                        </View>
                    ) : null}
                </>
            )}
        </StepForm>
    );
});

const toggleStyles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
        minHeight: 40,
    },
    label: {
        ...Typography.variant('label'),
        flexShrink: 1,
    },
}));
