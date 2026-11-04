import { backfillAutomationManagedTargetsV1 } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { listAutomationDefinitionDetails, updateAutomationDefinition } from '@/sync/api/automations/apiAutomations';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** One Account-bootstrap adapter; recipe semantics and CAS remain on the Protocol owner. */
export async function backfillAutomationManagedTargetsForAccount(lifetime: ServerAccountScopeLifetime) {
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    try {
        account = await captureLazyActionAccountContext(lifetime.scope.serverId, controller.signal);
        const captured = account;
        const isCurrent = () => !controller.signal.aborted && lifetime.isCurrent()
            && captured.accountLifetime.isCurrent()
            && areServerAccountScopesEqual(lifetime.scope, captured.accountLifetime.scope);
        const assertCurrent = () => {
            controller.signal.throwIfAborted();
            captured.assertCurrent();
            if (!isCurrent()) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        };
        assertCurrent();
        const context = { request: captured.request, serverId: captured.serverId };
        return await backfillAutomationManagedTargetsV1({
            signal: controller.signal,
            isCurrent,
            randomBytes: getRandomBytes,
            resolveEncryption: async () => {
                assertCurrent();
                const current = await resolveValidatedAutomationAccountEncryptionV1({
                    signal: controller.signal,
                    resolveAccountEncryptionCurrentness: signal => fetchAccountEncryptionCurrentness(captured.credentials,
                        { request: captured.request, signal }),
                    resolveAccountEncryptionMaterial: async () => createAccountScopedCryptoMaterialSnapshotV1({
                        accountEncryptionMode: 'e2ee',
                        material: resolveAccountScopedCryptoMaterialFromCredentials(captured.credentials),
                        ...(isDataKeyAuthCredentials(captured.credentials)
                            ? { dataKeyPublicKey: decodeBase64(captured.credentials.encryption.publicKey, 'base64') } : {}),
                    }),
                });
                assertCurrent();
                if (current.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
                return current;
            },
            automations: {
                listDetails: input => { assertCurrent(); return listAutomationDefinitionDetails(captured.credentials, input, context); },
                patch: async (automationId, input, beforeWrite) => {
                    await beforeWrite?.();
                    assertCurrent();
                    return await updateAutomationDefinition(captured.credentials, automationId, input, context);
                },
            },
        });
    } finally {
        retirement.dispose();
        account?.dispose();
    }
}
