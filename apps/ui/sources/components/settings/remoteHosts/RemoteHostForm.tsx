import * as React from 'react';
import { View } from 'react-native';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { t } from '@/text';
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
        savePassword: Boolean(remoteHost?.ssh.passwordSecretRef),
        savePrivateKeyMaterial: Boolean(remoteHost?.ssh.identityPrivateKeySecretRef),
        privateKeyMaterialDraft: '',
    };
}

export type RemoteHostCredentialChange = Readonly<{ kind: 'new'; value: string }> | Readonly<{ kind: 'clear' }>;
export type RemoteHostCredentialChanges = Readonly<{
    password?: RemoteHostCredentialChange;
    identityPrivateKey?: RemoteHostCredentialChange;
}>;
export type RemoteHostSavePayload = Readonly<{ remoteHost: RemoteHost; localOverrides: RemoteHostLocalOverrides | null;
    credentialChanges?: RemoteHostCredentialChanges }>;

/**
 * The one editor of a remote host, for a new host (draft) and a saved one: its name, how to reach it
 * over SSH, and which secrets this Account stores for it. The host's page renders its sections and
 * owns Save; secrets typed here reach only the atomic credential/reference save.
 */
export function useRemoteHostEditor(props: Readonly<{
    remoteHost: RemoteHost | null;
    localOverrides: RemoteHostLocalOverrides | null;
    secretMaterialAllowed: boolean;
}>) {
    const [state, setState] = React.useState<RemoteHostDraftState>(() => initialDraftState(props.remoteHost, props.localOverrides));
    const [baseline, setBaseline] = React.useState(() => ({ draft: state, remoteHost: props.remoteHost }));
    const existing = props.remoteHost ?? baseline.remoteHost;
    const draftIdentityRef = React.useRef<{ existingId: string | null; id: string | null }>({ existingId: existing?.id ?? null, id: null });
    if (draftIdentityRef.current.existingId !== (existing?.id ?? null)) {
        draftIdentityRef.current = { existingId: existing?.id ?? null, id: null };
    }
    const draftIdentity = draftIdentityRef.current;
    const accountDraft = (draft: RemoteHostDraftState) => ({ ...draft, sshConfigFilePath: '',
        sshDraft: { ...draft.sshDraft, identityFilePath: '' } });
    const accountDirty = JSON.stringify(accountDraft(state)) !== JSON.stringify(accountDraft(baseline.draft));
    const localDirty = state.sshConfigFilePath !== baseline.draft.sshConfigFilePath
        || state.sshDraft.identityFilePath !== baseline.draft.sshDraft.identityFilePath;
    const dirty = accountDirty || localDirty;
    const valid = state.name.trim().length > 0 && isSshCredentialsDraftReady(state.sshDraft);

    const buildSavePayload = React.useCallback((): RemoteHostSavePayload | null => {
        const trimmedName = state.name.trim();
        if (!trimmedName || !valid) return null;
        const effectiveSecretMaterialAllowed = props.secretMaterialAllowed === true;
        const existingPasswordRef = existing?.ssh.passwordSecretRef ?? null;
        const existingIdentityPrivateKeyRef = existing?.ssh.identityPrivateKeySecretRef ?? null;
        const sshAuthMode = normalizeRemoteHostAuthMode(state.sshDraft.authMode);
        const target = buildSshTarget({ username: state.sshDraft.username.trim(), host: state.sshDraft.host.trim() });
        const passwordRaw = String(state.sshDraft.password ?? '').trim();
        const privateKeyRaw = String(state.privateKeyMaterialDraft ?? '').trim();
        const credentialChanges: RemoteHostCredentialChanges = effectiveSecretMaterialAllowed ? {
            ...(state.savePassword
                ? (passwordRaw ? { password: { kind: 'new', value: passwordRaw } as const } : {})
                : (existingPasswordRef ? { password: { kind: 'clear' } as const } : {})),
            ...(state.savePrivateKeyMaterial && sshAuthMode === 'keyfile'
                ? (privateKeyRaw ? { identityPrivateKey: { kind: 'new', value: privateKeyRaw } as const } : {})
                : (existingIdentityPrivateKeyRef ? { identityPrivateKey: { kind: 'clear' } as const } : {})),
        } : {};
        const now = Date.now();
        const remoteHost: RemoteHost = {
            id: existing?.id ?? (draftIdentity.id ??= randomUUID()),
            name: trimmedName,
            ssh: {
                target,
                port: parseSshPortNumber(state.sshDraft.port),
                authMode: sshAuthMode,
                passwordSecretRef: existingPasswordRef,
                identityPrivateKeySecretRef: existingIdentityPrivateKeyRef,
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
        return { remoteHost, localOverrides, ...(Object.keys(credentialChanges).length ? { credentialChanges } : {}) };
    }, [draftIdentity, existing, props.secretMaterialAllowed, state, valid]);

    /** Marks the acknowledged draft saved and removes transient credential material. */
    const markSaved = React.useCallback((options: Readonly<{ localOverridesSaved?: boolean; remoteHost?: RemoteHost }> = {}) => {
        const acknowledged = {
            ...state,
            privateKeyMaterialDraft: '',
            sshConfigFilePath: options.localOverridesSaved === false ? baseline.draft.sshConfigFilePath : state.sshConfigFilePath,
            sshDraft: {
                ...state.sshDraft,
                password: '',
                identityFilePath: options.localOverridesSaved === false ? baseline.draft.sshDraft.identityFilePath : state.sshDraft.identityFilePath,
            },
        };
        // This callback belongs to the submitted draft. Acknowledging it must
        // not replace edits made while its HTTP save was pending.
        setState(current => ({
            ...current,
            privateKeyMaterialDraft: current.privateKeyMaterialDraft === state.privateKeyMaterialDraft ? '' : current.privateKeyMaterialDraft,
            sshDraft: { ...current.sshDraft, password: current.sshDraft.password === state.sshDraft.password ? '' : current.sshDraft.password },
        }));
        // The committed host, including its actual SavedSecret references,
        // belongs to this submitted baseline even while a new page stays open.
        setBaseline({ draft: acknowledged, remoteHost: options.remoteHost ?? existing });
    }, [baseline, existing, state]);
    const discard = React.useCallback(() => setState(baseline.draft), [baseline]);

    return { state, setState, dirty, accountDirty, localDirty, valid, buildSavePayload, markSaved, discard } as const;
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
    const showStoredPasswordHint = showSecretControls && state.savePassword && existing?.ssh.passwordSecretRef != null;
    const showStoredKeyHint = showSecretControls && state.savePrivateKeyMaterial && existing?.ssh.identityPrivateKeySecretRef != null;
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
