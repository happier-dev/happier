import React from 'react';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { parseSshTarget } from '@happier-dev/protocol/ssh/sshTarget';
import { t, tLoose } from '@/text';
import { lightTheme } from '@/theme';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MachineEnrollFieldLabel, MachineEnrollFieldSupport, MachineEnrollTextField } from '@/components/ui/forms/MachineEnrollTextField';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { useDeviceType } from '@/utils/platform/responsive';

export type SshAuthMode = 'agent' | 'keyfile' | 'password';

/** The step form's port field: four digits and room to read them (lab direction A "New host"). */
const SSH_STEP_PORT_WIDTH_PX = 80;

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
    /**
     * `settings`: grouped rows; `form`: Host · User · Port on one line (Add a machine, lab add-flows M3); `step`: a
     * signed-out step's form (lab direction A "New host"): Address and an 80 px Port on one line, Sign in as beneath.
     */
    layoutVariant?: 'settings' | 'form' | 'step';
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
    const space = theme.space ?? lightTheme.space;
    const layoutVariant = props.layoutVariant ?? 'settings';
    const isFormLayout = layoutVariant === 'form' || layoutVariant === 'step';
    const stepLayout = layoutVariant === 'step';
    // A phone recomposes the line: the address takes its own row, sign-in user and port share the next (lab add/sshp).
    const narrowForm = useDeviceType() === 'phone';
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
                    title={t('settings.machineEnrollRemoteSshAgentAuthLabel')}
                    selected={value.authMode === 'agent'}
                    disabled={formDisabled}
                    onPress={() => handleAuthModeChange('agent')}
                />
            ) : null}
            {supportsKeyfileAuth ? (
                <Item
                    testID={testIDs.sshAuthKeyfile ?? resolveTestID('sshAuthKeyfile')}
                    title={t('settings.machineEnrollRemoteSshKeyFileAuthLabel')}
                    selected={value.authMode === 'keyfile'}
                    disabled={formDisabled}
                    onPress={() => handleAuthModeChange('keyfile')}
                />
            ) : null}
            {supportsPasswordAuth ? (
                <Item
                    testID={testIDs.sshAuthPassword ?? resolveTestID('sshAuthPassword')}
                    title={t('settings.machineEnrollRemoteSshPasswordAuthLabel')}
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
            tabs.push({ id: 'agent', label: t('settings.machineEnrollRemoteSshAgentAuthLabel') });
        }
        if (supportsKeyfileAuth) {
            tabs.push({ id: 'keyfile', label: t('settings.machineEnrollRemoteSshKeyFileAuthLabel') });
        }
        if (supportsPasswordAuth) {
            tabs.push({ id: 'password', label: t('settings.machineEnrollRemoteSshPasswordAuthLabel') });
        }
        return tabs;
    }, [supportsAgentAuth, supportsKeyfileAuth, supportsPasswordAuth]);

    const renderIdentityFileField = () => (
        <>
            <MachineEnrollTextField
                testID={testIDs.sshIdentityFile ?? resolveTestID('sshIdentityFile')}
                label={t('settings.machineEnrollRemoteSshIdentityFileLabel')}
                value={value.identityFilePath}
                editable={!formDisabled}
                autoCapitalize="none"
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
            <MachineEnrollTextField
                testID={testIDs.sshPrivateKeyMaterial ?? resolveTestID('sshPrivateKeyMaterialInput')}
                label={t('settings.machineEnrollRemoteSshPrivateKeyMaterialLabel')}
                value={props.privateKeyMaterial ?? ''}
                editable={!formDisabled}
                multiline
                autoCapitalize="none"
                onChangeText={props.onChangePrivateKeyMaterial}
            />
        );
    };

    const renderPasswordField = () => (
        <MachineEnrollTextField
            testID={testIDs.sshPassword ?? resolveTestID('sshPasswordInput')}
            label={t('settings.machineEnrollRemoteSshPasswordLabel')}
            value={value.password}
            editable={!formDisabled}
            secureTextEntry
            autoCapitalize="none"
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
            {stepLayout ? (
                // Address and Port share a line on one baseline, the port a fixed 80 px; who to sign in as beneath.
                <View style={{ gap: space.s16 }}>
                    <View style={{ flexDirection: 'row', gap: space.s10, alignItems: 'flex-start' }}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <MachineEnrollTextField
                                testID={testIDs.sshHost ?? resolveTestID('sshHostInput')}
                                label={t('settings.machineEnrollRemoteSshHostLabel')}
                                placeholder={t('settings.machineEnrollRemoteSshHostPlaceholder')}
                                value={value.host}
                                editable={!formDisabled}
                                autoCapitalize="none"
                                onChangeText={handleHostChange}
                            />
                        </View>
                        <View style={{ width: SSH_STEP_PORT_WIDTH_PX }}>
                            <MachineEnrollTextField
                                testID={testIDs.sshPort ?? resolveTestID('sshPortInput')}
                                label={t('settings.machineEnrollRemoteSshPortLabel')}
                                placeholder={t('settings.machineEnrollRemoteSshPortPlaceholder')}
                                value={value.port}
                                editable={!formDisabled}
                                keyboardType="number-pad"
                                autoCapitalize="none"
                                onChangeText={handlePortChange}
                            />
                        </View>
                    </View>
                    <MachineEnrollTextField
                        testID={testIDs.sshUsername ?? resolveTestID('sshUsernameInput')}
                        label={t('settings.machineEnrollRemoteSshUsernameLabel')}
                        placeholder={t('settings.machineEnrollRemoteSshUsernamePlaceholder')}
                        value={value.username}
                        editable={!formDisabled}
                        autoCapitalize="none"
                        onChangeText={(nextUsername) => {
                            updateValue({
                                username: nextUsername.trim(),
                            });
                        }}
                    />
                </View>
            ) : isFormLayout ? (
                // Host · User · Port on one line (lab `add-flows` M3).
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 }}>
                    <View style={{ flexGrow: 2, flexBasis: narrowForm ? '100%' : 180, minWidth: 0 }}>
                        <MachineEnrollTextField
                            testID={testIDs.sshHost ?? resolveTestID('sshHostInput')}
                            label={t('settings.machineEnrollRemoteSshHostLabel')}
                            placeholder={t('settings.machineEnrollRemoteSshHostPlaceholder')}
                            value={value.host}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            onChangeText={handleHostChange}
                        />
                    </View>
                    <View style={{ flexGrow: 1.4, flexBasis: narrowForm ? 0 : 120, minWidth: 0 }}>
                        <MachineEnrollTextField
                            testID={testIDs.sshUsername ?? resolveTestID('sshUsernameInput')}
                            label={t('settings.machineEnrollRemoteSshUsernameLabel')}
                            placeholder={t('settings.machineEnrollRemoteSshUsernamePlaceholder')}
                            value={value.username}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            onChangeText={(nextUsername) => {
                                updateValue({
                                    username: nextUsername.trim(),
                                });
                            }}
                        />
                    </View>
                    <View style={{ flexGrow: 0, flexBasis: 88 }}>
                        <MachineEnrollTextField
                            testID={testIDs.sshPort ?? resolveTestID('sshPortInput')}
                            label={t('settings.machineEnrollRemoteSshPortLabel')}
                            placeholder={t('settings.machineEnrollRemoteSshPortPlaceholder')}
                            value={value.port}
                            editable={!formDisabled}
                            keyboardType="number-pad"
                            autoCapitalize="none"
                            onChangeText={handlePortChange}
                        />
                    </View>
                </View>
            ) : (
                <ItemGroup>
                    <View style={{ paddingHorizontal: space.s16, paddingVertical: space.s8, gap: space.s8 }}>
                        <MachineEnrollTextField
                            testID={testIDs.sshUsername ?? resolveTestID('sshUsernameInput')}
                            label={t('settings.machineEnrollRemoteSshUsernameLabel')}
                            placeholder={t('settings.machineEnrollRemoteSshUsernamePlaceholder')}
                            value={value.username}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            onChangeText={(nextUsername) => {
                                updateValue({
                                    username: nextUsername.trim(),
                                });
                            }}
                        />
                        <MachineEnrollTextField
                            testID={testIDs.sshHost ?? resolveTestID('sshHostInput')}
                            label={t('settings.machineEnrollRemoteSshHostLabel')}
                            placeholder={t('settings.machineEnrollRemoteSshHostPlaceholder')}
                            value={value.host}
                            editable={!formDisabled}
                            autoCapitalize="none"
                            onChangeText={handleHostChange}
                        />
                        <MachineEnrollTextField
                            testID={testIDs.sshPort ?? resolveTestID('sshPortInput')}
                            label={t('settings.machineEnrollRemoteSshPortLabel')}
                            placeholder={t('settings.machineEnrollRemoteSshPortPlaceholder')}
                            value={value.port}
                            editable={!formDisabled}
                            keyboardType="number-pad"
                            autoCapitalize="none"
                            onChangeText={handlePortChange}
                        />
                    </View>
                </ItemGroup>
            )}

            {isFormLayout ? (
                // The choice is a field like the ones above it: its label, the choice, what it means as help.
                <View style={{ gap: space.s8 }}>
                    <MachineEnrollFieldLabel>{t('settings.machineEnrollRemoteSshAuthMethodLabel')}</MachineEnrollFieldLabel>
                    {/* Long translations stay reachable: the choice scrolls rather than clipping a label. */}
                    <ScrollView
                        testID={`${testIDs.sshAuthMethod ?? resolveTestID('sshAuthMethod')}-scroller`}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={{ flexGrow: 0, alignSelf: 'flex-start', maxWidth: '100%' }}
                    >
                        <SegmentedTabBar
                            role="radiogroup"
                            tabs={authTabs}
                            activeTabId={value.authMode}
                            onSelectTab={handleAuthModeChange}
                            testIDPrefix={testIDs.sshAuthMethod ?? resolveTestID('sshAuthMethod')}
                            accessibilityLabel={t('settings.machineEnrollRemoteSshAuthMethodLabel')}
                            segmentSizing="content"
                        />
                    </ScrollView>
                    <MachineEnrollFieldSupport>
                        {t(value.authMode === 'keyfile'
                            ? 'addFlows.sshSignInKeyFile'
                            : value.authMode === 'password'
                                ? 'addFlows.sshSignInPassword'
                                : 'addFlows.sshSignInAgent')}
                    </MachineEnrollFieldSupport>
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
                        <View style={{ gap: space.s8 }}>
                            {renderIdentityFileField()}
                            {renderPrivateKeyPasteField()}
                        </View>
                    ) : (
                        <ItemGroup>
                            <View style={{ paddingHorizontal: space.s16, paddingVertical: space.s8 }}>
                                <MachineEnrollTextField
                                    testID={testIDs.sshIdentityFile ?? resolveTestID('sshIdentityFile')}
                                    label={t('settings.machineEnrollRemoteSshIdentityFileLabel')}
                                    value={value.identityFilePath}
                                    editable={!formDisabled}
                                    autoCapitalize="none"
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
                    <View style={{ gap: space.s8 }}>
                        {renderPasswordField()}
                    </View>
                ) : (
                    <ItemGroup>
                        <View style={{ paddingHorizontal: space.s16, paddingVertical: space.s8 }}>
                            <MachineEnrollTextField
                                testID={testIDs.sshPassword ?? resolveTestID('sshPasswordInput')}
                                label={t('settings.machineEnrollRemoteSshPasswordLabel')}
                                value={value.password}
                                editable={!formDisabled}
                                secureTextEntry
                                autoCapitalize="none"
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
