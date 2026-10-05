import type { AccountHistoricalEncryptionKeyForgetResultV1, ActionExecuteFailure } from '@happier-dev/protocol';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { isTokenOnlyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { captureAccountSettingsRequest, type CapturedAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { storage } from '@/sync/domains/state/storageStore';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { fetchAccountEncryptionMigrationAutomationsInventory } from './fetchAccountEncryptionMigrationAutomationsInventory';
import { fetchAccountEncryptionMigrationSessionInventory } from './fetchAccountEncryptionMigrationSessionInventory';
import { isAccountEncryptionMigrationAutomationContentPlain, readAccountEncryptionMigrationPlainAutomationTarget } from './buildAccountEncryptionMigrationAutomations';

export async function readHistoricalEncryptionInventory(credentials: AuthCredentials, captured: CapturedAccountSettingsRequest) {
    const sessions = new Map<string, Readonly<{ sessionId: string; encryptionMode: 'plain' | 'e2ee' }>>();
    const [automations] = await Promise.all([
        fetchAccountEncryptionMigrationAutomationsInventory({ request: captured.request }),
        fetchAccountEncryptionMigrationSessionInventory({ token: credentials.token,
            request: captured.request, scope: captured, onSession: session => sessions.set(session.sessionId, session) }),
    ]);
    return { automations, sessions };
}

/** The one destructive historical-custody operation, behind Action admission. */
export async function forgetHistoricalEncryptionKey(params: Readonly<{
    settingsScope: AccountSettingsScope;
    signal?: AbortSignal;
}>): Promise<AccountHistoricalEncryptionKeyForgetResultV1 | ActionExecuteFailure> {
    const auth = getCurrentAuth();
    const credentials = auth?.credentials;
    const token = credentials?.token;
    if (!auth || !credentials || !token) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    const captured = await captureAccountSettingsRequest({ credentials, ...params });
    const scopeChanged = (): ActionExecuteFailure => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    if (!captured) return scopeChanged();
    try {
        if (isTokenOnlyAuthCredentials(credentials)) return { status: 'nothing_retained' };
        const currentness = await fetchAccountEncryptionCurrentness(credentials, { request: captured.request });
        if (!captured.isCurrent()) return scopeChanged();
        if (currentness.mode !== 'plain') return { ok: false, errorCode: 'account_encryption_mode_mismatch', error: 'account_encryption_mode_mismatch' };
        // This census informs a destructive human decision, never automatic discard.
        const inventory = await readHistoricalEncryptionInventory(credentials, captured);
        if (!captured.isCurrent()) return scopeChanged();
        const items: string[] = [];
        for (const session of inventory.sessions.values()) {
            if (session.encryptionMode !== 'e2ee') continue;
            const displayed = storage.getState().sessions[session.sessionId];
            items.push(t('settingsAccount.forgetEncryptionKeySession', {
                name: displayed ? getSessionName(displayed, captured.target.serverId) : t('session.untitled'), id: session.sessionId,
            }));
        }
        for (const template of inventory.automations.templates) {
            const plain = readAccountEncryptionMigrationPlainAutomationTarget(template.templateCiphertext);
            if (plain && (!plain.existingSessionId || inventory.sessions.get(plain.existingSessionId)?.encryptionMode === 'plain')
                && isAccountEncryptionMigrationAutomationContentPlain({ templates: [template], runs: [] })) continue;
            items.push(t('settingsAccount.forgetEncryptionKeyTrigger', { id: template.automationId }));
        }
        for (const run of inventory.automations.runs) {
            if (isAccountEncryptionMigrationAutomationContentPlain({ templates: [], runs: [run] })) continue;
            items.push(t('settingsAccount.forgetEncryptionKeyRun', { id: run.runId }));
        }
        const confirmed = await Modal.confirm(t('settingsAccount.forgetEncryptionKeyConfirm'),
            t('settingsAccount.forgetEncryptionKeyWarning', { items: items.length ? items.join('\n') : t('settingsAccount.forgetEncryptionKeyEmpty') }),
            { confirmText: t('settingsAccount.forgetEncryptionKeyAction'), cancelText: t('common.cancel'), destructive: true });
        if (!captured.isCurrent()) return scopeChanged();
        if (!confirmed) return { status: 'cancelled' };
        const latest = await fetchAccountEncryptionCurrentness(credentials, { request: captured.request });
        if (!captured.isCurrent()) return scopeChanged();
        if (latest.mode !== 'plain') return { ok: false, errorCode: 'account_encryption_mode_mismatch', error: 'account_encryption_mode_mismatch' };
        const replacementCredentials = { token };
        captured.prepareCredentialAdoption(replacementCredentials);
        const replacement = await auth.loginWithCredentials(replacementCredentials,
            { target: captured.target, expectedCredentials: credentials });
        if (replacement.kind !== 'completed') throw new Error('Historical credentials could not be forgotten');
        if (!captured.isCurrent()) return scopeChanged();
        return { status: 'forgotten' };
    } catch (error) {
        if (!captured.isCurrent()) return scopeChanged();
        throw error;
    } finally {
        captured.dispose();
    }
}
