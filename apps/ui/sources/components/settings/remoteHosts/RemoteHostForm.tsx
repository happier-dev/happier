import * as React from 'react';
import { View } from 'react-native';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { randomUUID } from '@/platform/randomUUID';
import { parseSshTarget, buildSshTarget } from '@happier-dev/protocol/ssh/sshTarget';

import { SshCredentialsFields, type SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { applyConfiguredSshHostSuggestionToDraft, createDefaultSshCredentialsDraft, isSshCredentialsDraftReady, parseSshPortNumber } from '@/components/ssh/sshCredentialsDraft';
import { SshConfiguredHostPicker } from '@/components/ssh/SshConfiguredHostPicker';
import { filterConfiguredSshHostSuggestions, type SshConfiguredHostSuggestion } from '@/components/ssh/filterConfiguredSshHostSuggestions';
import { useConfiguredSshHostSuggestions } from '@/components/ssh/useConfiguredSshHostSuggestions';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

import type { RemoteHost, RemoteHostAuthMode } from '@/sync/domains/remoteHosts/remoteHostModel';
import type { RemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';

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

type RemoteHostDraftState = Readonly<{
    name: string;
    sshDraft: SshCredentialsDraft;
    sshConfigFilePath: string;
    savePassword: boolean;
    savePrivateKeyMaterial: boolean;
    privateKeyMaterialDraft: string;
}>;

function initialDraftState(remoteHost: RemoteHost | null, overrides: RemoteHostLocalOverrides | null): RemoteHostDraftState {
    return {
        name: remoteHost?.name ?? '',
        sshDraft: toSshDraft(remoteHost, overrides),
        sshConfigFilePath: overrides?.sshConfigFilePath ?? '',
        savePassword: Boolean(remoteHost?.ssh.passwordEnc),
        savePrivateKeyMaterial: Boolean(remoteHost?.ssh.identityPrivateKeyEnc),
        privateKeyMaterialDraft: '',
    };
}

export type RemoteHostSavePayload = Readonly<{ remoteHost: RemoteHost; localOverrides: RemoteHostLocalOverrides | null }>;

/**
 * The one editor of a remote host, for a new host (draft) and a saved one: its name, how to reach it
 * over SSH, and which secrets this Account stores for it. The host's page renders its sections and
 * owns Save; secrets typed here are encrypted only when saved.
 */
export function useRemoteHostEditor(props: Readonly<{
    remoteHost: RemoteHost | null;
    localOverrides: RemoteHostLocalOverrides | null;
    secretMaterialAllowed: boolean;
}>) {
    const existing = props.remoteHost;
    const [state, setState] = React.useState<RemoteHostDraftState>(() => initialDraftState(existing, props.localOverrides));
    const [baseline, setBaseline] = React.useState<RemoteHostDraftState>(() => initialDraftState(existing, props.localOverrides));
    const dirty = JSON.stringify(state) !== JSON.stringify(baseline);
    const valid = state.name.trim().length > 0 && isSshCredentialsDraftReady(state.sshDraft);

    const buildSavePayload = React.useCallback((): RemoteHostSavePayload | null => {
        const trimmedName = state.name.trim();
        if (!trimmedName || !valid) return null;
        const effectiveSecretMaterialAllowed = props.secretMaterialAllowed === true;
        const existingPasswordEnc = existing?.ssh.passwordEnc ?? null;
        const existingIdentityPrivateKeyEnc = existing?.ssh.identityPrivateKeyEnc ?? null;
        const sshAuthMode = normalizeRemoteHostAuthMode(state.sshDraft.authMode);
        const target = buildSshTarget({ username: state.sshDraft.username.trim(), host: state.sshDraft.host.trim() });
        const passwordRaw = String(state.sshDraft.password ?? '').trim();
        const privateKeyRaw = String(state.privateKeyMaterialDraft ?? '').trim();
        const passwordEnc = effectiveSecretMaterialAllowed && state.savePassword
            ? (passwordRaw ? sync.encryptSecretValue(passwordRaw) : existingPasswordEnc)
            : null;
        const identityPrivateKeyEnc = effectiveSecretMaterialAllowed && state.savePrivateKeyMaterial && sshAuthMode === 'keyfile'
            ? (privateKeyRaw ? sync.encryptSecretValue(privateKeyRaw) : existingIdentityPrivateKeyEnc)
            : null;
        const now = Date.now();
        const remoteHost: RemoteHost = {
            id: existing?.id ?? randomUUID(),
            name: trimmedName,
            ssh: {
                target,
                port: parseSshPortNumber(state.sshDraft.port),
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
        const identityFilePath = String(state.sshDraft.identityFilePath ?? '').trim();
        const nextSshConfigFilePath = String(state.sshConfigFilePath ?? '').trim();
        const localOverrides: RemoteHostLocalOverrides | null = identityFilePath || nextSshConfigFilePath
            ? {
                ...(nextSshConfigFilePath ? { sshConfigFilePath: nextSshConfigFilePath } : {}),
                ...(identityFilePath ? { identityFilePath } : {}),
            }
            : null;
        return { remoteHost, localOverrides };
    }, [existing, props.secretMaterialAllowed, state, valid]);

    /** Marks the current draft saved: typed secrets leave state once they are encrypted. */
    const markSaved = React.useCallback(() => {
        const next = { ...state, privateKeyMaterialDraft: '', sshDraft: { ...state.sshDraft, password: '' } };
        setState(next);
        setBaseline(next);
    }, [state]);
    const discard = React.useCallback(() => setState(baseline), [baseline]);

    return { state, setState, dirty, valid, buildSavePayload, markSaved, discard } as const;
}

export type RemoteHostEditorState = ReturnType<typeof useRemoteHostEditor>;

/** The editor's sections: Host (its name), SSH (how to reach it) and, per auth mode, stored secrets. */
export const RemoteHostEditorSections = React.memo(function RemoteHostEditorSections(props: Readonly<{
    editor: RemoteHostEditorState;
    remoteHost: RemoteHost | null;
    savedRemoteHosts: readonly RemoteHost[];
    systemTaskRunner?: SystemTaskRunner;
    secretMaterialAllowed: boolean;
}>) {
    const { state, setState } = props.editor;
    const existing = props.remoteHost;
    const configuredHostSuggestions = useConfiguredSshHostSuggestions({
        ...(props.systemTaskRunner ? { runner: props.systemTaskRunner } : {}),
    });
    const filteredConfiguredHostSuggestions = React.useMemo(() => filterConfiguredSshHostSuggestions({
        suggestions: configuredHostSuggestions.suggestions,
        remoteHosts: props.savedRemoteHosts.filter((host) => host.id !== existing?.id),
    }), [configuredHostSuggestions.suggestions, existing?.id, props.savedRemoteHosts]);
    const handleSelectConfiguredHost = React.useCallback((suggestion: SshConfiguredHostSuggestion) => {
        setState((current) => ({
            ...current,
            sshDraft: applyConfiguredSshHostSuggestionToDraft(current.sshDraft, suggestion),
            ...(suggestion.source === 'ssh-config' && suggestion.sourcePath ? { sshConfigFilePath: suggestion.sourcePath } : {}),
        }));
    }, [setState]);

    const showSecretControls = props.secretMaterialAllowed === true;
    const showStoredPasswordHint = showSecretControls && state.savePassword && existing?.ssh.passwordEnc != null;
    const showStoredKeyHint = showSecretControls && state.savePrivateKeyMaterial && existing?.ssh.identityPrivateKeyEnc != null;
    const secretMaterialDisabledRow = (
        <Item
            title={t('settings.remoteHostsSecretMaterialDisabledTitle')}
            subtitle={t('settings.remoteHostsSecretMaterialDisabledSubtitle')}
            subtitleLines={0}
            mode="info"
            showChevron={false}
        />
    );

    return (
        <>
            <ItemGroup title={t('settings.remoteHostsHostGroupTitle')}>
                <Item
                    title={t('common.name')}
                    showChevron={false}
                    accessoryLayout="adaptive"
                    rightElement={(
                        <FieldTextInput
                            testID="remote-host-form-name"
                            accessibilityLabel={t('common.name')}
                            value={state.name}
                            autoCapitalize="words"
                            onChangeText={(name) => setState((current) => ({ ...current, name }))}
                        />
                    )}
                />
            </ItemGroup>

            <ItemGroup title={t('settings.remoteHostsSshGroupTitle')}>
                <SshConfiguredHostPicker
                    testID="remote-host-form-configured-host-picker"
                    suggestions={filteredConfiguredHostSuggestions}
                    loading={configuredHostSuggestions.loading}
                    refreshing={configuredHostSuggestions.refreshing}
                    unsupported={configuredHostSuggestions.unsupported}
                    error={configuredHostSuggestions.error}
                    onRefresh={configuredHostSuggestions.refresh}
                    onSelectSuggestion={handleSelectConfiguredHost}
                />
                <SshCredentialsFields
                    testIDPrefix="remote-host-form-ssh"
                    value={state.sshDraft}
                    onChange={(sshDraft) => setState((current) => ({ ...current, sshDraft }))}
                    layoutVariant="settings"
                />
            </ItemGroup>

            {state.sshDraft.authMode === 'password' ? (
                <ItemGroup title={t('settings.remoteHostsSecretMaterialGroupTitle')}>
                    {showSecretControls ? (
                        <>
                            <Item
                                title={t('settings.remoteHostsSavePasswordLabel')}
                                showChevron={false}
                                onPress={() => setState((current) => ({ ...current, savePassword: !current.savePassword }))}
                                rightElement={<Switch value={state.savePassword} onValueChange={(savePassword) => setState((current) => ({ ...current, savePassword }))} />}
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
                    ) : secretMaterialDisabledRow}
                </ItemGroup>
            ) : null}

            {state.sshDraft.authMode === 'keyfile' ? (
                <ItemGroup title={t('settings.remoteHostsSecretMaterialGroupTitle')}>
                    {showSecretControls ? (
                        <>
                            <Item
                                title={t('settings.remoteHostsStorePrivateKeyLabel')}
                                showChevron={false}
                                onPress={() => setState((current) => ({ ...current, savePrivateKeyMaterial: !current.savePrivateKeyMaterial }))}
                                rightElement={<Switch value={state.savePrivateKeyMaterial} onValueChange={(savePrivateKeyMaterial) => setState((current) => ({ ...current, savePrivateKeyMaterial }))} />}
                            />
                            {state.savePrivateKeyMaterial ? (
                                <Item
                                    title={t('settings.remoteHostsPrivateKeyLabel')}
                                    subtitle={showStoredKeyHint ? t('settings.remoteHostsPrivateKeySavedHint') : undefined}
                                    subtitleLines={0}
                                    showChevron={false}
                                    accessoryLayout="stacked"
                                    rightElement={(
                                        <View style={{ width: '100%' }}>
                                            <FieldTextInput
                                                testID="remote-host-form-private-key"
                                                accessibilityLabel={t('settings.remoteHostsPrivateKeyLabel')}
                                                value={state.privateKeyMaterialDraft}
                                                multiline
                                                monospace
                                                onChangeText={(privateKeyMaterialDraft) => setState((current) => ({ ...current, privateKeyMaterialDraft }))}
                                            />
                                        </View>
                                    )}
                                />
                            ) : null}
                        </>
                    ) : secretMaterialDisabledRow}
                </ItemGroup>
            ) : null}
        </>
    );
});
