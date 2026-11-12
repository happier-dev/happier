import { createHash } from 'node:crypto';
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/mini';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { isProjectWorkspaceSyncOpenActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { isDeploymentBackupEvidenceActionIdV1, isDeploymentTargetLinkActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { RequesterWorkAttributionV1Schema } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ensureProtectedLocalStateDirectorySync, ensureProtectedLocalStateFileSync,
    readProtectedLocalStateFileSync } from '@/utils/fs/protectedLocalState';
import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';
import { logger } from '@/ui/logger';

const ReceiptSchema = z.strictObject({
    version: z.literal(1), snapshot: ActionOperationSnapshotV1Schema, inputIdentity: z.string(),
    deploymentChildIdentity: z.optional(z.string()),
    requesterWorkAttributionV1: z.optional(RequesterWorkAttributionV1Schema),
});
const ReceiptReadSchema = createStoredReadSchema(ReceiptSchema);
const EnvelopeReadSchema = createStoredReadSchema(z.strictObject({ version: z.literal(1), ciphertext: z.string() }));
export type RetainedProjectOpenReceipt = Readonly<z.infer<typeof ReceiptSchema>>;

/** Only the operation store decides lifecycle and retention; this is its disk adapter.
 * The historical module name and encryption purpose preserve existing Open receipts. */
export type ProjectOpenReceiptPersistence = Readonly<{
    retained: readonly RetainedProjectOpenReceipt[];
    save(receipt: RetainedProjectOpenReceipt): void;
    remove(operationId: string): void;
}>;

export class ProjectOpenReceiptPersistenceError extends Error {
    constructor(readonly effectAttempted: boolean) {
        super('Action operation receipt storage is unavailable on this Machine');
        this.name = 'ProjectOpenReceiptPersistenceError';
    }
}

function entryName(operationId: string): string {
    return `${createHash('sha256').update(operationId).digest('hex')}.json`;
}

export function requiresActionOperationReceiptPersistence(actionId: string | undefined): boolean {
    return isProjectWorkspaceSyncOpenActionV1(actionId)
        || (actionId !== undefined && (isDeploymentBackupEvidenceActionIdV1(actionId) || isDeploymentTargetLinkActionIdV1(actionId)));
}

export async function prepareProjectOpenReceiptPersistence(input: Readonly<{
    directory: string; keyPath: string; accountId: string; machineId: string;
}>): Promise<ProjectOpenReceiptPersistence> {
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: input.keyPath });
    const partition = createHash('sha256').update(JSON.stringify([input.accountId, input.machineId])).digest('hex');
    ensureProtectedLocalStateDirectorySync(input.directory, { authority: 'owned' });
    const directory = join(input.directory, partition);
    ensureProtectedLocalStateDirectorySync(directory, { authority: 'owned' });
    const retained = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
        const envelope = EnvelopeReadSchema.parse(JSON.parse(readProtectedLocalStateFileSync(join(directory, name))));
        const receipt = ReceiptReadSchema.parse(storage.openJson({ purpose: 'project_open_receipt', ciphertext: envelope.ciphertext }));
        // The partition belongs to the installed custodian. A shared Machine's
        // admitted requester can be a different Account; the store scopes reads.
        if (!requiresActionOperationReceiptPersistence(receipt.snapshot.actionId) || entryName(receipt.snapshot.operationId) !== name
            || receipt.snapshot.scope.machineId !== input.machineId) {
            throw new ProjectOpenReceiptPersistenceError(false);
        }
        return receipt;
    });
    return {
        retained,
        save(receipt) {
            const path = join(directory, entryName(receipt.snapshot.operationId));
            writeJsonAtomicSync(path, { version: 1,
                ciphertext: storage.sealJson({ purpose: 'project_open_receipt', value: receipt }) });
            ensureProtectedLocalStateFileSync(path, { authority: 'owned' });
        },
        remove(operationId) {
            try { unlinkSync(join(directory, entryName(operationId))); }
            catch (error) {
                // Expiry still applies in the operation owner; a failed deletion
                // leaves an expired encrypted file for the next startup to prune.
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('Could not prune an expired Action operation receipt');
            }
        },
    };
}
