import type { AccountEncryptionAutomationTemplatesRecoverResultV1, ActionExecuteFailure } from '@happier-dev/protocol';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { isTokenOnlyAuthCredentials } from '@/auth/storage/tokenStorage';
import { captureAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { updateAutomationDefinition } from '@/sync/api/automations/apiAutomations';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

import { recoverAccountEncryptionMigrationAutomations } from './buildAccountEncryptionMigrationAutomations';
import { readHistoricalEncryptionInventory } from './forgetHistoricalEncryptionKey';

/** Client-custody orchestration of the existing transition converter and template CAS. */
export async function recoverHistoricalAutomationTemplates(params: Readonly<{
    settingsScope: AccountSettingsScope;
    signal?: AbortSignal;
}>): Promise<AccountEncryptionAutomationTemplatesRecoverResultV1 | ActionExecuteFailure> {
    const credentials = getCurrentAuth()?.credentials;
    if (!credentials?.token) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    if (isTokenOnlyAuthCredentials(credentials)) {
        return { ok: false, errorCode: 'target_unavailable', error: 'Historical encryption material is unavailable on this client.' };
    }
    const scopeChanged = (): ActionExecuteFailure => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    const captured = await captureAccountSettingsRequest({ credentials, ...params });
    if (!captured) return scopeChanged();
    try {
        const currentness = await fetchAccountEncryptionCurrentness(credentials, { request: captured.request });
        if (!captured.isCurrent()) return scopeChanged();
        if (currentness.mode !== 'plain') {
            return { ok: false, errorCode: 'account_encryption_mode_mismatch', error: 'account_encryption_mode_mismatch' };
        }
        const inventory = await readHistoricalEncryptionInventory(credentials, captured);
        if (!captured.isCurrent()) return scopeChanged();
        const templates = await recoverAccountEncryptionMigrationAutomations({
            templates: inventory.automations.templates,
            historicalMaterial: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
            resolveSession: async sessionId => inventory.sessions.get(sessionId) ?? null,
            isCurrent: captured.isCurrent,
            commitTemplate: async (automationId, expectedTemplateVersion, templateCiphertext) => {
                await updateAutomationDefinition(credentials, automationId, { expectedTemplateVersion, templateCiphertext },
                    { request: captured.request, serverId: captured.target.serverId });
            },
        });
        if (!captured.isCurrent()) return scopeChanged();
        // Recovery never adopts credentials: only the explicitly confirmed Forget Action discards them.
        return { templates: [...templates] };
    } catch (error) {
        if (!captured.isCurrent()) return scopeChanged();
        throw error;
    } finally {
        captured.dispose();
    }
}
