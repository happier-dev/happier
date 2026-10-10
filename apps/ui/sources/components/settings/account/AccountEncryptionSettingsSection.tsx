import React, { useMemo, useState } from 'react';
import { useAuth } from '@/auth/context/AuthContext';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useProfile, useSettingMutable } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Switch } from '@/components/ui/forms/Switch';
import { HappyError } from '@/utils/errors/errors';
import { isLegacyAuthCredentials, isTokenOnlyAuthCredentials } from '@/auth/storage/tokenStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { fetchAccountEncryptionCurrentness, fetchAccountEncryptionMode, getAccountEncryptionModeScopeKey } from '@/sync/api/account/apiAccountEncryptionMode';
import { migrateAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMigrate';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildAccountEncryptionMigrateToPlainRequest } from '@/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest';
import { getConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
import { buildAccountEncryptionMigrateToE2eeRequest } from '@/sync/ops/account/buildAccountEncryptionMigrateToE2eeRequest';
import { getConnectedServiceCredentialPlain } from '@/sync/api/account/apiConnectedServicesV3';
import { getQualifiedConnectedAccountConfigurationV4, getQualifiedConnectedAccountCredentialV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { AccountEncryptionMigrateInvalidParamsReasonSchema, AccountEncryptionMigrateRequestSchema, createAccountEncryptionMigrateRequestBindingDigestV1, type AccountEncryptionMigrateRequest } from '@happier-dev/protocol/account/encryptionMigrate';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { fetchMachineRows } from '@/sync/engine/machines/syncMachines';
import { fetchAccountEncryptionMigrationKvInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationKvInventory';
import { createArtifactAccessApi, fetchArtifactBlob,
    stageArtifactBlobAccountEncryptionConversion, cancelArtifactBlobAccountEncryptionConversion } from '@/sync/api/artifacts/apiArtifacts';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { buildAccountEncryptionMigrationStorageDirectives } from '@/sync/ops/account/buildAccountEncryptionMigrationStorageDirectives';
import { fetchAccountEncryptionMigrationSessionInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationSessionInventory';
import { fetchAccountEncryptionMigrationArtifactInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationArtifactInventory';
import { fetchAccountEncryptionMigrationAutomationsInventory } from '@/sync/ops/account/fetchAccountEncryptionMigrationAutomationsInventory';
import { fetchReviewCommentAccountEncryptionMigrationInventory } from '@/sync/domains/reviews/comments/accountEncryptionMigrationApi';
import { fetchSessionOrganizationAccountEncryptionMigrationInventory } from '@/sync/ops/account/fetchSessionOrganizationAccountEncryptionMigrationInventory';
import { prepareAccountEncryptionMigrateToE2eeKey } from '@/sync/ops/account/prepareAccountEncryptionMigrateToE2eeKey';
import { openAccountEncryptionFirstKeyExternalAuthUrl, requestAccountEncryptionFirstKeyPasswordProof, retryPendingAccountEncryptionFirstKeyExternalAuth, resumeAccountEncryptionFirstKeyExternalAuth, startAccountEncryptionFirstKeyExternalAuth,
    shouldRetainAccountEncryptionMigrationArtifactUploads } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { acknowledgeNewSessionDraftEncryptionMigration, listNewSessionDraftEncryptionMigrationCandidates } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates';
import { fetchAccountEncryptionProjectTrustMigrationCandidates } from '@/sync/ops/account/fetchAccountEncryptionProjectTrustMigrationCandidates';
import { runAccountEncryptionModeMigration } from '@/sync/ops/account/runAccountEncryptionModeMigration';
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
import { createAccountSecurityActionClient } from './accountSecurityActionClient';
import { captureAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveHomeKeyChallengeExpectedAudience } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { resolveUiClientEncryptionRequirement } from '@/sync/domains/settings/clientEncryptionRequirement';
import { Icon } from '@/components/ui/icons/Icon';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { AccountHistoricalEncryptionKeyForgetResultV1Schema, AccountEncryptionAutomationTemplatesRecoverResultV1Schema } from '@happier-dev/protocol/auth/accountSecurity';

type AccountEncryptionModePresentation = Readonly<{
    scope: string | null;
    mode: 'e2ee' | 'plain' | null;
    recoveryRequired: boolean;
}>;

class AccountEncryptionScopeChangedError extends Error {
    constructor() {
        super('Account encryption scope changed');
        this.name = 'AccountEncryptionScopeChangedError';
    }
}

export const AccountEncryptionSettingsSection = React.memo(function AccountEncryptionSettingsSection() {
    const auth = useAuth();
    const executeAction = useMemo(() => createFrontDoorActionExecute(), []);
    const router = useRouter();
    const profile = useProfile();
    const [clientEncryptionRequirement, setClientEncryptionRequirement] = useSettingMutable('clientEncryptionRequirementV1');
    const [clientEncryptionRequirementLocal, setClientEncryptionRequirementLocal] = useSettingMutable('clientEncryptionRequirementLocalV1');
    const encryptionAccountOptOutEnabled = useFeatureEnabled('encryption.accountOptOut');
    const sessionDraftSyncEnabled = useFeatureEnabled('sessions.drafts');
    const activeServer = useActiveServerSnapshot();
    const accountEncryptionScope = auth.credentials
        ? getAccountEncryptionModeScopeKey(auth.credentials, activeServer)
        : null;

    const [accountEncryptionPresentation, setAccountEncryptionPresentation] =
        useState<AccountEncryptionModePresentation>({
            scope: null,
            mode: null,
            recoveryRequired: false,
        });
    const [accountEncryptionModeLoading, setAccountEncryptionModeLoading] = useState(false);
    const [accountEncryptionModeSaving, setAccountEncryptionModeSaving] = useState(false);
    const accountEncryptionPresentationIsCurrent =
        accountEncryptionScope !== null
        && accountEncryptionPresentation.scope === accountEncryptionScope;
    const accountEncryptionMode = accountEncryptionPresentationIsCurrent
        ? accountEncryptionPresentation.mode
        : null;
    const accountEncryptionRecoveryRequired =
        accountEncryptionPresentationIsCurrent
        && accountEncryptionPresentation.recoveryRequired;
    const effectiveClientEncryptionRequirement = resolveUiClientEncryptionRequirement({
        syncedSettings: { clientEncryptionRequirementV1: clientEncryptionRequirement },
        localSettings: { clientEncryptionRequirementLocalV1: clientEncryptionRequirementLocal },
    });
    const publishAccountEncryptionPresentation = React.useCallback(
        (
            scope: string | null,
            mode: 'e2ee' | 'plain' | null,
            recoveryRequired = false,
        ) => {
            setAccountEncryptionPresentation({
                scope,
                mode,
                recoveryRequired,
            });
        },
        [],
    );
    const firstKeyRecoveryAttemptedTokenRef =
        React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!encryptionAccountOptOutEnabled && (!auth.credentials || !isLegacyAuthCredentials(auth.credentials))) return;
        const credentials = auth.credentials;
        const presentationScope = accountEncryptionScope;
        if (!credentials?.token || !presentationScope) return;
        const target = activeServer.serverId && activeServer.serverUrl
            ? {
                serverId: activeServer.serverId,
                serverUrl: activeServer.serverUrl,
                ...(activeServer.runtimeOrigin ? { runtimeOrigin: activeServer.runtimeOrigin } : {}),
            }
            : undefined;

        let cancelled = false;
        const handleAccountEncryptionModeError = async (
            error: unknown,
        ): Promise<void> => {
            if (cancelled) return;
            if (
                error instanceof HappyError
                && error.code === 'account-encryption-recovery-required'
            ) {
                publishAccountEncryptionPresentation(
                    presentationScope,
                    null,
                    true,
                );
                return;
            }
            await Modal.alertAsync(
                t('common.error'),
                error instanceof HappyError
                    ? error.message
                    : t(
                        'settingsAccount.encryptionUpdateFailed',
                    ),
            );
        };
        setAccountEncryptionModeLoading(true);
        publishAccountEncryptionPresentation(
            presentationScope,
            null,
            false,
        );
        fetchAccountEncryptionMode(credentials)
            .then(async (res) => {
                if (cancelled) return;
                try {
                    // Account mode alone does not retire keys still held for encrypted history.
                    publishAccountEncryptionPresentation(
                        presentationScope,
                        res.mode,
                    );
                    const recoveryAttemptKey =
                        isLegacyAuthCredentials(credentials)
                            ? [
                                credentials.token,
                                credentials.secret,
                            ].join('\u0000')
                            : credentials.token;
                    if (
                        res.mode !== 'e2ee'
                        || firstKeyRecoveryAttemptedTokenRef.current
                            === recoveryAttemptKey
                    ) {
                        return;
                    }
                    firstKeyRecoveryAttemptedTokenRef.current =
                        recoveryAttemptKey;
                    const replayed =
                        await retryPendingAccountEncryptionFirstKeyExternalAuth({
                            currentCredentials: credentials,
                            persistCredentials:
                                auth.loginWithCredentials,
                            ...(target ? { target } : {}),
                            scopeGuard: { isCurrent: () => !cancelled },
                        });
                    if (cancelled || !replayed) return;
                    publishAccountEncryptionPresentation(
                        presentationScope,
                        replayed.mode,
                    );
                } catch (error) {
                    await handleAccountEncryptionModeError(error);
                }
            })
            .catch(handleAccountEncryptionModeError)
            .finally(() => {
                if (cancelled) return;
                setAccountEncryptionModeLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [
        auth.credentials,
        accountEncryptionScope,
        activeServer.runtimeOrigin,
        activeServer.serverId,
        activeServer.serverUrl,
        encryptionAccountOptOutEnabled,
        publishAccountEncryptionPresentation,
    ]);

    const recoverOlderAutomationTemplates = async (): Promise<void> => {
        const settingsScope = getActiveServerAccountScope();
        if (!settingsScope || accountEncryptionModeSaving) return;
        setAccountEncryptionModeSaving(true);
        try {
            const result = await executeAction('account.encryption.automationTemplates.recover', {}, {
                surface: 'ui', serverId: settingsScope.serverId, expectedAccountId: settingsScope.accountId,
            });
            if (!result.ok) {
                if (result.errorCode === 'action_account_scope_changed') return;
                throw new Error(result.error);
            }
            const outcome = AccountEncryptionAutomationTemplatesRecoverResultV1Schema.parse(result.result);
            await Modal.alertAsync(t('common.success'), t(outcome.templates.every(template => template.status === 'recovered' || template.status === 'already_plain')
                ? 'settingsAccount.recoverAutomationTemplatesComplete' : 'settingsAccount.recoverAutomationTemplatesRetained'));
        } catch (error) {
            await Modal.alertAsync(t('common.error'), error instanceof HappyError ? error.message : t('settingsAccount.encryptionUpdateFailed'));
        } finally {
            setAccountEncryptionModeSaving(false);
        }
    };

    const forgetHistoricalEncryptionKey = async (): Promise<void> => {
        const settingsScope = getActiveServerAccountScope();
        if (!settingsScope || accountEncryptionModeSaving) return;
        setAccountEncryptionModeSaving(true);
        try {
            const result = await executeAction('account.encryption.historicalKey.forget', {}, {
                surface: 'ui', serverId: settingsScope.serverId, expectedAccountId: settingsScope.accountId,
            });
            if (!result.ok) {
                if (result.errorCode === 'action_account_scope_changed') return;
                throw new Error(result.error);
            }
            const outcome = AccountHistoricalEncryptionKeyForgetResultV1Schema.parse(result.result);
            if (outcome.status === 'forgotten') await Modal.alertAsync(t('common.success'), t('settingsAccount.forgetEncryptionKeyComplete'));
        } catch (error) {
            await Modal.alertAsync(t('common.error'), error instanceof HappyError ? error.message : t('settingsAccount.forgetEncryptionKeyFailed'));
        } finally {
            setAccountEncryptionModeSaving(false);
        }
    };

    return (<>
                {/* Analytics Section */}
                {encryptionAccountOptOutEnabled && (
                    <ItemGroup title={t('terminal.encryption')}>
                        <Item
                            title={t('settingsAccount.requireE2ee')}
                            subtitle={t('settingsAccount.requireE2eeDescription')}
                            rightElement={
                                <Switch
                                    testID="settings-account-client-encryption-requirement-switch"
                                    value={effectiveClientEncryptionRequirement === 'require_e2ee'}
                                    disabled={
                                        accountEncryptionModeLoading
                                        || accountEncryptionModeSaving
                                        || accountEncryptionMode == null
                                    }
                                    onValueChange={async (enabled) => {
                                        if (enabled && accountEncryptionMode !== 'e2ee') {
                                            await Modal.alertAsync(
                                                t('settingsAccount.requireE2eeNeedsEncryptionTitle'),
                                                t('settingsAccount.requireE2eeNeedsEncryptionDescription'),
                                            );
                                            return;
                                        }
                                        const nextRequirement = enabled ? 'require_e2ee' : 'follow_account';
                                        if (enabled) {
                                            setClientEncryptionRequirementLocal(nextRequirement);
                                            setClientEncryptionRequirement(nextRequirement);
                                        } else {
                                            setClientEncryptionRequirement(nextRequirement);
                                            setClientEncryptionRequirementLocal(nextRequirement);
                                        }
                                    }}
                                />
                            }
                            showChevron={false}
                        />
                        <Item
                            testID="settings-account-encryption-mode"
                            title={t('terminal.endToEndEncrypted')}
                            // While the mode is read the switch waits disabled; no "Loading…" value.
                            detail={accountEncryptionModeSaving ? t('identityAdministration.saving') : undefined}
                            loading={accountEncryptionModeSaving}
                            accessibilityLiveRegion={accountEncryptionModeSaving || accountEncryptionModeLoading ? 'polite' : undefined}
                            rightElement={
                                <Switch
                                    testID="settings-account-encryption-mode-switch"
                                    value={(accountEncryptionMode ?? 'e2ee') === 'e2ee'}
                                    disabled={
                                        accountEncryptionModeLoading ||
                                        accountEncryptionModeSaving ||
                                        effectiveClientEncryptionRequirement === 'require_e2ee' ||
                                        !auth.credentials ||
                                        accountEncryptionMode == null
                                    }
                                    accessibilityState={{
                                        disabled: accountEncryptionModeSaving,
                                        busy: accountEncryptionModeSaving,
                                    }}
                                    onValueChange={async (enabled) => {
                                        if (!auth.credentials) return;
                                        if (accountEncryptionMode == null) return;
                                        const credentials = auth.credentials;
                                        const presentationScope =
                                            accountEncryptionScope;
                                        const nextMode = enabled ? 'e2ee' : 'plain';
                                        const sourceEncryption = sync.encryption;

                                        setAccountEncryptionModeSaving(true);
                                        announceAccessibilityMessage(t('identityAdministration.saving'));
                                        let capturedRequest: Awaited<ReturnType<typeof captureAccountSettingsRequest>> = null;
                                        const stagedArtifactUploads: string[] = [];
                                        let retainStagedArtifactUploads = false;
                                        let firstKeyArtifactCustody: Parameters<typeof shouldRetainAccountEncryptionMigrationArtifactUploads>[0]['firstKey'];
                                        let cancelStagedArtifactUploads: (() => Promise<void>) | null = null;
                                        try {
                                            const settingsScope = getActiveServerAccountScope();
                                            if (!settingsScope) return;
                                            capturedRequest = await captureAccountSettingsRequest({
                                                credentials,
                                                settingsScope,
                                            });
                                            if (!capturedRequest) return;
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
                                                await Promise.allSettled(stagedArtifactUploads.map(uploadId =>
                                                    cancelArtifactBlobAccountEncryptionConversion(credentials, uploadId, { request: cleanupRequest })));
                                            };
                                            const accountSecurityClient = createAccountSecurityActionClient({
                                                resolveServerId: () => capturedRequest?.scope.serverId ?? target.serverId,
                                            });
                                            if (!capturedRequest.isCurrent()) return;
                                            if (
                                                nextMode === 'e2ee'
                                                && isTokenOnlyAuthCredentials(
                                                    credentials,
                                                )
                                            ) {
                                                const replayed =
                                                    await retryPendingAccountEncryptionFirstKeyExternalAuth({
                                                        currentCredentials: credentials,
                                                        persistCredentials: auth.loginWithCredentials,
                                                        target,
                                                        scopeGuard: capturedRequest,
                                                    });
                                                if (replayed) {
                                                    requireCurrentScope();
                                                    publishAccountEncryptionPresentation(
                                                        presentationScope,
                                                        replayed.mode,
                                                    );
                                                    announceAccessibilityMessage(t('common.success'));
                                                    return;
                                                }
                                            }
                                            if (nextMode === 'plain' && !sourceEncryption) {
                                                throw new Error(
                                                    'Account encryption material is unavailable for the E2EE-to-plaintext migration',
                                                );
                                            }
                                            const currentness =
                                                await fetchAccountEncryptionCurrentness(
                                                    credentials,
                                                    { request: homeRequest },
                                                );
                                            if (!capturedRequest.isCurrent()) return;
                                            requireCurrentScope();
                                            if (
                                                currentness.mode
                                                !== accountEncryptionMode
                                            ) {
                                                requireCurrentScope();
                                                publishAccountEncryptionPresentation(
                                                    presentationScope,
                                                    currentness.mode,
                                                );
                                                throw new Error(
                                                    'Account encryption mode changed while preparing the migration',
                                                );
                                            }
                                            const connectedServiceProfiles = profile.connectedServicesV2.flatMap((svc) =>
                                                svc.profiles.map((p) => ({
                                                    serviceId: svc.serviceId as any,
                                                    profileId: p.profileId,
                                                })),
                                            );
                                            const preparedE2eeKey =
                                                nextMode === 'e2ee'
                                                    ? await prepareAccountEncryptionMigrateToE2eeKey({
                                                        credentials,
                                                        expectedSigningKeyFingerprint:
                                                            currentness
                                                                .signingKeyFingerprint,
                                                        expectedContentKeyFingerprint:
                                                            currentness
                                                                .contentKeyFingerprint,
                                                    })
                                                    : null;
                                            requireCurrentScope();
                                            const accountSecurity = await accountSecurityClient.read();
                                            requireCurrentScope();
                                            const transitionPassword = accountSecurity.password.status === 'enrolled'
                                                ? await Modal.prompt(
                                                    t('settingsAccount.nativePassword.password'),
                                                    t('settingsAccount.nativePassword.passwordRequirements'),
                                                    { inputType: 'secure-text' },
                                                )
                                                : null;
                                            requireCurrentScope();
                                            if (accountSecurity.password.status === 'enrolled' && transitionPassword === null) return;
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
                                            const transitionSecret = accountSecurity.password.status === 'enrolled'
                                                ? preparedE2eeKey?.seed ?? (() => {
                                                    if (!isLegacyAuthCredentials(credentials)) {
                                                        throw new Error('Account recovery material is unavailable for the password transition');
                                                    }
                                                    const decoded = decodeBase64(credentials.secret, 'base64url');
                                                    if (decoded.length !== 32) throw new Error('Account recovery material is invalid');
                                                    return decoded;
                                                })()
                                                : null;
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
                                            ] = await Promise.all([
                                                fetchMachineRows({
                                                    credentials,
                                                    request: homeRequest,
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
                                            ]);
                                            requireCurrentScope();
                                            const automations = automationsInventory.templates.map(row => ({
                                                id: row.automationId, templateVersion: row.expectedTemplateVersion,
                                                templateCiphertext: row.templateCiphertext,
                                            }));
                                            const storageDirectives =
                                                await buildAccountEncryptionMigrationStorageDirectives({
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
                                                    readArtifactRecipients: createArtifactAccessApi(credentials, { request: homeRequest }).readRecipients,
                                                    readArtifactBlob: (artifactId, blobId) => fetchArtifactBlob(credentials, artifactId, blobId, currentness.mode, { request: homeRequest }),
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
                                            const rawSettings = settingsBaseline.raw ?? {};
                                            const settings = settingsParse(rawSettings);
                                            const expectedSettingsVersion = settingsBaseline.version;
                                            let request: AccountEncryptionMigrateRequest = nextMode === 'plain'
                                                ? await buildAccountEncryptionMigrateToPlainRequest({
                                                    credentials,
                                                    expectedAccountVersion:
                                                        currentness.version,
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
                                                    connectedServiceProfiles,
                                                    qualifiedConnectedAccounts:
                                                        profile.connectedAccountsV4,
                                                    automations,
                                                    sessionDrafts,
                                                    authoringMemory,
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
                                                    expectedAccountVersion:
                                                        currentness.version,
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
                                                    connectedServiceProfiles,
                                                    qualifiedConnectedAccounts:
                                                        profile.connectedAccountsV4,
                                                    automations,
                                                    sessionDrafts,
                                                    authoringMemory,
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
                                                            return null;
                                                        }
                                                        const resumed =
                                                            await resumeAccountEncryptionFirstKeyExternalAuth({
                                                                provider: externalAuth.externalAuthProof.provider,
                                                                pending: externalAuth.externalAuthProof.pending,
                                                                currentCredentials: credentials,
                                                                persistCredentials: auth.loginWithCredentials,
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
                                            if (!result) return;
                                            if (!capturedRequest.isCurrent()) return;
                                            publishAccountEncryptionPresentation(
                                                presentationScope,
                                                result.mode,
                                            );
                                            announceAccessibilityMessage(t('common.success'));

                                        } catch (e) {
                                            retainStagedArtifactUploads = await shouldRetainAccountEncryptionMigrationArtifactUploads({
                                                error: e, migrationIssued: retainStagedArtifactUploads, firstKey: firstKeyArtifactCustody,
                                            });
                                            if (!retainStagedArtifactUploads) await cancelStagedArtifactUploads?.();
                                            if (e instanceof AccountEncryptionScopeChangedError) return;
                                            if (capturedRequest && !capturedRequest.isCurrent()) return;
                                            if (e instanceof HappyError) {
                                                if (nextMode === 'e2ee' && e.status === 400) {
                                                    if (
                                                        e.code === AccountEncryptionMigrateInvalidParamsReasonSchema.enum.restore_required
                                                    ) {
                                                        await Modal.alertAsync(
                                                            t('settingsAccount.restoreRequiredTitle'),
                                                            t('settingsAccount.restoreRequiredBody'),
                                                            [
                                                                {
                                                                    text: t('navigation.restoreWithSecretKey'),
                                                                    onPress: () => router.push('/restore/manual'),
                                                                },
                                                                {
                                                                    text: t('connect.lostAccessConfirmButton'),
                                                                    style: 'destructive',
                                                                    onPress: () => router.push('/restore/lost-access'),
                                                                },
                                                            ],
                                                        );
                                                        return;
                                                    }
                                                    if (e.code === AccountEncryptionMigrateInvalidParamsReasonSchema.enum.key_proof_required) {
                                                        await Modal.alertAsync(t('common.error'), t('settingsAccount.secretKeyMissing'));
                                                        return;
                                                    }
                                                }
                                                await Modal.alertAsync(t('common.error'), e.message);
                                                return;
                                            }
                                            await Modal.alertAsync(t('common.error'), t('settingsAccount.encryptionUpdateFailed'));
                                            announceAccessibilityMessage(t('common.error'));
                                            return;
                                        } finally {
                                            capturedRequest?.dispose();
                                            setAccountEncryptionModeSaving(false);
                                        }
                                    }}
                                />
                            }
                            showChevron={false}
                        />
                        {accountEncryptionMode === 'plain' && auth.credentials && !isTokenOnlyAuthCredentials(auth.credentials) && (
                            <>
                                <Item
                                    title={t('settingsAccount.recoverAutomationTemplates')}
                                    subtitle={t('settingsAccount.recoverAutomationTemplatesDescription')}
                                    showChevron={false}
                                    rightElement={<RoundButton testID="settings-account-encryption-recover-templates"
                                        title={t('settingsAccount.recoverAutomationTemplatesAction')} display="secondary" size="small"
                                        disabled={accountEncryptionModeLoading || accountEncryptionModeSaving}
                                        loading={accountEncryptionModeSaving} action={recoverOlderAutomationTemplates} />}
                                />
                                <Item
                                    title={t('settingsAccount.forgetEncryptionKey')}
                                    subtitle={t('settingsAccount.forgetEncryptionKeyDescription')}
                                    showChevron={false}
                                    accessoryLayout="stacked"
                                    rightElement={<RoundButton testID="settings-account-encryption-forget-key"
                                        title={t('settingsAccount.forgetEncryptionKeyAction')} display="destructive" size="small"
                                        disabled={accountEncryptionModeLoading || accountEncryptionModeSaving}
                                        loading={accountEncryptionModeSaving} action={forgetHistoricalEncryptionKey} />}
                                />
                            </>
                        )}
                    </ItemGroup>
                )}
                {accountEncryptionRecoveryRequired && (
                    <ItemGroup title={t('terminal.encryption')}>
                        <Item
                            testID="settings-account-encryption-recovery"
                            icon={<Icon name="key" />}
                            title={t('navigation.restoreWithSecretKey')}
                            subtitle={t('settingsAccount.restoreRequiredBody')}
                            onPress={() => router.push('/restore/manual')}
                        />
                    </ItemGroup>
                )}

    </>);
});
