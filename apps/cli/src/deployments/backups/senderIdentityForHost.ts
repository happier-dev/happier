import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentBackupSenderIdentityV1 } from '@happier-dev/protocol/deployments/deploymentBackupAnotherMachineV1';
import { randomBytes } from 'node:crypto';
import { createManagedBootstrapSshKeyPair } from '@happier-dev/cli-common/machines/managed';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { SharedSecretAudience } from '@happier-dev/plugin-sdk/secrets';
import type { StoredCredentials } from '@/persistence';
import { createSharedSavedSecretForOperation } from '@/settings/secrets/createSharedSavedSecretForOperation';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createDeploymentTemplateGeneratedSecretForHost } from '../templates/generatedSecretForHost';

export type BackupSenderIdentityHostInput = Readonly<{
    name: string; audience: SharedSecretAudience; expectedScopeKey: string; signal: AbortSignal;
    readCredentials(): Promise<StoredCredentials | null>;
    operationContext?: SavedSecretOperationContextV1;
    retained?: DeploymentBackupSenderIdentityV1;
}>;
export type BackupSenderIdentityResult =
    | Readonly<{ status: 'ready'; publicKey: string; sshPrivateKey: DeploymentBackupSenderIdentityV1['sshPrivateKey'];
        repositoryPassword: NonNullable<DeploymentBackupSenderIdentityV1['repositoryPassword']> }>
    | Readonly<{ status: 'partial'; errorCode: string; senderIdentity?: DeploymentBackupSenderIdentityV1 }>;

export async function createBackupSenderIdentityForHost(input: BackupSenderIdentityHostInput): Promise<BackupSenderIdentityResult> {
    let senderIdentity = input.retained;
    try {
        input.signal.throwIfAborted();
        if (!senderIdentity) {
            let pair: ReturnType<typeof createManagedBootstrapSshKeyPair> | undefined = createManagedBootstrapSshKeyPair({ randomBytes });
            try {
                const saved = await createSharedSavedSecretForOperation({ ...input, name: `${input.name} SSH key`,
                    value: pair.privateKey, assertCurrent: () => input.signal.throwIfAborted() });
                senderIdentity = { publicKey: pair.publicKey, sshPrivateKey: { kind: 'secret', ...saved } };
            } finally {
                // The managed generator wipes entropy. JS strings cannot be erased;
                // release both local references after P42 has sealed the material.
                pair = undefined;
            }
        }
        const repositoryPassword = senderIdentity.repositoryPassword ?? await createDeploymentTemplateGeneratedSecretForHost({
            ...input, name: `${input.name} repository password`, profile: { kind: 'base64url-32-bytes' },
        });
        return { status: 'ready', ...senderIdentity, repositoryPassword };
    } catch (error) {
        if (input.signal.aborted) throw error;
        if (!isPluginError(error)) throw error;
        if (error.code === 'outcome_unknown') {
            // Existing Action failure recovery carries P42's nonsecret candidate
            // identity. An unknown creation must never be replayed here.
            throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }), { cause: { ok: false, errorCode: 'outcome_unknown',
                error: 'outcome_unknown', effectAttempted: true, details: { ...(error.details && typeof error.details === 'object'
                    && !Array.isArray(error.details) ? error.details : {}), ...(senderIdentity ? { senderIdentity } : {}) } } });
        }
        return { status: 'partial', errorCode: error.code, ...(senderIdentity ? { senderIdentity } : {}) };
    }
}
