import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SshAuthMode, SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { SshCredentialsFields } from '@/components/ssh/SshCredentialsFields';
import { SshConfiguredHostPicker } from '@/components/ssh/SshConfiguredHostPicker';
import type { SshConfiguredHostSuggestion } from '@/components/ssh/filterConfiguredSshHostSuggestions';
import type { ConfiguredSshHostSuggestionsState } from '@/components/ssh/useConfiguredSshHostSuggestions';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { WizardChoiceRow } from '../../ui/WizardChoiceRow';

import type { RemoteSshChecklistCopy } from './copy';
import { remoteSshChecklistStyles } from './styles';
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
    configuredHostSuggestions: Omit<ConfiguredSshHostSuggestionsState, 'refresh'>;
    onRefreshConfiguredHostSuggestions: () => void | Promise<void>;
    onSelectConfiguredHostSuggestion: (suggestion: SshConfiguredHostSuggestion) => void;

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
        <WizardChoiceRow
            testID={params.testID}
            selected={params.selected}
            onPress={params.onPress}
            icon={params.icon}
            title={params.title}
            subtitle={params.subtitle}
        />
    ), []);

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.sectionBlock}>
                <SshConfiguredHostPicker
                    testID={props.testID ? `${props.testID}-configured-host-picker` : 'remote-ssh-checklist-configured-host-picker'}
                    suggestions={props.configuredHostSuggestions.suggestions}
                    loading={props.configuredHostSuggestions.loading}
                    refreshing={props.configuredHostSuggestions.refreshing}
                    unsupported={props.configuredHostSuggestions.unsupported}
                    error={props.configuredHostSuggestions.error}
                    onRefresh={props.onRefreshConfiguredHostSuggestions}
                    onSelectSuggestion={props.onSelectConfiguredHostSuggestion}
                />
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
                        layoutVariant="wizard"
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
        </View>
    );
});
