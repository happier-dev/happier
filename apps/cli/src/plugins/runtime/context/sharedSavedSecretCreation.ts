import type { SharedSecretAudience, SharedSecretSaveResult } from '@happier-dev/plugin-sdk/secrets';
import type { StoredCredentials } from '@/persistence';
import { createSharedSavedSecretForOperation } from '@/settings/secrets/createSharedSavedSecretForOperation';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

/** The Account router's resource-create adapter; sealing/storage keep their existing owners. */
export async function createSharedSavedSecretForPlugin(input: Readonly<{
    name: string; value: string; audience: SharedSecretAudience; expectedScopeKey: string;
    createdByPlugin: Readonly<{ pluginId: string; secretId: string }>;
    signal: AbortSignal; assertCurrent(): void;
    readCredentials(): Promise<StoredCredentials | null>;
    operationContext?: SavedSecretOperationContextV1;
}>): Promise<SharedSecretSaveResult> {
    return await createSharedSavedSecretForOperation(input);
}
