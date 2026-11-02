import { randomUUID } from 'node:crypto';

import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SharedSavedSecretMutationOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { SharedSecretAudience, SharedSecretSaveResult } from '@happier-dev/plugin-sdk/secrets';

import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { runWithServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { hasUsableAccountSettingsEncryptionMaterial } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareSavedSecretResourceCreateForOperation } from './hydrateSavedSecretCatalog';
import type { SavedSecretOperationContextV1 } from './savedSecretOperationContext';
import { repairSavedSecretResourceEnvelopesForOperation } from './repairSavedSecretResourceEnvelopes';

/** Shared host resource creation; sealing, audience and storage retain their existing owners. */
export async function createSharedSavedSecretForOperation(input: Readonly<{
    name: string; value: string; audience: SharedSecretAudience; expectedScopeKey: string;
    createdByPlugin?: Readonly<{ pluginId: string; secretId: string }>;
    signal: AbortSignal; assertCurrent(): void | Promise<void>;
    readCredentials(): Promise<StoredCredentials | null>;
    operationContext?: SavedSecretOperationContextV1;
}>): Promise<SharedSecretSaveResult> {
    return await runWithServerHttpBaseUrl(input.operationContext?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), async () => {
        const assertCurrent = async () => {
            input.signal.throwIfAborted();
            await input.assertCurrent();
            input.signal.throwIfAborted();
            if (input.operationContext && !await input.operationContext.isCurrent(input.signal)) {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Shared save invocation retired' });
            }
        };
        await assertCurrent();
        const credentials = await input.readCredentials();
        await assertCurrent();
        const accountId = credentials && readAccountIdFromToken(credentials.token);
        if (!credentials || !accountId || resolveAccountSettingsScopeKeyForToken(credentials.token) !== input.expectedScopeKey) {
            throw new PluginError({ code: 'plugin_secret_custody_unavailable', message: 'Shared save Account custody is unavailable' });
        }
        const storage = await resolveCliAccountStorageContext({ credentials, signal: input.signal }).catch(error => {
            if (!hasUsableAccountSettingsEncryptionMaterial(credentials) && error && typeof error === 'object'
                && 'code' in error && error.code === 'account_storage_currentness_unavailable') {
                throw new PluginError({ code: 'secret_save_client_required', message: 'Shared save requires authorized Account encryption custody' });
            }
            throw error;
        });
        await assertCurrent();
        if (storage.mode === 'e2ee' && !hasUsableAccountSettingsEncryptionMaterial(credentials)) {
            throw new PluginError({ code: 'secret_save_client_required', message: 'Shared save requires authorized Account encryption custody' });
        }
        const prepared = prepareSavedSecretResourceCreateForOperation({ credentials, accountId,
            ...(input.createdByPlugin ? { createdByPlugin: input.createdByPlugin } : {}),
            accountMode: storage.mode, resourceId: randomUUID(), displayName: input.name, kind: 'other', value: input.value });
        const home = createAccountServerActionDeps({ credentials, token: credentials.token,
            isCredentialCurrent: async () => { await assertCurrent(); return true; } }).homeDomainAction;
        if (!home) throw new PluginError({ code: 'plugin_secret_custody_unavailable', message: 'Resource creation is unavailable' });
        await assertCurrent();
        const result = await home({ actionId: 'secrets.shared.create', input: { ...prepared, ...input.audience },
            context: { surface: 'cli', signal: input.signal }, signal: input.signal });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) throw new PluginError({ code: failure.data.errorCode, message: 'Shared resource creation did not settle',
            ...(failure.data.errorCode === 'outcome_unknown'
                ? { details: { candidateRef: formatSharedSavedSecretRefV1(prepared.resourceId) } } : {}),
        });
        const settled = SharedSavedSecretMutationOutputV1Schema.parse(result);
        if (storage.mode === 'e2ee') {
            // Creation is already settled. Repair cannot authorize replaying it.
            await repairSavedSecretResourceEnvelopesForOperation({ credentials, expectedScopeKey: input.expectedScopeKey,
                resourceId: settled.resourceId, expectedRevision: settled.revision, signal: input.signal, assertCurrent,
                ...(input.operationContext ? { operationContext: input.operationContext } : {}),
            }).catch(() => undefined);
        }
        return Object.freeze({ ref: formatSharedSavedSecretRefV1(settled.resourceId), resourceRevision: settled.revision });
    });
}
