import type { BulkTransferFileDestination } from './bulkTransferFileDestination';

export async function cleanupBulkTransferDestination(destination: BulkTransferFileDestination, originalError?: unknown): Promise<void> {
    try {
        if (destination.cleanup) {
            await destination.cleanup();
            return;
        }
        await destination.close();
    } catch (cleanupError) {
        if (originalError === undefined) throw cleanupError;
        throw Object.assign(new Error(`${originalError instanceof Error ? originalError.message : String(originalError)}; Failed to clean up downloaded file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`), {
            errors: [originalError, cleanupError],
        });
    }
}
