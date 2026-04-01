import { parseSshTarget } from '@happier-dev/cli-common/systemTasks';

import type { RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import type { SshCredentialsDraft } from '@/components/settings/machines/shared/SshCredentialsFields';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverridesStore } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { resolveRemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import type { SecretString } from '@/sync/encryption/secretSettings';

export async function resolveRemoteSshBootstrapFormState(params: Readonly<{
    draft: SshCredentialsDraft;
    usingSavedHost: boolean;
    selectedSavedHost: RemoteHost | null;
    privateKeyMaterialDraft: string;
    saveSecretMaterial: boolean;
    installRelayRuntime: boolean;
    remoteHostsSecretMaterialEnabled: boolean;
    decryptSecretValue: (input: SecretString | null | undefined) => string | null;
}>): Promise<RemoteSshBootstrapFormState> {
    if (!params.usingSavedHost || !params.selectedSavedHost) {
        const privateKeyMaterial = params.draft.authMode === 'keyfile' && params.saveSecretMaterial
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
        decryptSecretValue: params.decryptSecretValue,
    });

    if (!resolved.ok) {
        throw new Error(resolved.error.message);
    }

    const parsed = parseSshTarget(resolved.value.sshTarget);
    const sshUsername = String(parsed.username ?? params.draft.username).trim();
    const sshHost = String(parsed.host ?? params.draft.host).trim();
    const sshPort = resolved.value.sshPort ? String(resolved.value.sshPort) : '';

    const passwordFromDraft = String(params.draft.password ?? '').trim();
    const effectivePassword = passwordFromDraft || resolved.value.password;

    return {
        sshUsername,
        sshHost,
        sshPort,
        sshAuth: resolved.value.sshAuth,
        sshPassword: effectivePassword,
        identityFilePath: resolved.value.identityFilePath,
        identityPrivateKey: resolved.value.identityPrivateKey,
        installRelayRuntime: params.installRelayRuntime,
    };
}
