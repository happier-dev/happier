import {
    ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema,
    type ReviewCommentAccountEncryptionMigrationInventoryResponseV1,
} from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

export const REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_INVENTORY_PATH =
    '/v1/account/encryption/migrate/review-comments/inventory';

type ReviewCommentMigrationInventoryRequest = (
    path: string,
    init: RequestInit,
    options: Readonly<{ includeAuth: true; retry: 'none' }>,
) => Promise<Response>;

export async function fetchReviewCommentAccountEncryptionMigrationInventory(
    params: Readonly<{
        request?: ReviewCommentMigrationInventoryRequest;
    }> = {},
): Promise<ReviewCommentAccountEncryptionMigrationInventoryResponseV1> {
    const request = params.request
        ?? (serverFetch as ReviewCommentMigrationInventoryRequest);
    const response = await request(
        REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_INVENTORY_PATH,
        { method: 'GET' },
        { includeAuth: true, retry: 'none' },
    );
    if (!response.ok) {
        throw new Error('review_comment_migration_inventory_fetch_failed');
    }
    return ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema.parse(
        await response.json(),
    );
}
