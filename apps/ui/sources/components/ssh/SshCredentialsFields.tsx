import React from 'react';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { parseSshTarget } from '@happier-dev/protocol/ssh/sshTarget';
import { t, tLoose } from '@/text';
import { lightTheme } from '@/theme';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';

export type SshAuthMode = 'agent' | 'keyfile' | 'password';

export type SshCredentialsDraft = Readonly<{
    username: string;
    host: string;
    port: string;
    authMode: SshAuthMode;
    identityFilePath: string;
    password: string;
}>;

const DEFAULT_SSH_AUTH_MODES: ReadonlyArray<SshAuthMode> = ['agent', 'keyfile', 'password'];

export const SshCredentialsFields = React.memo(function SshCredentialsFields(props: Readonly<{
    testIDPrefix: string;
    testIDs?: Partial<Record<
        | 'sshUsername'
        | 'sshHost'
        | 'sshPort'
        | 'sshAuthMethod'
        | 'sshAuthAgent'
        | 'sshAuthKeyfile'
        | 'sshAuthPassword'
        | 'sshIdentityFile'
        | 'sshPrivateKeyMaterial'
        | 'sshPassword'
        | 'chooseIdentityFile',
        string
    >>;
    value: SshCredentialsDraft;
    supportedAuthModes?: ReadonlyArray<SshAuthMode>;
    disabled?: boolean;
    layoutVariant?: 'settings' | 'form';
    onChange: (next: SshCredentialsDraft) => void;
    onChooseIdentityFile?: () => void;
    afterAuthGroups?: React.ReactNode;
    privateKeyMaterial?: string;
    onChangePrivateKeyMaterial?: (next: string) => void;
}>) {
    const { theme } = useUnistyles();
    const formDisabled = Boolean(props.disabled);
    const value = props.value;
    const latestValueRef = React.useRef(value);
    const testIDs = props.testIDs ?? {};
    const resolveTestID = (suffix: keyof NonNullable<typeof testIDs> | string) => `${props.testIDPrefix}-${suffix}`;
    const margins = theme.margins ?? lightTheme.margins;
    const layoutVariant = props.layoutVariant ?? 'settings';
    const isFormLayout = layoutVariant === 'form';
    const supportedAuthModes = props.supportedAuthModes ?? DEFAULT_SSH_AUTH_MODES;
    const supportsAgentAuth = supportedAuthModes.includes('agent');
    const supportsKeyfileAuth = supportedAuthModes.includes('keyfile');
    const supportsPasswordAuth = supportedAuthModes.includes('password');

    React.useEffect(() => {
        latestValueRef.current = value;
    }, [value]);

    const updateValue = React.useCallback((next: Partial<SshCredentialsDraft>) => {
        const merged: SshCredentialsDraft = {
            ...latestValueRef.current,
            ...next,
        };
        latestValueRef.current = merged;
        props.onChange(merged);
    }, [props]);

    const handleHostChange = React.useCallback((nextHostText: string) => {
        const parsed = parseSshTarget(nextHostText);
        const currentUsername = latestValueRef.current.username;
        updateValue({
            username: nextHostText.includes('@') ? parsed.username : currentUsername,
            host: parsed.host,
        });
    }, [updateValue]);

    const handlePortChange = React.useCallback((nextPortText: string) => {
        updateValue({
            port: nextPortText.replace(/[^\d]/g, ''),
        });
    }, [updateValue]);

    const handleAuthModeChange = React.useCallback((nextAuthMode: SshAuthMode) => {
        updateValue({
            authMode: nextAuthMode,
            ...(nextAuthMode !== 'password' ? { password: '' } : {}),
        });
    }, [updateValue]);

    const renderAuthModeItems = () => (
        <>
            {supportsAgentAuth ? (
                <Item
                    testID={testIDs.sshAuthAgent ?? resolveTestID('sshAuthAgent')}
                    title={t('settings.machineSetupRemoteSshAgentAuthLabel')}
                    selected={value.authMode === 'agent'}
                    disabled={formDisabled}
                    onPress={() => handleAuthModeChange('agent')}
                />
            ) : null}
            {supportsKeyfileAuth ? (
                <Item
                    testID={testIDs.sshAuthKeyfile ?? resolveTestID('sshAuthKeyfile')}
                    title={t('settings.machineSetupRemoteSshKeyFileAuthLabel')}
                    selected={value.authMode === 'keyfile'}
                    disabled={formDisabled}
                    onPress={() => handleAuthModeChange('keyfile')}
                />
            ) : null}
            {supportsPasswordAuth ? (
                <Item
                    testID={testIDs.sshAuthPassword ?? resolveTestID('sshAuthPassword')}
                    title={t('settings.machineSetupRemoteSshPasswordAuthLabel')}
                    selected={value.authMode === 'password'}
                    disabled={formDisabled}
                    onPress={() => handleAuthModeChange('password')}
                />
            ) : null}
        </>
    );

    const authTabs = React.useMemo((): ReadonlyArray<SegmentedTab<SshAuthMode>> => {
        const tabs: Array<SegmentedTab<SshAuthMode>> = [];
        if (supportsAgentAuth) {
            tabs.push({ id: 'agent', label: t('settings.machineSetupRemoteSshAgentAuthLabel') });
        }
        if (supportsKeyfileAuth) {
            tabs.push({ id: 'keyfile', label: t('settings.machineSetupRemoteSshKeyFileAuthLabel') });
        }
        if (supportsPasswordAuth) {
            tabs.push({ id: 'password', label: t('settings.machineSetupRemoteSshPasswordAuthLabel') });
        }
        return tabs;
    }, [supportsAgentAuth, supportsKeyfileAuth, supportsPasswordAuth]);

    const renderIdentityFileField = () => (
        <>
            <MachineSetupTextField
                testID={testIDs.sshIdentityFile ?? resolveTestID('sshIdentityFile')}
                label={t('settings.machineSetupRemoteSshIdentityFileLabel')}
                value={value.identityFilePath}
                editable={!formDisabled}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(nextPath) => {
                    props.onChange({
                        ...value,
                        identityFilePath: nextPath,
                    });
                }}
            />

            {props.onChooseIdentityFile ? (
                <Item
                    testID={testIDs.chooseIdentityFile ?? resolveTestID('chooseIdentityFile')}
                    title={t('common.open')}
                    disabled={formDisabled}
                    onPress={props.onChooseIdentityFile}
                />
            ) : null}
        </>
    );

    const renderPrivateKeyPasteField = () => {
        if (!props.onChangePrivateKeyMaterial) {
            return null;
        }
        return (
            <MachineSetupTextField
                testID={testIDs.sshPrivateKeyMaterial ?? resolveTestID('sshPrivateKeyMaterialInput')}
                label={t('settings.machineSetupRemoteSshPrivateKeyMaterialLabel')}
                value={props.privateKeyMaterial ?? ''}
                editable={!formDisabled}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={props.onChangePrivateKeyMaterial}
            />
        );
    };

    const renderPasswordField = () => (
        <MachineSetupTextField
            testID={testIDs.sshPassword ?? resolveTestID('sshPasswordInput')}
            label={t('settings.machineSetupRemoteSshPasswordLabel')}
            value={value.password}
            editable={!formDisabled}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(nextPassword) => {
                props.onChange({
                    ...value,
                    password: nextPassword,
                });
            }}
        />
    );

    return (
        <>
            {isFormLayout ? (
                // Host · User · Port on one line (lab `add-flows` M3); narrow widths wrap user and port under the host.
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: margins.sm }}>
                    <View style={{ flexGrow: 2, flexBasis: 180, minWidth: 0 }}>
                        <MachineSetupTextField
                            testID={testIDs.sshHost ?? resolveTestID('sshHostInput')}
                            label={t('settings.machineSetupRemoteSshHostLabel')}
                            placeholder={t('settings.machineSetupRemoteSshHostPlaceholder')}
                            value={value.host}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={handleHostChange}
                        />
                    </View>
                    <View style={{ flexGrow: 1.4, flexBasis: 120, minWidth: 0 }}>
                        <MachineSetupTextField
                            testID={testIDs.sshUsername ?? resolveTestID('sshUsernameInput')}
                            label={t('settings.machineSetupRemoteSshUsernameLabel')}
                            placeholder={t('settings.machineSetupRemoteSshUsernamePlaceholder')}
                            value={value.username}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={(nextUsername) => {
                                updateValue({
                                    username: nextUsername.trim(),
                                });
                            }}
                        />
                    </View>
                    <View style={{ flexGrow: 0, flexBasis: 88 }}>
                        <MachineSetupTextField
                            testID={testIDs.sshPort ?? resolveTestID('sshPortInput')}
                            label={t('settings.machineSetupRemoteSshPortLabel')}
                            placeholder={t('settings.machineSetupRemoteSshPortPlaceholder')}
                            value={value.port}
                            editable={!formDisabled}
                            keyboardType="number-pad"
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={handlePortChange}
                        />
                    </View>
                </View>
            ) : (
                <ItemGroup>
                    <View style={{ paddingHorizontal: margins.lg, paddingVertical: margins.sm, gap: margins.sm }}>
                        <MachineSetupTextField
                            testID={testIDs.sshUsername ?? resolveTestID('sshUsernameInput')}
                            label={t('settings.machineSetupRemoteSshUsernameLabel')}
                            placeholder={t('settings.machineSetupRemoteSshUsernamePlaceholder')}
                            value={value.username}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={(nextUsername) => {
                                updateValue({
                                    username: nextUsername.trim(),
                                });
                            }}
                        />
                        <MachineSetupTextField
                            testID={testIDs.sshHost ?? resolveTestID('sshHostInput')}
                            label={t('settings.machineSetupRemoteSshHostLabel')}
                            placeholder={t('settings.machineSetupRemoteSshHostPlaceholder')}
                            value={value.host}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={handleHostChange}
                        />
                        <MachineSetupTextField
                            testID={testIDs.sshPort ?? resolveTestID('sshPortInput')}
                            label={t('settings.machineSetupRemoteSshPortLabel')}
                            placeholder={t('settings.machineSetupRemoteSshPortPlaceholder')}
                            value={value.port}
                            editable={!formDisabled}
                            keyboardType="number-pad"
                            autoCapitalize="none"
                            autoCorrect={false}
                            onChangeText={handlePortChange}
                        />
                    </View>
                </ItemGroup>
            )}

            {isFormLayout ? (
                // "Sign in with" and what it means on the left, the choice on the right; stacked when narrow.
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: margins.sm }}>
                    <View style={{ flexGrow: 1, flexBasis: 160, minWidth: 0 }}>
                        <Text style={{ color: theme.colors.text.primary }}>
                            {t('settings.machineSetupRemoteSshAuthMethodLabel')}
                        </Text>
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 13, lineHeight: 18 }}>
                            {t(value.authMode === 'keyfile'
                                ? 'addFlows.sshSignInKeyFile'
                                : value.authMode === 'password'
                                    ? 'addFlows.sshSignInPassword'
                                    : 'addFlows.sshSignInAgent')}
                        </Text>
                    </View>
                    {/* Long translations stay reachable: the choice scrolls rather than clipping a label. */}
                    <ScrollView
                        testID={`${testIDs.sshAuthMethod ?? resolveTestID('sshAuthMethod')}-scroller`}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={{ flexGrow: 0, maxWidth: '100%' }}
                    >
                        <SegmentedTabBar
                            role="radiogroup"
                            tabs={authTabs}
                            activeTabId={value.authMode}
                            onSelectTab={handleAuthModeChange}
                            testIDPrefix={testIDs.sshAuthMethod ?? resolveTestID('sshAuthMethod')}
                            accessibilityLabel={t('settings.machineSetupRemoteSshAuthMethodLabel')}
                            segmentSizing="content"
                            targetSize="platform"
                        />
                    </ScrollView>
                </View>
            ) : (
                <ItemGroup>
                    {renderAuthModeItems()}
                </ItemGroup>
            )}

            {props.afterAuthGroups}

            {supportsKeyfileAuth && value.authMode === 'keyfile' ? (
                <>
                    {isFormLayout ? (
                        <View style={{ gap: margins.sm }}>
                            {renderIdentityFileField()}
                            {renderPrivateKeyPasteField()}
                        </View>
                    ) : (
                        <ItemGroup>
                            <View style={{ paddingHorizontal: margins.lg, paddingVertical: margins.sm }}>
                                <MachineSetupTextField
                                    testID={testIDs.sshIdentityFile ?? resolveTestID('sshIdentityFile')}
                                    label={t('settings.machineSetupRemoteSshIdentityFileLabel')}
                                    value={value.identityFilePath}
                                    editable={!formDisabled}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    onChangeText={(nextPath) => {
                                        props.onChange({
                                            ...value,
                                            identityFilePath: nextPath,
                                        });
                                    }}
                                />
                            </View>
                        </ItemGroup>
                    )}

                    {!isFormLayout && props.onChooseIdentityFile ? (
                        <ItemGroup>
                            <Item
                                testID={testIDs.chooseIdentityFile ?? resolveTestID('chooseIdentityFile')}
                                title={t('common.open')}
                                disabled={formDisabled}
                                onPress={props.onChooseIdentityFile}
                            />
                        </ItemGroup>
                    ) : null}
                </>
            ) : null}

            {supportsPasswordAuth && value.authMode === 'password' ? (
                isFormLayout ? (
                    <View style={{ gap: margins.sm }}>
                        {renderPasswordField()}
                    </View>
                ) : (
                    <ItemGroup>
                        <View style={{ paddingHorizontal: margins.lg, paddingVertical: margins.sm }}>
                            <MachineSetupTextField
                                testID={testIDs.sshPassword ?? resolveTestID('sshPasswordInput')}
                                label={t('settings.machineSetupRemoteSshPasswordLabel')}
                                value={value.password}
                                editable={!formDisabled}
                                secureTextEntry
                                autoCapitalize="none"
                                autoCorrect={false}
                                onChangeText={(nextPassword) => {
                                    props.onChange({
                                        ...value,
                                        password: nextPassword,
                                    });
                                }}
                            />
                        </View>
                    </ItemGroup>
                )
            ) : null}
        </>
    );
});
