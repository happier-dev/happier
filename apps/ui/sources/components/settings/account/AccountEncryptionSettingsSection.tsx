import React, { useMemo, useState } from 'react';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAuth } from '@/auth/context/AuthContext';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { ACCOUNT_SETTINGS } from './accountSettings';
import { Switch } from '@/components/ui/forms/Switch';
import { HappyError } from '@/utils/errors/errors';
import { isDataKeyAuthCredentials, isLegacyAuthCredentials, isTokenOnlyAuthCredentials, withAccountE2eeCustody } from '@/auth/storage/tokenStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { fetchAccountEncryptionMode, getAccountEncryptionModeScopeKey } from '@/sync/api/account/apiAccountEncryptionMode';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AccountEncryptionMigrateInvalidParamsReasonSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import { retryPendingAccountEncryptionFirstKeyExternalAuth } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveUiClientEncryptionRequirement } from '@/sync/domains/settings/clientEncryptionRequirement';
import { Icon } from '@/components/ui/icons/Icon';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { AccountEncryptionModeConversionFailureSchema, AccountEncryptionModeConversionResultSchema } from '@/sync/ops/account/convertAccountEncryptionMode';
import { AccountHistoricalEncryptionKeyForgetResultV1Schema, AccountEncryptionAutomationTemplatesRecoverResultV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { isAccountModeDowngradeUnverifiedError } from '@happier-dev/sync-client';
import { useUnistyles } from 'react-native-unistyles';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { captureAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';
import { persistAccountE2eeMaterialCustody } from '@/sync/ops/account/accountE2eeMaterialCustody';

type AccountEncryptionModePresentation = Readonly<{
    scope: string | null;
    mode: 'e2ee' | 'plain' | null;
    recoveryRequired: boolean;
    /** The Home reports plain while this device's keys are still active. */
    downgradeUnverified: boolean;
}>;


/** A refused switch changed nothing, so it is named as a refusal rather than an error. */
function encryptionRefusalTitle(error: unknown): string {
    return error instanceof HappyError && error.code === 'plugin_collections_not_empty'
        ? t('settingsAccount.encryptionPluginDataBlocksTitle') : t('common.error');
}
export const AccountEncryptionSettingsSection = React.memo(function AccountEncryptionSettingsSection() {
    const auth = useAuth();
    const { theme } = useUnistyles();
    const executeAction = useMemo(() => createFrontDoorActionExecute(), []);
    const router = useRouter();
    const clientEncryptionRequirement = useSetting('clientEncryptionRequirementV1');
    const clientEncryptionRequirementLocal = useSetting('clientEncryptionRequirementLocalV1');
    const { setSetting } = useSettingActionFeedback();
    const encryptionAccountOptOutEnabled = useFeatureEnabled('encryption.accountOptOut');
    const activeServer = useActiveServerSnapshot();
    // The presentation follows the Account, Home and key material. Reclassifying
    // this device's custody re-reads the mode without blanking its last value.
    const accountEncryptionScope = auth.credentials
        ? getAccountEncryptionModeScopeKey(isLegacyAuthCredentials(auth.credentials) || isDataKeyAuthCredentials(auth.credentials)
            ? withAccountE2eeCustody(auth.credentials, 'active') : auth.credentials, activeServer)
        : null;

    const [accountEncryptionPresentation, setAccountEncryptionPresentation] =
        useState<AccountEncryptionModePresentation>({
            scope: null,
            mode: null,
            recoveryRequired: false,
            downgradeUnverified: false,
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
    const accountEncryptionDowngradeUnverified =
        accountEncryptionPresentationIsCurrent
        && accountEncryptionPresentation.downgradeUnverified;
    const effectiveClientEncryptionRequirement = resolveUiClientEncryptionRequirement({
        syncedSettings: { clientEncryptionRequirementV1: clientEncryptionRequirement },
        localSettings: { clientEncryptionRequirementLocalV1: clientEncryptionRequirementLocal },
    });
    const publishAccountEncryptionPresentation = React.useCallback(
        (
            scope: string | null,
            mode: 'e2ee' | 'plain' | null,
            recoveryRequired = false,
            downgradeUnverified = false,
        ) => {
            setAccountEncryptionPresentation({
                scope,
                mode,
                recoveryRequired,
                downgradeUnverified,
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
            // The mode owner withdrew this read. Keep its response refused;
            // retirement does not represent a failed user operation.
            if (error instanceof HappyError && error.code === 'account-encryption-mode-read-retired') return;
            if (isAccountModeDowngradeUnverifiedError(error)) {
                publishAccountEncryptionPresentation(presentationScope, null, false, true);
                return;
            }
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
                encryptionRefusalTitle(error),
                error instanceof HappyError
                    ? error.message
                    : t(
                        'settingsAccount.encryptionUpdateFailed',
                    ),
            );
        };
        setAccountEncryptionModeLoading(true);
        setAccountEncryptionPresentation(previous => previous.scope === presentationScope
            ? { ...previous, recoveryRequired: false, downgradeUnverified: false }
            : { scope: presentationScope, mode: null, recoveryRequired: false, downgradeUnverified: false });
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
                await Modal.alertAsync(t('common.error'), resolveActionExecutionErrorMessage(
                    result, t('settingsAccount.encryptionUpdateFailed'),
                ));
                return;
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

    // A local human decision, deliberately not an Agent-invocable Action: a
    // Home's report alone must never move this device's keys to history.
    const keepEncryptionKeyAsHistory = async (): Promise<void> => {
        const settingsScope = getActiveServerAccountScope();
        const credentials = auth.credentials;
        if (!settingsScope || !credentials || accountEncryptionModeSaving) return;
        setAccountEncryptionModeSaving(true);
        const captured = await captureAccountSettingsRequest({ credentials, settingsScope }).catch(() => null);
        try {
            if (!captured) return;
            const kept = await persistAccountE2eeMaterialCustody({
                credentials, custody: 'historical', captured, persistCredentials: auth.loginWithCredentials,
            });
            if (!kept) throw new Error('Account encryption key custody was not saved');
        } catch {
            if (captured?.isCurrent()) await Modal.alertAsync(t('common.error'), t('settingsAccount.keepEncryptionKeyFailed'));
        } finally {
            captured?.dispose();
            setAccountEncryptionModeSaving(false);
        }
    };

    const keepEncryptionKeyRow = accountEncryptionDowngradeUnverified ? (
        <Item
            testID="settings-account-encryption-downgrade"
            title={t('settingsAccount.keepEncryptionKeyTitle')}
            subtitle={t('settingsAccount.keepEncryptionKeyDescription')}
            subtitleLeading={<StatusDot size={6} color={theme.colors.state.warning.foreground} />}
            showChevron={false}
            accessoryLayout="stacked"
            rightElement={<RoundButton testID="settings-account-encryption-keep-key"
                title={t('settingsAccount.keepEncryptionKeyAction')} size="small"
                loading={accountEncryptionModeSaving} action={keepEncryptionKeyAsHistory} />}
        />
    ) : null;

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
                await Modal.alertAsync(t('common.error'), resolveActionExecutionErrorMessage(
                    result, t('settingsAccount.forgetEncryptionKeyFailed'),
                ));
                return;
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
                        <SettingRow
                            setting={ACCOUNT_SETTINGS.settings.requireE2ee}
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
                                        await setSetting(ACCOUNT_SETTINGS.settings.requireE2ee, enabled);
                                    }}
                                />
                            }
                            showChevron={false}
                        />
                        <SettingRow
                            testID="settings-account-encryption-mode"
                            setting={ACCOUNT_SETTINGS.settings.encryptionMode}
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
                                        const presentationScope =
                                            accountEncryptionScope;
                                        const nextMode = enabled ? 'e2ee' : 'plain';
                                        const settingsScope = getActiveServerAccountScope();
                                        if (!settingsScope) return;
                                        const isCurrent = () => areAccountSettingsScopesEqual(settingsScope, getActiveServerAccountScope());
                                        setAccountEncryptionModeSaving(true);
                                        announceAccessibilityMessage(t('identityAdministration.saving'));
                                        try {
                                            const invocation = await executeAction('settings.invoke', {
                                                anchor: ACCOUNT_SETTINGS.settings.encryptionMode.anchor,
                                                input: { kind: 'account_encryption_mode_convert', toMode: nextMode },
                                            }, { surface: 'ui', serverId: settingsScope.serverId, expectedAccountId: settingsScope.accountId });
                                            if (!isCurrent()) return;
                                            if (!invocation.ok) {
                                                if (isActionApprovalDeclinedErrorCode(invocation.errorCode)) return;
                                                requireActionSuccess(invocation);
                                            }
                                            const outcome = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(invocation.result);
                                            if (outcome.status === 'cancelled' || outcome.status === 'interaction_opened') return;
                                            const value = outcome.value;
                                            if (outcome.status === 'unavailable') {
                                                const failure = AccountEncryptionModeConversionFailureSchema.safeParse(value);
                                                const detail = failure.success ? failure.data : null;
                                                if (detail?.mode) {
                                                    publishAccountEncryptionPresentation(presentationScope, detail.mode);
                                                }
                                                throw new HappyError(detail?.message ?? t('settingsAccount.encryptionUpdateFailed'), false, {
                                                    code: outcome.reason, ...(detail?.status !== undefined ? { status: detail.status } : {}),
                                                });
                                            }
                                            const converted = AccountEncryptionModeConversionResultSchema.safeParse(value);
                                            if (!converted.success) {
                                                throw new Error('Invalid Account conversion Action result');
                                            }
                                            publishAccountEncryptionPresentation(presentationScope, converted.data.mode);
                                            announceAccessibilityMessage(t('common.success'));
                                        } catch (e) {
                                            if (!isCurrent()) return;
                                            if (isAccountModeDowngradeUnverifiedError(e)) {
                                                publishAccountEncryptionPresentation(presentationScope, null, false, true);
                                                return;
                                            }
                                            if (e instanceof HappyError) {
                                                if (nextMode === 'e2ee' && e.status === 400) {
                                                    if (
                                                        e.code === AccountEncryptionMigrateInvalidParamsReasonSchema.def.entries.restore_required
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
                                                    if (e.code === AccountEncryptionMigrateInvalidParamsReasonSchema.def.entries.key_proof_required) {
                                                        await Modal.alertAsync(t('common.error'), t('settingsAccount.secretKeyMissing'));
                                                        return;
                                                    }
                                                }
                                                await Modal.alertAsync(encryptionRefusalTitle(e),
                                                    resolveActionExecutionErrorMessage(e, e.message));
                                                return;
                                            }
                                            await Modal.alertAsync(t('common.error'), t('settingsAccount.encryptionUpdateFailed'));
                                            announceAccessibilityMessage(t('common.error'));
                                            return;
                                        } finally { setAccountEncryptionModeSaving(false); }
                                    }}
                                />
                            }
                            showChevron={false}
                        />
                        {keepEncryptionKeyRow}
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
                {!encryptionAccountOptOutEnabled && keepEncryptionKeyRow && (
                    <ItemGroup title={t('terminal.encryption')}>{keepEncryptionKeyRow}</ItemGroup>
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
