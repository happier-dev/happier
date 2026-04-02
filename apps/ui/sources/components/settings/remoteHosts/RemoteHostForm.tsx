import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal/types';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { randomUUID } from '@/platform/randomUUID';
import { parseSshTarget, buildSshTarget } from '@happier-dev/protocol';

import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { SshCredentialsFields, type SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { createDefaultSshCredentialsDraft, parseSshPortNumber } from '@/components/ssh/sshCredentialsDraft';

import type { RemoteHost, RemoteHostAuthMode } from '@/sync/domains/remoteHosts/remoteHostModel';
import type { RemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';

function nowMs(): number {
    return Date.now();
}

function toSshDraft(remoteHost: RemoteHost | null, overrides: RemoteHostLocalOverrides | null): SshCredentialsDraft {
    if (!remoteHost) return createDefaultSshCredentialsDraft();
    const parsed = parseSshTarget(remoteHost.ssh.target);
    const portText = typeof remoteHost.ssh.port === 'number' && Number.isInteger(remoteHost.ssh.port) && remoteHost.ssh.port > 0
        ? String(remoteHost.ssh.port)
        : '';
    return {
        username: parsed.username ?? '',
        host: parsed.host ?? '',
        port: portText,
        authMode: remoteHost.ssh.authMode,
        identityFilePath: String(overrides?.identityFilePath ?? ''),
        password: '',
    };
}

function normalizeRemoteHostAuthMode(value: SshCredentialsDraft['authMode']): RemoteHostAuthMode {
    if (value === 'keyfile' || value === 'password') return value;
    return 'agent';
}

export const RemoteHostForm = React.memo(function RemoteHostForm(props: CustomModalInjectedProps & Readonly<{
    remoteHost: RemoteHost | null;
    localOverrides: RemoteHostLocalOverrides | null;
    secretMaterialAllowed: boolean;
    onSave: (payload: Readonly<{ remoteHost: RemoteHost; localOverrides: RemoteHostLocalOverrides | null }>) => void;
    onDelete: (remoteHostId: string) => void;
    onTestConnection: (remoteHost: RemoteHost) => void;
}>) {
    const { theme } = useUnistyles();
    const editing = Boolean(props.remoteHost);
    const existing = props.remoteHost;
    const existingPasswordEnc = existing?.ssh.passwordEnc ?? null;
    const existingIdentityPrivateKeyEnc = existing?.ssh.identityPrivateKeyEnc ?? null;
    const [name, setName] = React.useState(() => existing?.name ?? '');
    const [sshDraft, setSshDraft] = React.useState<SshCredentialsDraft>(() => toSshDraft(existing ?? null, props.localOverrides));
    const [savePassword, setSavePassword] = React.useState(() => Boolean(existingPasswordEnc));
    const [savePrivateKeyMaterial, setSavePrivateKeyMaterial] = React.useState(() => Boolean(existingIdentityPrivateKeyEnc));
    const [privateKeyMaterialDraft, setPrivateKeyMaterialDraft] = React.useState('');

    const effectiveSecretMaterialAllowed = props.secretMaterialAllowed === true;

    React.useEffect(() => {
        props.setChrome?.({
            kind: 'card',
            title: editing ? t('settings.remoteHostsEditHostTitle') : t('settings.remoteHostsAddHostTitle'),
            closeButtonTestID: 'remote-host-form-close',
        });
    }, [editing, props]);

    const handleDelete = React.useCallback(async () => {
        if (!existing) return;
        props.onDelete(existing.id);
        props.onClose();
    }, [existing, props]);

    const handleSave = React.useCallback(() => {
        const trimmedName = String(name ?? '').trim();
        if (!trimmedName) {
            return;
        }

        const sshAuthMode = normalizeRemoteHostAuthMode(sshDraft.authMode);
        const target = buildSshTarget({ username: sshDraft.username.trim(), host: sshDraft.host.trim() });

        const passwordRaw = String(sshDraft.password ?? '').trim();
        const privateKeyRaw = String(privateKeyMaterialDraft ?? '').trim();

        const passwordEnc = effectiveSecretMaterialAllowed && savePassword
            ? (passwordRaw
                ? sync.encryptSecretValue(passwordRaw)
                : (existingPasswordEnc ?? null))
            : null;

        const identityPrivateKeyEnc = effectiveSecretMaterialAllowed && savePrivateKeyMaterial && sshAuthMode === 'keyfile'
            ? (privateKeyRaw
                ? sync.encryptSecretValue(privateKeyRaw)
                : (existingIdentityPrivateKeyEnc ?? null))
            : null;

        const now = nowMs();
        const remoteHost: RemoteHost = {
            id: existing?.id ?? randomUUID(),
            name: trimmedName,
            ssh: {
                target,
                port: parseSshPortNumber(sshDraft.port),
                authMode: sshAuthMode,
                ...(effectiveSecretMaterialAllowed
                    ? {
                        ...(passwordEnc ? { passwordEnc } : {}),
                        ...(identityPrivateKeyEnc ? { identityPrivateKeyEnc } : {}),
                    }
                    : {}),
            },
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            lastUsedAt: existing?.lastUsedAt ?? now,
            linkedMachineId: existing?.linkedMachineId ?? null,
            linkedRelayProfileId: existing?.linkedRelayProfileId ?? null,
        };

        const identityFilePath = String(sshDraft.identityFilePath ?? '').trim();
        const localOverrides: RemoteHostLocalOverrides | null = identityFilePath
            ? { ...(props.localOverrides?.sshConfigFilePath ? { sshConfigFilePath: props.localOverrides.sshConfigFilePath } : {}), identityFilePath }
            : (props.localOverrides?.sshConfigFilePath ? { sshConfigFilePath: props.localOverrides.sshConfigFilePath } : null);

        props.onSave({ remoteHost, localOverrides });
        props.onClose();
    }, [
        effectiveSecretMaterialAllowed,
        existing,
        existingIdentityPrivateKeyEnc,
        existingPasswordEnc,
        name,
        privateKeyMaterialDraft,
        props,
        savePassword,
        savePrivateKeyMaterial,
        sshDraft,
    ]);

    const handleTestConnection = React.useCallback(() => {
        if (!existing) return;
        props.onTestConnection(existing);
        props.onClose();
    }, [existing, props]);

    const showSecretControls = effectiveSecretMaterialAllowed;
    const showStoredPasswordHint = showSecretControls && savePassword && existingPasswordEnc != null;
    const showStoredKeyHint = showSecretControls && savePrivateKeyMaterial && existingIdentityPrivateKeyEnc != null;

    return (
        <ItemList testID="remote-host-form">
            <ItemGroup title={t('settings.remoteHostsHostGroupTitle')}>
                <View style={{ paddingHorizontal: theme.margins.lg, paddingVertical: theme.margins.sm, gap: theme.margins.sm }}>
                    <MachineSetupTextField
                        testID="remote-host-form-name"
                        label={t('common.name')}
                        value={name}
                        autoCapitalize="words"
                        autoCorrect={false}
                        onChangeText={setName}
                    />
                </View>
            </ItemGroup>

            <ItemGroup title={t('settings.remoteHostsSshGroupTitle')}>
                <SshCredentialsFields
                    testIDPrefix="remote-host-form-ssh"
                    value={sshDraft}
                    onChange={setSshDraft}
                    layoutVariant="settings"
                />
            </ItemGroup>

            {sshDraft.authMode === 'password' ? (
                <ItemGroup title={t('settings.remoteHostsSecretMaterialGroupTitle')}>
                    {showSecretControls ? (
                        <>
                            <Item
                                title={t('settings.remoteHostsSavePasswordLabel')}
                                showChevron={false}
                                onPress={() => setSavePassword((current) => !current)}
                                rightElement={<Switch value={savePassword} onValueChange={setSavePassword} />}
                            />
                            {showStoredPasswordHint ? (
                                <Item
                                    title={t('settings.remoteHostsPasswordSavedTitle')}
                                    subtitle={t('settings.remoteHostsPasswordSavedSubtitle')}
                                    mode="info"
                                    showChevron={false}
                                />
                            ) : null}
                        </>
                    ) : (
                        <Item
                            title={t('settings.remoteHostsSecretMaterialDisabledTitle')}
                            subtitle={t('settings.remoteHostsSecretMaterialDisabledSubtitle')}
                            mode="info"
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            ) : null}

            {sshDraft.authMode === 'keyfile' ? (
                <ItemGroup title={t('settings.remoteHostsSecretMaterialGroupTitle')}>
                    {showSecretControls ? (
                        <>
                            <Item
                                title={t('settings.remoteHostsStorePrivateKeyLabel')}
                                showChevron={false}
                                onPress={() => setSavePrivateKeyMaterial((current) => !current)}
                                rightElement={<Switch value={savePrivateKeyMaterial} onValueChange={setSavePrivateKeyMaterial} />}
                            />
                            {savePrivateKeyMaterial ? (
                                <View style={{ paddingHorizontal: theme.margins.lg, paddingVertical: theme.margins.sm, gap: theme.margins.sm }}>
                                    <MachineSetupTextField
                                        testID="remote-host-form-private-key"
                                        label={t('settings.remoteHostsPrivateKeyLabel')}
                                        value={privateKeyMaterialDraft}
                                        multiline
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        onChangeText={setPrivateKeyMaterialDraft}
                                    />
                                    {showStoredKeyHint ? (
                                        <Text style={{ color: theme.colors.textSecondary }}>
                                            {t('settings.remoteHostsPrivateKeySavedHint')}
                                        </Text>
                                    ) : null}
                                </View>
                            ) : null}
                        </>
                    ) : (
                        <Item
                            title={t('settings.remoteHostsSecretMaterialDisabledTitle')}
                            subtitle={t('settings.remoteHostsSecretMaterialDisabledSubtitle')}
                            mode="info"
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('common.actions')}>
                {existing ? (
                    <Item
                        title={t('settings.remoteHostsTestConnectionTitle')}
                        onPress={handleTestConnection}
                    />
                ) : null}
                <Item
                    title={t('common.save')}
                    disabled={!name.trim() || !sshDraft.username.trim() || !sshDraft.host.trim()}
                    onPress={handleSave}
                />
                {existing ? (
                    <Item
                        title={t('common.delete')}
                        destructive
                        onPress={handleDelete}
                    />
                ) : null}
            </ItemGroup>
        </ItemList>
    );
});
