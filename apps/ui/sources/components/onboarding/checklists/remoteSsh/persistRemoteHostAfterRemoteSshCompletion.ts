import { buildSshTarget } from '@happier-dev/protocol/ssh/sshTarget';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { upsertRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { randomUUID } from '@/platform/randomUUID';
import { adoptHomeProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { isLoopbackServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { withProfileAccount } from '@/sync/api/account/apiProfileCatalog';
import { prepareRemoteHostSaveInContext, saveRemoteHostInContext, type RemoteHostMutationResult } from '@/sync/api/account/apiRemoteHostCatalog';
import { invalidateRemoteHostCatalogProjection } from '@/sync/engine/settings/remoteHostCatalogEngine';
import { fireAndForget } from '@/utils/system/fireAndForget';

type Completion = Readonly<{ machineId: string | null; relayRuntimeUrl: string | null }>;
export type RemoteHostCompletionPersistResult = Readonly<{ ok: true; hostId: string; revision: number;
    localOverrides?: 'saved' | 'pending' | 'retired' }>
    | Extract<RemoteHostMutationResult, { ok: false }>;

type SavedCompletionParams = Readonly<{
    scope: ServerAccountScope; host: RemoteHost; expectedRevision: number | 'absent'; completion: Completion;
    signal?: AbortSignal; assertCurrent?(): void;
}>;

async function adoptDiscoveredRelayHome(completion: Completion, signal?: AbortSignal): Promise<ServerProfile | null> {
    signal?.throwIfAborted();
    const url = completion.relayRuntimeUrl;
    // A device-local transport address is not a published remote Home. Use
    // the same URL classification as the completion caller, then the sole
    // Home adoption owner for validation and focus-preserving persistence.
    const profile = url && !isLoopbackServerUrl(url) ? await adoptHomeProfile({
        descriptor: { serverUrl: url, canonicalServerUrl: url }, source: 'manual', preserveUserLabel: true,
    }) : null;
    signal?.throwIfAborted();
    return profile;
}

async function persistSavedCompletion(params: SavedCompletionParams, relayProfile: ServerProfile | null): Promise<RemoteHostCompletionPersistResult> {
    try {
        return await withProfileAccount(params.scope, params.signal, async context => {
            const assertCurrent = () => { params.signal?.throwIfAborted(); params.assertCurrent?.(); context.assertCurrent(); };
            assertCurrent();
            const now = Date.now();
            const result = await saveRemoteHostInContext(context, { expectedRevision: params.expectedRevision, host: {
                ...params.host, updatedAt: now, lastUsedAt: now,
                ...(params.completion.machineId ? { linkedMachineId: params.completion.machineId } : {}),
                ...(relayProfile ? { linkedRelayProfileId: relayProfile.id } : {}),
            } }, params.signal);
            if (!result.ok) return result;
            try { assertCurrent(); } catch { return { ...result, hostId: params.host.id, localOverrides: 'retired' }; }
            fireAndForget(invalidateRemoteHostCatalogProjection(params.scope), { tag: 'RemoteSshCompletion.refreshSavedHost' });
            return { ...result, hostId: params.host.id };
        });
    } catch { return { ok: false, reason: 'changed' }; }
}

/** Completion keeps the original run's exact addressed revision, never overwriting a fresh edit. */
export async function persistSavedRemoteHostAfterRemoteSshCompletion(params: SavedCompletionParams): Promise<RemoteHostCompletionPersistResult> {
    try {
        return await persistSavedCompletion(params, await adoptDiscoveredRelayHome(params.completion, params.signal));
    } catch { return { ok: false, reason: 'changed' }; }
}

/** Onboarding and explicit editing share the same catalog/resource transaction owner. */
export async function persistRemoteHostAfterRemoteSshCompletion(params: Readonly<{
    scope: ServerAccountScope | null; expectedRevision: number | 'absent' | null; host?: RemoteHost;
    managementEnabled: boolean; secretMaterialEnabled: boolean;
    selectedSavedRemoteHostId: string;
    runContext: Readonly<{ selectedSavedRemoteHostId: string; saveHost: boolean; saveSecretMaterial: boolean }> | null;
    newHostSentinelId: string; draft: SshCredentialsDraft; privateKeyMaterialDraft: string; completion: Completion;
    signal?: AbortSignal; assertCurrent?(): void;
}>): Promise<RemoteHostCompletionPersistResult> {
    try {
        const relayProfile = await adoptDiscoveredRelayHome(params.completion, params.signal);
        const usedId = params.runContext?.selectedSavedRemoteHostId ?? params.selectedSavedRemoteHostId;
        if (!params.managementEnabled) return { ok: false, reason: 'not_requested' };
        if (usedId !== params.newHostSentinelId) {
            if (!params.host || params.host.id !== usedId || !params.scope || params.expectedRevision === null) return { ok: false, reason: 'changed' };
            return await persistSavedCompletion({ scope: params.scope, host: params.host,
                expectedRevision: params.expectedRevision, completion: params.completion, signal: params.signal, assertCurrent: params.assertCurrent }, relayProfile);
        }
        if (!params.runContext?.saveHost) return { ok: false, reason: 'not_requested' };
        const scope = params.scope;
        const expectedRevision = params.expectedRevision;
        if (!scope || expectedRevision === null) return { ok: false, reason: 'changed' };
        return await withProfileAccount(scope, params.signal, async context => {
            const assertCurrent = () => { params.signal?.throwIfAborted(); params.assertCurrent?.(); context.assertCurrent(); };
            assertCurrent();
            const target = buildSshTarget({ username: params.draft.username.trim(), host: params.draft.host.trim() });
            const port = Number(params.draft.port.trim());
            const now = Date.now();
            const host: RemoteHost = { id: randomUUID(), name: params.draft.host.trim() || target,
                ssh: { target, authMode: params.draft.authMode, ...(Number.isInteger(port) && port > 0 ? { port } : {}) },
                createdAt: now, updatedAt: now, lastUsedAt: now,
                ...(params.completion.machineId ? { linkedMachineId: params.completion.machineId } : {}),
                ...(relayProfile ? { linkedRelayProfileId: relayProfile.id } : {}) };
            const shouldSaveSecret = params.secretMaterialEnabled && params.runContext?.saveSecretMaterial;
            const prepared = await prepareRemoteHostSaveInContext(context, { host, expectedRevision,
                ...(shouldSaveSecret ? { credentialChanges: {
                    ...(params.draft.authMode === 'password' && params.draft.password
                        ? { password: { kind: 'new' as const, value: params.draft.password } } : {}),
                    ...(params.draft.authMode === 'keyfile' && params.privateKeyMaterialDraft
                        ? { identityPrivateKey: { kind: 'new' as const, value: params.privateKeyMaterialDraft } } : {}),
                } } : {}),
            }, params.signal);
            try {
                assertCurrent();
                const result = await saveRemoteHostInContext(context, prepared.input, params.signal);
                if (!result.ok) return result;
                try { assertCurrent(); } catch { return { ...result, hostId: host.id, localOverrides: 'retired' }; }
                fireAndForget(invalidateRemoteHostCatalogProjection(scope), { tag: 'RemoteSshCompletion.refreshNewHost' });
                try {
                    upsertRemoteHostLocalOverrides(host.id, { identityFilePath: params.draft.identityFilePath });
                } catch {
                    return { ...result, hostId: host.id, localOverrides: 'pending' };
                }
                return { ...result, hostId: host.id, localOverrides: 'saved' };
            } finally { prepared.dispose(); }
        });
    } catch { return { ok: false, reason: 'unavailable' }; }
}
