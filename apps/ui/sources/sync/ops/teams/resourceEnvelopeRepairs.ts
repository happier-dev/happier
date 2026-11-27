import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { log } from '@/log';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Encryption } from '@/sync/encryption/encryption';
import { prepareOwedArtifactRecipientKeys, type ArtifactDataKeyCache } from '@/sync/engine/artifacts/syncArtifacts';
import { createServerFetchForActiveServer } from '@/sync/http/client';

/** Each resource owner admits and repairs only the recipients its owed census names. */
export async function repairTeamResourceEnvelopes(params: Readonly<{
    scope: ServerAccountScope;
    credentials: AuthCredentials;
    encryption: Encryption;
    isCurrent: () => boolean;
    artifactDataKeys: ArtifactDataKeyCache;
}>): Promise<void> {
    const { scope, credentials, encryption, isCurrent, artifactDataKeys } = params;
    const { repairCustodiedSavedSecretResourceEnvelopesBestEffort } = await import('../settings/savedSecretResourceOperations');
    if (!isCurrent()) return;
    await repairCustodiedSavedSecretResourceEnvelopesBestEffort({
        scope, decryptDataKeyEnvelope: encryptedDataKey => encryption.decryptEncryptionKey(encryptedDataKey, scope),
    }).catch((error: unknown) => log.log(`Saved Secret envelope repair deferred: ${error instanceof Error ? error.message : 'unavailable'}`));

    const { prepareOwedTaskKeys } = await import('@/sync/domains/todos/taskResourceTransport');
    if (!isCurrent()) return;
    await prepareOwedTaskKeys({ credentials, accountId: scope.accountId, serverId: scope.serverId, isCurrent })
        .catch((error: unknown) => log.log(`Task key repair deferred: ${error instanceof Error ? error.message : 'unavailable'}`));

    if (!isCurrent()) return;
    await prepareOwedArtifactRecipientKeys({
        credentials, encryption, artifactDataKeys, request: createServerFetchForActiveServer(undefined, { credentials, isCurrent }),
    }).catch((error: unknown) => log.log(`Artifact key repair deferred: ${error instanceof Error ? error.message : 'unavailable'}`));

    const { prepareOwedMachinePresetKeys } = await import('../machines/machinePresetRecipientRepair');
    if (isCurrent()) await prepareOwedMachinePresetKeys(scope).catch((error: unknown) =>
        log.log(`Preset key repair deferred: ${error instanceof Error ? error.message : 'unavailable'}`));
}
