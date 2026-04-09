import type { BulkTransferFileDestination } from './bulkTransferFileDestination';

export async function cleanupBulkTransferDestination(destination: BulkTransferFileDestination): Promise<void> {
    if (destination.cleanup) {
        await destination.cleanup();
        return;
    }

    await destination.close();
}
