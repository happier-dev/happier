import { describe, expect, it, vi } from 'vitest';

import {
    fetchReviewCommentAccountEncryptionMigrationInventory,
} from './accountEncryptionMigrationApi';

describe('Review Comment Account-encryption inventory API', () => {
    it('fetches and strictly parses the bounded authenticated inventory', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            v: 1,
            items: [],
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(fetchReviewCommentAccountEncryptionMigrationInventory({
            request,
        })).resolves.toEqual({ v: 1, items: [] });
        expect(request).toHaveBeenCalledWith(
            '/v1/account/encryption/migrate/review-comments/inventory',
            { method: 'GET' },
            { includeAuth: true, retry: 'none' },
        );
    });

    it('rejects an incompatible or failed inventory response', async () => {
        await expect(fetchReviewCommentAccountEncryptionMigrationInventory({
            request: async () => new Response(JSON.stringify({
                v: 1,
                items: [],
                extra: true,
            }), { status: 200 }),
        })).rejects.toThrow();
        await expect(fetchReviewCommentAccountEncryptionMigrationInventory({
            request: async () => new Response('{}', { status: 409 }),
        })).rejects.toThrow('review_comment_migration_inventory_fetch_failed');
    });
});
