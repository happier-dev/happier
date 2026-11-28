import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { z } from 'zod/mini';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { getMachineDisplayName, readMachineName } from '@/utils/sessions/machineDisplayNames';
import { HappyError } from '@/utils/errors/errors';
import { isLegacyAuthCredentials, isTokenOnlyAuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { migrateAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMigrate';
import { buildAccountEncryptionMigrateToPlainRequest } from '@/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest';
import { getConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
import { buildAccountEncryptionMigrateToE2eeRequest } from '@/sync/ops/account/buildAccountEncryptionMigrateToE2eeRequest';
import { getConnectedServiceCredentialPlain } from '@/sync/api/account/apiConnectedServicesV3';
import { getQualifiedConnectedAccountConfigurationV4, getQualifiedConnectedAccountCredentialV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { AccountEncryptionMigrateRequestSchema, AccountEncryptionMigrateSettingsHistoryInventoryPageSchema,
    createAccountEncryptionMigrateRequestBindingDigestV1, type AccountEncryptionMigrateRequest } from '@happier-dev/protocol/account/encryptionMigrate';
import { accountEncryptionSettingsHistoryUnavailable, type AccountEncryptionSettingsHistoryMigrationCandidate } from './buildAccountEncryptionSettingsHistoryDirective';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { fetchLiveOwnedMachineRows } from '@/sync/engine/machines/syncMachines';
import { fetchAccountEncryptionMigrationKvInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationKvInventory';
import { createArtifactAccessApi, fetchArtifactBlob, stageArtifactBlobAccountEncryptionConversion, cancelArtifactBlobAccountEncryptionConversion } from '@/sync/api/artifacts/apiArtifacts';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { AccountEncryptionMachineKeyUnavailableError, buildAccountEncryptionMigrationStorageDirectives } from '@/sync/ops/account/buildAccountEncryptionMigrationStorageDirectives';
import { fetchAccountEncryptionMigrationSessionInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationSessionInventory';
import { fetchAccountEncryptionMigrationArtifactInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationArtifactInventory';
import { fetchAccountEncryptionMigrationDiscussionInventory } from '@/sync/ops/account/buildAccountEncryptionDiscussionsDirective';
import { fetchAccountEncryptionMigrationAutomationsInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationAutomationsInventory';
import { fetchAccountEncryptionMigrationPrivateLabelInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationPrivateLabelInventory';
import { fetchAccountEncryptionMigrationManagedMachinePresetsInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationManagedMachinePresetsInventory';
import { fetchReviewCommentAccountEncryptionMigrationInventory } from '@/sync/domains/reviews/comments/accountEncryptionMigrationApi';
import { fetchSessionOrganizationAccountEncryptionMigrationInventory } from '@/sync/ops/account/fetchSessionOrganizationAccountEncryptionMigrationInventory';
import { accountEncryptionRestoreRequired, prepareAccountEncryptionMigrateToE2eeKey } from '@/sync/ops/account/prepareAccountEncryptionMigrateToE2eeKey';
import { openAccountEncryptionFirstKeyExternalAuthUrl, requestAccountEncryptionFirstKeyPasswordProof, retryPendingAccountEncryptionFirstKeyExternalAuth, resumeAccountEncryptionFirstKeyExternalAuth, startAccountEncryptionFirstKeyExternalAuth, shouldRetainAccountEncryptionMigrationArtifactUploads } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { acknowledgeNewSessionDraftEncryptionMigration, listNewSessionDraftEncryptionMigrationCandidates } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates';
import { fetchAccountEncryptionProjectTrustMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionProjectTrustMigrationCandidates';
import { runAccountEncryptionModeMigration } from '@/sync/ops/account/runAccountEncryptionModeMigration';
import { fetchAccountEncryptionSessionFollowRulesMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionSessionFollowRulesMigrationCandidates';
import { fetchAccountEncryptionAuthoringMemoryMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionAuthoringMemoryMigrationCandidates';
import { fetchAccountEncryptionProjectRowsMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionProjectRowsMigrationCandidates';
import { readProfileCatalog } from '@/sync/api/account/apiProfileCatalog';
import { readPromptLibraryCatalogProjection } from '@/sync/api/account/apiPromptLibraryCatalog';
import { readProviderCatalog } from '@/sync/api/account/apiProviderCatalog';
import { fetchAccountEncryptionProviderConnectionsMigrationCandidate } from '@/sync/ops/account/fetchAccountEncryptionProviderConnectionsMigrationCandidate';
import { fetchAccountEncryptionAcpCatalogMigrationCandidate } from '@/sync/ops/account/fetchAccountEncryptionAcpCatalogMigrationCandidate';
import { fetchAccountEncryptionMcpServerCatalogMigrationCandidate } from '@/sync/ops/account/fetchAccountEncryptionMcpServerCatalogMigrationCandidate';
import { fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates';
import { fetchAccountEncryptionEntityCatalogMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionEntityCatalogMigrationCandidates';
import { prepareAccountEncryptionModePasswordCredential } from '@/sync/api/auth/accountSecurity';
import { decodeBase64 } from '@/encryption/base64';
import { presentAccountRecoveryKeyEntry } from '@/components/settings/account/presentAccountRecoveryKeyEntry';
import { captureAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';
import { persistAccountE2eeMaterialCustody } from './accountE2eeMaterialCustody';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveHomeKeyChallengeExpectedAudience } from '@/auth/flows/resolveHomeAuthenticationTarget';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Profile } from '@/sync/domains/profiles/profile';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { AuthContextType } from '@/auth/context/AuthContext';
import { fetchAccountSecurity } from '@/sync/api/auth/accountSecurity';
import { readSavedSecretCatalog } from '@/sync/api/account/apiSavedSecretCatalog';
import { readDiscussionAttachmentStoredContent, stageDiscussionAttachmentAccountEncryptionConversion,
    cancelDiscussionAttachmentAccountEncryptionConversion } from '@/sync/api/discussions/discussionAttachmentTransport';

class AccountEncryptionScopeChangedError extends Error {
    constructor() {
        super('Account encryption scope changed');
        this.name = 'AccountEncryptionScopeChangedError';
    }
}

export class AccountEncryptionModeChangedError extends Error {
    constructor(readonly mode: 'plain' | 'e2ee') {
        super('Account encryption mode changed while preparing the migration');
        this.name = 'AccountEncryptionModeChangedError';
    }
}

const AccountEncryptionModeSchema = z.enum(['plain', 'e2ee']);
/** The `settings.invoke` value of a completed conversion. */
export const AccountEncryptionModeConversionResultSchema = z.object({ mode: AccountEncryptionModeSchema });
/** The `settings.invoke` value of an unavailable conversion; `mode` is set when the Account mode moved underneath it. */
export const AccountEncryptionModeConversionFailureSchema = z.object({
    message: z.optional(z.string()),
    mode: z.optional(AccountEncryptionModeSchema),
    status: z.optional(z.number()),
});

/** One whole-Account conversion owner shared by Settings and Agent Actions. */
export async function convertAccountEncryptionMode(params: Readonly<{
    credentials: AuthCredentials;
    sourceEncryption: Encryption | null;
    profile: Pick<Profile, 'connectedServicesV2' | 'connectedAccountsV4' | 'linkedProviders'>;
    settingsScope: AccountSettingsScope;
    accountEncryptionMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    sessionDraftSyncEnabled: boolean;
    persistCredentials: AuthContextType['loginWithCredentials'];
    signal?: AbortSignal;
}>): Promise<Readonly<{ mode: 'plain' | 'e2ee' }> | 'interaction_opened' | null> {
    const { credentials, sourceEncryption, profile, settingsScope, accountEncryptionMode, sessionDraftSyncEnabled } = params;
    const nextMode = params.toMode;
    let temporaryRecoverySecret: Uint8Array | undefined;
    let capturedRequest: Awaited<ReturnType<typeof captureAccountSettingsRequest>> = null;
    const stagedArtifactUploads: string[] = [];
    const stagedDiscussionUploads: string[] = [];
    let retainStagedArtifactUploads = false;
    let firstKeyArtifactCustody: Parameters<typeof shouldRetainAccountEncryptionMigrationArtifactUploads>[0]['firstKey'];
    let cancelStagedArtifactUploads: (() => Promise<void>) | null = null;
    try {
        capturedRequest = await captureAccountSettingsRequest({
            credentials,
            settingsScope,
            signal: params.signal,
        });
        if (!capturedRequest) return null;
        const accountId = capturedRequest.scope.accountId;
        const requireCurrentScope = (): void => {
            if (!capturedRequest?.isCurrent()) {
                throw new AccountEncryptionScopeChangedError();
            }
        };
        const homeRequest = capturedRequest.request;
        const target = capturedRequest.target;
        // Terminal cleanup remains bound to the old Home/Account even after its active scope retires.
        const cleanupRequest = createServerFetchAtEndpoint({ endpointUrl: target.serverUrl,
            serverId: target.serverId, credentials,
            ...(target.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
            ...(target.homeCarrier ? { homeCarrier: target.homeCarrier } : {}),
        });
        cancelStagedArtifactUploads = async () => {
            await Promise.allSettled([
                ...stagedArtifactUploads.map(uploadId => cancelArtifactBlobAccountEncryptionConversion(credentials, uploadId, { request: cleanupRequest })),
                ...stagedDiscussionUploads.map(uploadId => cancelDiscussionAttachmentAccountEncryptionConversion({ request: cleanupRequest, uploadId })),
            ]);
        };
        if (!capturedRequest.isCurrent()) return null;
        if (
            nextMode === 'e2ee'
            && isTokenOnlyAuthCredentials(
                credentials,
            )
        ) {
            const replayed =
                await retryPendingAccountEncryptionFirstKeyExternalAuth({
                    currentCredentials: credentials,
                    persistCredentials: params.persistCredentials,
                    target,
                    scopeGuard: capturedRequest,
                });
            if (replayed) {
                requireCurrentScope();
                return replayed;
            }
        }
        const currentness =
            await fetchAccountEncryptionCurrentness(
                credentials,
                { request: homeRequest },
            );
        if (!capturedRequest.isCurrent()) return null;
        requireCurrentScope();
        if (
            currentness.mode
            !== accountEncryptionMode
        ) {
            requireCurrentScope();
            throw new AccountEncryptionModeChangedError(currentness.mode);
        }
        if (currentness.mode === nextMode) return { mode: currentness.mode };
        if (nextMode === 'plain' && !sourceEncryption) {
            throw new Error('Account encryption material is unavailable for the E2EE-to-plaintext migration');
        }
        const connectedServiceProfiles = profile.connectedServicesV2.flatMap((svc) =>
            svc.profiles.map((p) => ({
                serviceId: ConnectedServiceIdSchema.parse(svc.serviceId),
                profileId: p.profileId,
            })),
        );
        const accountSecurity = await fetchAccountSecurity(homeRequest, params.signal);
        requireCurrentScope();
        const prepareKey = async () => {
            const expectedSigningKeyFingerprint = currentness.signingKeyFingerprint;
            const expectedContentKeyFingerprint = currentness.contentKeyFingerprint;
            const keyParams = { credentials, expectedSigningKeyFingerprint, expectedContentKeyFingerprint };
            try {
                return await prepareAccountEncryptionMigrateToE2eeKey(keyParams);
            } catch (error) {
                if (!(error instanceof HappyError) || error.code !== 'restore_required'
                    || !expectedSigningKeyFingerprint || !expectedContentKeyFingerprint) throw error;
                requireCurrentScope();
                const entered = await presentAccountRecoveryKeyEntry();
                try {
                    requireCurrentScope();
                    if (!entered) throw error;
                    return await prepareAccountEncryptionMigrateToE2eeKey({ ...keyParams, recoverySecret: entered });
                } finally {
                    entered?.fill(0);
                }
            }
        };
        const preparedE2eeKey = nextMode === 'e2ee' ? await prepareKey() : null;
        temporaryRecoverySecret = preparedE2eeKey?.seed;
        requireCurrentScope();
        const transitionPassword = accountSecurity.password.status === 'enrolled'
            ? await Modal.prompt(
                t('settingsAccount.nativePassword.password'),
                t('settingsAccount.nativePassword.passwordRequirements'),
                { inputType: 'secure-text' },
            )
            : null;
        requireCurrentScope();
        if (accountSecurity.password.status === 'enrolled' && transitionPassword === null) return null;
        const transitionCredentialRevision = accountSecurity.password.status === 'enrolled'
            ? accountSecurity.password.revision
            : null;
        const transitionChallengeAudience = accountSecurity.password.status === 'enrolled'
            ? resolveHomeKeyChallengeExpectedAudience({
                kind: 'saved_profile',
                profileRef: target.serverId,
            })
            : null;
        if (accountSecurity.password.status === 'enrolled' && transitionCredentialRevision === null) {
            throw new Error('Account password credential revision is unavailable');
        }
        if (accountSecurity.password.status === 'enrolled' && !transitionChallengeAudience) {
            throw new Error('Account password challenge audience is unavailable');
        }
        if (accountSecurity.password.status === 'enrolled' && !temporaryRecoverySecret) {
            if (isLegacyAuthCredentials(credentials)) {
                try {
                    temporaryRecoverySecret = decodeBase64(credentials.secret, 'base64url');
                } catch {
                    throw accountEncryptionRestoreRequired();
                }
            } else {
                if (!currentness.signingKeyFingerprint || !currentness.contentKeyFingerprint) {
                    throw accountEncryptionRestoreRequired();
                }
                temporaryRecoverySecret = (await prepareKey()).seed;
            }
            if (temporaryRecoverySecret.length !== 32) throw accountEncryptionRestoreRequired();
            requireCurrentScope();
        }
        const transitionSecret = temporaryRecoverySecret ?? null;
        const targetE2eePasswordCredential = transitionPassword !== null && transitionSecret && nextMode === 'e2ee'
            ? await prepareAccountEncryptionModePasswordCredential(homeRequest, {
                fromMode: 'plain', toMode: 'e2ee', password: transitionPassword,
                accountId,
                expectedCredentialRevision: transitionCredentialRevision!,
                normalizedNativeEmail: accountSecurity.nativeEmail,
                secret: transitionSecret,
                expectedAudience: transitionChallengeAudience!,
                scope: capturedRequest,
            })
                : null;
        requireCurrentScope();
        const targetEncryption =
            nextMode === 'e2ee'
                ? await createEncryptionFromAuthCredentials(
                    preparedE2eeKey!
                        .credentials,
                )
                : null;
        requireCurrentScope();
        const sessionModes = new Map<string, Readonly<{ sessionId: string; encryptionMode: 'plain' | 'e2ee' }>>();
        const [
            machineRows,
            todoRows,
            workspaceRows,
            artifactRows,
            sessionRows,
            reviewCommentsInventory,
            sessionOrganizationInventory,
            automationsInventory,
            discussionsInventory,
            privateLabelsInventory,
            managedMachinePresetsInventory,
        ] = await Promise.all([
            fetchLiveOwnedMachineRows({
                credentials,
                request: homeRequest,
                fresh: true,
                accountId,
            }),
            fetchAccountEncryptionMigrationKvInventory({ namespace: 'todo', credentials, request: homeRequest, scope: capturedRequest }),
            fetchAccountEncryptionMigrationKvInventory({ namespace: 'workspace', credentials, request: homeRequest, scope: capturedRequest }),
            fetchAccountEncryptionMigrationArtifactInventory({ credentials, request: homeRequest,
                scope: capturedRequest, encryptionMode: currentness.mode }),
            fetchAccountEncryptionMigrationSessionInventory({
                token: credentials.token,
                request: homeRequest,
                scope: capturedRequest,
                onSession: session => sessionModes.set(session.sessionId, session),
            }),
            fetchReviewCommentAccountEncryptionMigrationInventory({ request: homeRequest }),
            fetchSessionOrganizationAccountEncryptionMigrationInventory({ request: homeRequest }),
            fetchAccountEncryptionMigrationAutomationsInventory({ request: homeRequest }),
            fetchAccountEncryptionMigrationDiscussionInventory({ request: homeRequest, token: credentials.token, scope: capturedRequest }),
            fetchAccountEncryptionMigrationPrivateLabelInventory({ request: homeRequest, scope: capturedRequest }),
            fetchAccountEncryptionMigrationManagedMachinePresetsInventory({ request: homeRequest, scope: capturedRequest }),
        ]);
        requireCurrentScope();
        // The owner's Saved Secret materials: the migration reseals the ones it
        // owns with no grants. A Home without the resource route has none.
        const savedSecretCatalog = await readSavedSecretCatalog(capturedRequest.scope, params.signal);
        requireCurrentScope();
        if (!savedSecretCatalog.ok && savedSecretCatalog.failure.kind !== 'unsupported') {
            throw new Error('Saved Secret migration census is unavailable');
        }
        const automations = automationsInventory.templates.map(row => ({
            id: row.automationId, templateVersion: row.expectedTemplateVersion,
            templateCiphertext: row.templateCiphertext,
        }));
        const storageDirectives =
            await buildAccountEncryptionMigrationStorageDirectives({
                sourceAccountCurrentness: currentness,
                fromMode:
                    currentness.mode,
                toMode: nextMode,
                sourceEncryption:
                    nextMode === 'plain'
                        ? sourceEncryption
                        : null,
                targetEncryption,
                machines: machineRows,
                todos: todoRows,
                workspace: workspaceRows,
                artifacts: artifactRows,
                discussionsInventory,
                readDiscussionAttachment: (discussionId, messageId, blobId) => readDiscussionAttachmentStoredContent({
                    request: homeRequest, discussionId, messageId, blobId,
                }, params.signal),
                stageDiscussionAttachment: async (discussionId, messageId, blobId, content) => {
                    requireCurrentScope();
                    const staged = await stageDiscussionAttachmentAccountEncryptionConversion({
                        request: homeRequest, discussionId, messageId, blobId, content,
                    }, params.signal);
                    stagedDiscussionUploads.push(staged.uploadId);
                    requireCurrentScope();
                    return staged;
                },
                readArtifactRecipients: createArtifactAccessApi(credentials, { request: homeRequest }).readRecipients,
                readArtifactBlob: (artifactId, blobId) => fetchArtifactBlob(credentials, artifactId, blobId, currentness.mode, { request: homeRequest }),
                savedSecretResources: savedSecretCatalog.ok ? savedSecretCatalog.resources : undefined,
                stageArtifactBlob: async (artifactId, blobId, content) => {
                    requireCurrentScope();
                    const staged = await stageArtifactBlobAccountEncryptionConversion(credentials, artifactId, blobId, content, { request: homeRequest });
                    stagedArtifactUploads.push(staged.uploadId);
                    requireCurrentScope();
                    return staged;
                },
                sessions: sessionRows,
                reviewCommentsInventory,
                sessionOrganizationInventory,
                automationsInventory,
                privateLabels: privateLabelsInventory,
                managedMachinePresetsInventory,
                resolveSession: async sessionId => sessionModes.get(sessionId) ?? null,
                sessionSourceCredentials:
                    credentials,
                sessionTargetCredentials:
                    preparedE2eeKey
                        ?.credentials
                    ?? null,
                scope: capturedRequest,
            });
        const sessionDraftScope = sessionDraftSyncEnabled
            ? settingsScope
            : null;
        const sessionDrafts = sessionDraftScope
            ? listNewSessionDraftEncryptionMigrationCandidates(
                sessionDraftScope,
            )
            : [];
        const authoringMemory = await fetchAccountEncryptionAuthoringMemoryMigrationCandidates({
            credentials, mode: currentness.mode, request: homeRequest,
        });
        const sessionFollowRules = await fetchAccountEncryptionSessionFollowRulesMigrationCandidates({
            credentials, mode: currentness.mode, request: homeRequest, assertCurrent: requireCurrentScope,
        });
        const projectRows = await fetchAccountEncryptionProjectRowsMigrationCandidates({
            credentials, mode: currentness.mode, request: homeRequest,
        });
        const workspaceExecutionConfig = await fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates({
            credentials, mode: currentness.mode, request: homeRequest,
        });
        const profileRows = await readProfileCatalog(capturedRequest.scope);
        const promptLibraryProjection = await readPromptLibraryCatalogProjection(capturedRequest.scope);
        requireCurrentScope();
        if (promptLibraryProjection.catalog.status !== 'ready') {
            throw new Error('Prompt library migration census is unavailable');
        }
        const promptLibrary = promptLibraryProjection.catalog.rows;
        const acpCatalog = await fetchAccountEncryptionAcpCatalogMigrationCandidate({
            credentials, mode: currentness.mode, request: homeRequest, assertCurrent: requireCurrentScope,
        });
        const mcpServerCatalog = await fetchAccountEncryptionMcpServerCatalogMigrationCandidate({
            credentials, mode: currentness.mode, request: homeRequest, assertCurrent: requireCurrentScope,
        });
        const providerCatalog = await readProviderCatalog(capturedRequest.scope, undefined, requireCurrentScope);
        requireCurrentScope();
        if (providerCatalog.status !== 'ready') {
            throw new Error('Provider catalog migration census is unavailable');
        }
        const providerConnections = await fetchAccountEncryptionProviderConnectionsMigrationCandidate({
            credentials, mode: currentness.mode, request: homeRequest,
        });
        requireCurrentScope();
        const connectedCatalogs = await fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates({
            credentials, mode: currentness.mode, request: homeRequest, assertCurrent: requireCurrentScope,
        });
        requireCurrentScope();
        const projectTrust = await fetchAccountEncryptionProjectTrustMigrationCandidates({ credentials, mode: currentness.mode, request: homeRequest });
        requireCurrentScope();
        const entityCatalogs = await fetchAccountEncryptionEntityCatalogMigrationCandidates({
            credentials, mode: currentness.mode, capturedRequest,
        });
        requireCurrentScope();
        // Catalog admission can atomically transfer retained roots and
        // advance Settings; capture its conversion revision only afterward.
        const settingsBaseline = await readAccountSettingsBaseline({
            credentials, encryption: sourceEncryption, accountMode: currentness.mode,
            request: homeRequest,
        });
        requireCurrentScope();
        const rawSettings = settingsBaseline.raw;
        const settings = settingsParse(rawSettings ?? {});
        const expectedSettingsVersion = settingsBaseline.version;
        const settingsHistory: AccountEncryptionSettingsHistoryMigrationCandidate[] = [];
        let beforeVersion: number | null = null;
        do {
            requireCurrentScope();
            const query = beforeVersion === null ? '' : `?beforeVersion=${beforeVersion}`;
            const response = await homeRequest(`/v1/account/encryption/migrate/settings-history/inventory${query}`,
                { method: 'GET' }, { includeAuth: true, retry: 'none' });
            requireCurrentScope();
            if (!response.ok) throw accountEncryptionSettingsHistoryUnavailable();
            const page = AccountEncryptionMigrateSettingsHistoryInventoryPageSchema.safeParse(await response.json().catch(() => null));
            requireCurrentScope();
            if (!page.success) throw accountEncryptionSettingsHistoryUnavailable();
            for (const row of page.data.items) {
                if (settingsHistory.length > 0 && row.version >= settingsHistory[settingsHistory.length - 1]!.version) {
                    throw accountEncryptionSettingsHistoryUnavailable();
                }
                settingsHistory.push(row);
            }
            if (page.data.nextBeforeVersion !== null && (page.data.items.at(-1)?.version !== page.data.nextBeforeVersion
                || (beforeVersion !== null && page.data.nextBeforeVersion >= beforeVersion))) {
                throw accountEncryptionSettingsHistoryUnavailable();
            }
            beforeVersion = page.data.nextBeforeVersion;
        } while (beforeVersion !== null);
        // Catalog admission can initialize rows and advance the Account cursor.
        // Capture that cursor after the census, before signing; source key
        // fingerprints stay bound to the material used to open the inventory.
        const { version: expectedAccountVersion } = await fetchAccountEncryptionCurrentness(credentials, { request: homeRequest });
        requireCurrentScope();
        let request: AccountEncryptionMigrateRequest = nextMode === 'plain'
            ? await buildAccountEncryptionMigrateToPlainRequest({
                credentials,
                expectedAccountVersion,
                expectedSigningKeyFingerprint:
                    currentness
                        .signingKeyFingerprint,
                expectedContentKeyFingerprint:
                    currentness
                        .contentKeyFingerprint,
                storageDirectives,
                expectedSettingsVersion,
                settings,
                rawSettings,
                settingsHistory,
                connectedServiceProfiles,
                qualifiedConnectedAccounts:
                    profile.connectedAccountsV4,
                automations,
                sessionDrafts,
                authoringMemory,
                sessionFollowRules,
                projectRows,
                workspaceExecutionConfig,
                profileRows,
                promptLibrary,
                acpCatalog,
                mcpServerCatalog,
                providerConnections,
                ...entityCatalogs,
                ...connectedCatalogs,
                projectTrust,
                fetchConnectedServiceCredentialSealed: async ({ serviceId, profileId }) =>
                    await getConnectedServiceCredentialSealed(credentials, { serviceId, profileId }, { request: homeRequest }),
                fetchQualifiedConnectedAccountCredential: async (ref) =>
                    await getQualifiedConnectedAccountCredentialV4(credentials, ref, { request: homeRequest }),
                fetchQualifiedConnectedAccountConfiguration: async (ref) =>
                    await getQualifiedConnectedAccountConfigurationV4(credentials, ref, { request: homeRequest }),
                decryptAutomationTemplateRaw: async (payloadCiphertext: string) =>
                    await sourceEncryption!.decryptAutomationTemplateRaw(payloadCiphertext),
                resolveSession: async sessionId => sessionModes.get(sessionId) ?? null,
            })
            : await buildAccountEncryptionMigrateToE2eeRequest({
                credentials:
                    preparedE2eeKey!
                        .credentials,
                accountId,
                expectedAccountVersion,
                expectedSigningKeyFingerprint:
                    currentness
                        .signingKeyFingerprint,
                expectedContentKeyFingerprint:
                    currentness
                        .contentKeyFingerprint,
                storageDirectives,
                expectedSettingsVersion,
                settings,
                rawSettings,
                settingsHistory,
                connectedServiceProfiles,
                qualifiedConnectedAccounts:
                    profile.connectedAccountsV4,
                automations,
                sessionDrafts,
                authoringMemory,
                sessionFollowRules,
                projectRows,
                workspaceExecutionConfig,
                profileRows,
                promptLibrary,
                acpCatalog,
                mcpServerCatalog,
                providerConnections,
                ...entityCatalogs,
                ...connectedCatalogs,
                projectTrust,
                keyProof:
                    preparedE2eeKey!
                        .keyProof,
                ...(targetE2eePasswordCredential
                    ? { passwordCredential: targetE2eePasswordCredential }
                    : {}),
                fetchConnectedServiceCredentialPlain: async ({ serviceId, profileId }) =>
                    await getConnectedServiceCredentialPlain(credentials, { serviceId, profileId }, { request: homeRequest }),
                fetchQualifiedConnectedAccountCredential: async (ref) =>
                    await getQualifiedConnectedAccountCredentialV4(credentials, ref, { request: homeRequest }),
                fetchQualifiedConnectedAccountConfiguration: async (ref) =>
                    await getQualifiedConnectedAccountConfigurationV4(credentials, ref, { request: homeRequest }),
            });
        requireCurrentScope();
        if (transitionPassword !== null && transitionSecret && nextMode === 'plain') {
            const passwordCredential = await prepareAccountEncryptionModePasswordCredential(homeRequest, {
                fromMode: 'e2ee', toMode: 'plain', password: transitionPassword,
                accountId,
                expectedCredentialRevision: transitionCredentialRevision!,
                normalizedNativeEmail: accountSecurity.nativeEmail,
                secret: transitionSecret,
                expectedAudience: transitionChallengeAudience!,
                baseRequest: request,
                scope: capturedRequest,
            });
            requireCurrentScope();
            request = AccountEncryptionMigrateRequestSchema.parse({ ...request, passwordCredential });
        }
        // A retained-key Plain Account with a password proves the
        // current password for this exact request (L02-R22); the
        // keyless first-key journey below obtains the same proof.
        if (transitionPassword !== null && nextMode === 'e2ee'
            && !preparedE2eeKey!.requiresExternalAuthProof) {
            const externalAuthProof = await requestAccountEncryptionFirstKeyPasswordProof({
                request: homeRequest,
                token: credentials.token,
                password: transitionPassword,
                requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({
                    request,
                    accountId,
                    sourceMode: 'plain',
                }),
            });
            requireCurrentScope();
            request = AccountEncryptionMigrateRequestSchema.parse({ ...request, externalAuthProof });
        }

        const result =
            nextMode === 'e2ee'
            && preparedE2eeKey!
                .requiresExternalAuthProof
                ? await (async () => {
                    firstKeyArtifactCustody = { accountId, request, target };
                    const externalAuth =
                        await startAccountEncryptionFirstKeyExternalAuth({
                            accountId:
                                accountId,
                            currentCredentials:
                                credentials,
                            proposedCredentials:
                                preparedE2eeKey!
                                    .credentials,
                            request,
                            linkedProviderIds:
                                (
                                    profile
                                        .linkedProviders
                                    ?? []
                                ).map(
                                    (
                                        provider,
                                    ) =>
                                        provider.id,
                                ),
                            returnTo:
                                '/settings/account/security',
                            target,
                            ...(transitionPassword !== null
                                ? { nativePassword: transitionPassword }
                                : {}),
                        });
                    if (
                        externalAuth.kind
                        === 'oauth'
                    ) {
                        requireCurrentScope();
                        await openAccountEncryptionFirstKeyExternalAuthUrl(
                            externalAuth.url,
                        );
                            return 'interaction_opened' as const;
                    }
                    const resumed =
                        await resumeAccountEncryptionFirstKeyExternalAuth({
                            provider: externalAuth.externalAuthProof.provider,
                            pending: externalAuth.externalAuthProof.pending,
                            currentCredentials: credentials,
                            persistCredentials: params.persistCredentials,
                            target,
                            scopeGuard: capturedRequest,
                        });
                    requireCurrentScope();
                    return resumed.migration;
                })()
                : await runAccountEncryptionModeMigration({
                    request,
                    migrate: async (migrationRequest) =>
                        await migrateAccountEncryptionMode(
                            credentials,
                            migrationRequest,
                            { request: (path, init, options) => homeRequest(path, init, {
                                ...options, onIssued: () => { retainStagedArtifactUploads = true; },
                            }), target },
                        ),
                    isCurrent: capturedRequest.isCurrent,
                    activateTargetMode: () => {
                        if (!capturedRequest?.isCurrent()) return;
                        sync.reconfigureAuthoringMemoryForAccountMode(
                            nextMode === 'e2ee' ? preparedE2eeKey!.credentials : credentials,
                            nextMode,
                        );
                        sync.reconfigureSessionDraftRepositoryForAccountMode(
                            nextMode === 'e2ee'
                                ? preparedE2eeKey!.credentials
                                : credentials,
                            nextMode,
                        );
                    },
                    acknowledgeSessionDrafts: async (records) => {
                        if (!capturedRequest?.isCurrent()) return;
                        if (!sessionDraftScope) {
                            throw new Error(
                                'Session draft repository scope is unavailable',
                            );
                        }
                        await acknowledgeNewSessionDraftEncryptionMigration(
                            sessionDraftScope,
                            records,
                        );
                    },
                });

        // The migration acknowledgement remains an external fact after a Home switch.
        // runAccountEncryptionModeMigration already retires local activation and draft acknowledgements.
        if (result === 'interaction_opened') return result;
        if (!result) return null;
        // This device's own committed transition reclassifies its material:
        // retained keys keep reading encrypted history on a plain Account, and
        // a retained-key re-enable makes them active again. A failed write
        // leaves the downgrade lock, whose in-place action reclassifies.
        await persistAccountE2eeMaterialCustody({
            credentials,
            custody: result.mode === 'plain' ? 'historical' : 'active',
            captured: capturedRequest,
            persistCredentials: params.persistCredentials,
        });
        return { mode: result.mode };

    } catch (error) {
        retainStagedArtifactUploads = await shouldRetainAccountEncryptionMigrationArtifactUploads({
            error, migrationIssued: retainStagedArtifactUploads, firstKey: firstKeyArtifactCustody,
        });
        if (!retainStagedArtifactUploads) await cancelStagedArtifactUploads?.();
        if (error instanceof AccountEncryptionMachineKeyUnavailableError && capturedRequest?.isCurrent()) {
            const machines = storage.getState().machineListByServerId[capturedRequest.scope.serverId];
            const machine = machines?.find(row => row.id === error.machineId);
            const name = machine && readMachineName(machine) ? getMachineDisplayName(machine, machines ?? undefined) : error.machineId;
            throw new HappyError(t('settingsAccount.encryptionMachineKeyUnavailable', { name }), false, {
                code: error.code,
                cause: error,
            });
        }
        throw error;
    } finally {
        temporaryRecoverySecret?.fill(0);
        capturedRequest?.dispose();
    }
}
