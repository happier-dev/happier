import { parseSshTarget } from '@happier-dev/protocol/ssh/sshTarget';

import type { RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverridesStore } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { resolveRemoteHostEffectiveSshConfig, type RemoteHostSavedSecretValueReader, type RemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';

/** Only a prepared task carries material; the saved host and picker retain references. */
export function buildRemoteSshBootstrapFormStateFromSshConfig(params: Readonly<{
    config: RemoteHostEffectiveSshConfig;
    draft: SshCredentialsDraft;
    installRelayRuntime: boolean;
}>): RemoteSshBootstrapFormState {
    const parsed = parseSshTarget(params.config.sshTarget);
    return {
        sshUsername: String(parsed.username ?? params.draft.username).trim(),
        sshHost: String(parsed.host ?? params.draft.host).trim(),
        sshPort: params.config.sshPort ? String(params.config.sshPort) : '',
        sshAuth: params.config.sshAuth,
        sshPassword: String(params.draft.password ?? '').trim() || params.config.password,
        identityFilePath: params.config.identityFilePath,
        identityPrivateKey: params.config.identityPrivateKey,
        installRelayRuntime: params.installRelayRuntime,
    };
}

export async function resolveRemoteSshBootstrapFormState(params: Readonly<{
    draft: SshCredentialsDraft;
    usingSavedHost: boolean;
    selectedSavedHost: RemoteHost | null;
    privateKeyMaterialDraft: string;
    saveSecretMaterial: boolean;
    installRelayRuntime: boolean;
    remoteHostsSecretMaterialEnabled: boolean;
    readSavedSecretValue?: RemoteHostSavedSecretValueReader;
}>): Promise<RemoteSshBootstrapFormState> {
    if (!params.usingSavedHost || !params.selectedSavedHost) {
        const privateKeyMaterial = params.draft.authMode === 'keyfile'
            ? params.privateKeyMaterialDraft.trim()
            : '';
        return {
            sshUsername: params.draft.username.trim(),
            sshHost: params.draft.host.trim(),
            sshPort: params.draft.port.trim(),
            sshAuth: params.draft.authMode,
            sshPassword: params.draft.password,
            identityFilePath: params.draft.identityFilePath,
            identityPrivateKey: privateKeyMaterial,
            installRelayRuntime: params.installRelayRuntime,
        };
    }

    if (!params.readSavedSecretValue) throw new Error('saved_secret_reader_unavailable');

    const localOverrides = (() => {
        try {
            return getRemoteHostLocalOverridesStore().get(params.selectedSavedHost.id);
        } catch {
            return null;
        }
    })();

    const resolved = await resolveRemoteHostEffectiveSshConfig({
        remoteHost: params.selectedSavedHost,
        localOverrides,
        secretMaterialAllowed: params.remoteHostsSecretMaterialEnabled,
        readSavedSecretValue: params.readSavedSecretValue,
    });

    if (!resolved.ok) {
        throw new Error(resolved.error.message);
    }

    return buildRemoteSshBootstrapFormStateFromSshConfig({ config: resolved.value, draft: params.draft,
        installRelayRuntime: params.installRelayRuntime });
}
