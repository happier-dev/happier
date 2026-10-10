import { createProfileActionExecuteV1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { setProfileFavoritePreferenceV1, type ProfileOperations } from '@happier-dev/protocol/profiles/profileOperations';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { router } from 'expo-router';
import { discardMountedProfileDraft } from '@/components/settings/profiles/profileEditorActionRuntime';
import { profileRoute } from '@/components/settings/profiles/profileCollectionRoutes';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { randomUUID } from '@/platform/randomUUID';
import { confirmLegacyProfileMigration, confirmLegacyProfileMigrationConflict, previewLegacyProfileMigration,
    providerErrorFromRpcFailure } from '@/providers/rpc/client';
import { createApiAuthoringMemoryTransport } from '@/sync/api/account/apiAuthoringMemory';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { DEFAULT_PROFILES } from '@/sync/domains/profiles/profileCatalog';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { clearRemovedProfileAuthoringMemory, createAuthoringMemorySync } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { retireLegacyAuthoringMemoryKey } from '@/sync/engine/settings/syncSettings';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import { createUiProfileOperationsInContext } from '@/sync/ops/profiles/createUiProfileOperations';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Each invocation keeps the one Home/Account context already admitted by the Action host. */
export function createUiProfileActionExecuteV1(account: LazyActionAccountContext,
    options?: Readonly<{ onRpcDispatched?: () => void }>,
): NonNullable<ActionExecutorDeps['profileActionExecute']> {
    return async (request, context) => {
        const assertCurrent = () => { context.signal?.throwIfAborted(); account.assertCurrent(); };
        const onDispatched = () => { assertCurrent(); options?.onRpcDispatched?.(); };
        const isCurrent = () => {
            try { assertCurrent(); return true; } catch { return false; }
        };
        assertCurrent();
        let operations: Promise<ProfileOperations> | undefined;
        let selectionMemory: Readonly<{ lastUsedProfile: string | null }> | undefined;
        let memoryOwner: Promise<ReturnType<typeof createAuthoringMemorySync>> | undefined;
        const resolveMemory = () => memoryOwner ??= (async () => {
            const { encryption } = await account.resolveAccountEncryption();
            const storage = await resolveAccountStorageContext(account.credentials, { encryption, request: account.request });
            assertCurrent();
            return createAuthoringMemorySync({
                transport: createApiAuthoringMemoryTransport({ request: (path, init) => account.request(path,
                    { ...init, signal: context.signal }, { retry: 'none' }) }),
                cipher: createAuthoringMemoryCipher({ mode: storage.mode,
                    material: storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(account.credentials),
                    randomBytes: getRandomBytes }),
                isCurrent,
                apply: delta => {
                    if (delta.lastUsedProfile !== undefined) selectionMemory = { lastUsedProfile: delta.lastUsedProfile };
                    // A background Home's acknowledgement never updates the focused Home's projection.
                    if (areServerAccountScopesEqual(getActiveServerAccountScope(), account.accountLifetime.scope)) {
                        getStorage().getState().applyAuthoringMemory(delta);
                    }
                },
            });
        })();
        const resolveOperations = async () => {
            if (request.actionId === 'launch_profiles.search'
                || (request.actionId === 'launch_profiles.select' && request.input.id !== null)) {
                await (await resolveMemory()).bootstrap();
            }
            return operations ??= createUiProfileOperationsInContext({
                scope: account.accountLifetime.scope, context: account, signal: context.signal,
                builtinNames: DEFAULT_PROFILES.map(getProfileDisplayName), isCurrent,
                ...(selectionMemory ? { selectionMemory } : {}),
                ...((request.actionId === 'launch_profiles.read' || request.actionId === 'launch_profiles.edit') ? {
                    addressedProfileId: request.input.id,
                    readSelectionMemory: async () => {
                        await (await resolveMemory()).bootstrap();
                        if (!selectionMemory) throw new Error('profile_selection_evidence_unavailable');
                        return selectionMemory;
                    },
                } : {}),
                clearRememberedProfile: async ({ id }) => {
                    assertCurrent();
                    const memory = await resolveMemory();
                    const { accountMode, encryption } = await account.resolveAccountEncryption();
                    const requestInContext: typeof account.request = (path, init, options) => account.request(path,
                        { ...init, signal: context.signal }, { ...options, retry: 'none' });
                    // The row owner invokes this only after its durable deletion ACK.
                    await clearRemovedProfileAuthoringMemory({
                        owner: memory, id,
                        settings: {
                            read: () => readAccountSettingsBaseline({ request: requestInContext,
                                credentials: account.credentials, encryption, accountMode }),
                            remove: async (_key, expectedSettingsVersion) => {
                                const result = await retireLegacyAuthoringMemoryKey({
                                    credentials: account.credentials, encryption, accountMode,
                                    settingsScope: account.accountLifetime.scope,
                                    requestContext: { scope: account.accountLifetime.scope,
                                        endpointUrl: account.endpointUrl, request: requestInContext },
                                    key: 'lastUsedProfile', expectedSettingsVersion,
                                });
                                return result.status;
                            },
                        },
                    });
                },
            });
        };
        const execute = createProfileActionExecuteV1({
            operations: resolveOperations,
            select: async ({ id }) => {
                const memory = await resolveMemory();
                if (id !== null) {
                    const admitted = (await resolveOperations()).validateSelection({ id });
                    if (admitted.status !== 'selected') return admitted;
                }
                await memory.applyDelta({ lastUsedProfile: id });
                return { status: 'selected', id };
            },
            favorite: async ({ id, favorite }) => {
                assertCurrent();
                await account.mutateRawSettings(raw => setProfileFavoritePreferenceV1(raw, id, favorite));
                return { status: 'updated', id, favorite };
            },
            edit: async ({ id, expectedRevision, expectedArtifactRevision }) => {
                const addressed = (await resolveOperations()).read({ id });
                if (addressed.status !== 'present') return addressed;
                if ('revision' in addressed) {
                    if (addressed.revision !== expectedRevision) return { status: 'conflict', id, revision: addressed.revision };
                } else if (expectedRevision !== 'absent') {
                    return { status: 'unavailable', reason: 'profile_editor_revision_unavailable' };
                }
                if (addressed.location.kind === 'artifact') {
                    if (addressed.location.access === 'view' || addressed.profile.viewOnly) {
                        return { status: 'invalid', reason: 'read-only', id };
                    }
                    if (!expectedArtifactRevision) return { status: 'unavailable', reason: 'profile_artifact_revision_unavailable' };
                    if (addressed.location.headerVersion !== expectedArtifactRevision.headerVersion
                        || addressed.location.bodyVersion !== expectedArtifactRevision.bodyVersion) {
                        return 'revision' in addressed ? { status: 'conflict', id, revision: addressed.revision }
                            : { status: 'unavailable', reason: 'profile_artifact_revision_changed' };
                    }
                }
                assertCurrent();
                if (!areServerAccountScopesEqual(getActiveServerAccountScope(), account.accountLifetime.scope)) {
                    return { status: 'unavailable', reason: 'profile_editor_account_not_focused' };
                }
                const draftId = randomUUID();
                router.push(`${profileRoute(id)}?draftId=${encodeURIComponent(draftId)}` as never);
                return { status: 'opened', id, draftId };
            },
            discardDraft: async ({ draftId }) => {
                assertCurrent();
                return discardMountedProfileDraft(account.accountLifetime.scope, draftId);
            },
            selectSecret: async input => (await resolveOperations()).selectSecret(input),
            legacyPreview: async input => {
                assertCurrent();
                try {
                    const result = await previewLegacyProfileMigration({ serverId: account.serverId, accountId: account.accountId,
                        request: input, signal: context.signal, onDispatched });
                    assertCurrent();
                    return result;
                } catch (error) { return { status: 'error', error: providerErrorFromRpcFailure(error, input) }; }
            },
            legacyConvert: async input => {
                assertCurrent();
                try {
                    return await confirmLegacyProfileMigration({ serverId: account.serverId, accountId: account.accountId,
                        request: input, signal: context.signal, onDispatched });
                } catch (error) { return { status: 'error', error: providerErrorFromRpcFailure(error, input) }; }
            },
            legacyResolveConflict: async input => {
                assertCurrent();
                try {
                    return await confirmLegacyProfileMigrationConflict({ serverId: account.serverId, accountId: account.accountId,
                        request: input, signal: context.signal, onDispatched });
                } catch (error) { return { status: 'error', error: providerErrorFromRpcFailure(error, input) }; }
            },
        });
        return execute(request, context);
    };
}
