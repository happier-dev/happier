import { buildSshTarget } from '@happier-dev/protocol';

import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import {
    readRemoteHosts,
    upsertRemoteHost,
    type RemoteHost,
    type RemoteHostsV1Raw,
} from '@/sync/domains/remoteHosts/remoteHostModel';
import { upsertRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { randomUUID } from '@/platform/randomUUID';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';

export function persistRemoteHostAfterRemoteSshCompletion(params: Readonly<{
    managementEnabled: boolean;
    secretMaterialEnabled: boolean;
    remoteHostsRaw: RemoteHostsV1Raw;

    selectedSavedRemoteHostId: string;
    runContext: Readonly<{
        selectedSavedRemoteHostId: string;
        saveHost: boolean;
        saveSecretMaterial: boolean;
    }> | null;
    newHostSentinelId: string;

    draft: SshCredentialsDraft;
    privateKeyMaterialDraft: string;

    completion: Readonly<{
        machineId: string | null;
        relayRuntimeUrl: string | null;
    }>;
}>) {
    const usedSavedHostId = params.runContext?.selectedSavedRemoteHostId ?? params.selectedSavedRemoteHostId;
    const shouldSaveHost = Boolean(
        params.runContext?.saveHost
        && params.managementEnabled
        && usedSavedHostId === params.newHostSentinelId,
    );
    const shouldSaveSecret = Boolean(params.runContext?.saveSecretMaterial && params.secretMaterialEnabled);
    const relayProfile = params.completion.relayRuntimeUrl
        ? upsertServerProfile({ serverUrl: params.completion.relayRuntimeUrl, source: 'manual' })
        : null;

    if (!params.managementEnabled) {
        return;
    }

    if (shouldSaveHost) {
        const now = Date.now();
        const target = buildSshTarget({ username: params.draft.username.trim(), host: params.draft.host.trim() });
        const portText = params.draft.port.trim();
        const port = portText ? Number.parseInt(portText, 10) : Number.NaN;
        const passwordEnc = shouldSaveSecret && params.draft.authMode === 'password'
            ? getSyncSingleton().encryptSecretValue(params.draft.password)
            : null;
        const identityPrivateKeyEnc = shouldSaveSecret && params.draft.authMode === 'keyfile'
            ? getSyncSingleton().encryptSecretValue(params.privateKeyMaterialDraft)
            : null;

        const newHost: RemoteHost = {
            id: randomUUID(),
            name: params.draft.host.trim() || target,
            ssh: {
                target,
                authMode: params.draft.authMode,
                ...(Number.isInteger(port) && port > 0 ? { port } : {}),
                ...(passwordEnc ? { passwordEnc } : {}),
                ...(identityPrivateKeyEnc ? { identityPrivateKeyEnc } : {}),
            },
            createdAt: now,
            updatedAt: now,
            lastUsedAt: now,
            ...(params.completion.machineId ? { linkedMachineId: params.completion.machineId } : {}),
            ...(relayProfile ? { linkedRelayProfileId: relayProfile.id } : {}),
        };

        try {
            upsertRemoteHostLocalOverrides(newHost.id, {
                identityFilePath: params.draft.identityFilePath,
            });
        } catch {
            // Ignore local override persistence errors.
        }

        try {
            getSyncSingleton().applySettings({
                remoteHostsV1: upsertRemoteHost(params.remoteHostsRaw, newHost),
            }, { source: 'ui' });
        } catch {
            // Ignore persistence errors; bootstrap completion is still valid.
        }
        return;
    }

    if (usedSavedHostId === params.newHostSentinelId) {
        return;
    }

    const existing = readRemoteHosts(params.remoteHostsRaw).find((host) => host.id === usedSavedHostId);
    if (!existing) {
        return;
    }

    const now = Date.now();
    const updated: RemoteHost = {
        ...existing,
        updatedAt: now,
        lastUsedAt: now,
        ...(params.completion.machineId ? { linkedMachineId: params.completion.machineId } : {}),
        ...(relayProfile ? { linkedRelayProfileId: relayProfile.id } : {}),
    };
    try {
        getSyncSingleton().applySettings({
            remoteHostsV1: upsertRemoteHost(params.remoteHostsRaw, updated),
        }, { source: 'ui' });
    } catch {
        // Ignore
    }
}
