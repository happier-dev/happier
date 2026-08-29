import {
    ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS,
    SessionOwnerMetadataEnvelopeV1Schema,
} from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';
import {
    fetchSessionListPageCompat,
} from '@/sync/engine/sessions/sessionHttpCompat';
import type {
    AccountEncryptionMigrationSessionRow,
} from './buildAccountEncryptionMigrationStorageDirectives';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';

type SessionInventoryRequest = (
    path: string,
    init: RequestInit,
) => Promise<Response>;

const SESSION_INVENTORY_PATHS = [
    '/v2/sessions',
    '/v2/sessions/archived',
] as const;

export async function fetchAccountEncryptionMigrationSessionInventory(
    params: Readonly<{
        token: string;
        request?: SessionInventoryRequest;
    }>,
): Promise<readonly AccountEncryptionMigrationSessionRow[]> {
    const request = params.request
        ?? ((path: string, init: RequestInit) =>
            serverFetch(path, init, { includeAuth: false }));
    const rows: AccountEncryptionMigrationSessionRow[] = [];
    const seenSessionIds = new Set<string>();

    for (const sessionListPath of SESSION_INVENTORY_PATHS) {
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        while (true) {
            const page = await fetchSessionListPageCompat({
                request,
                token: params.token,
                sessionListPath,
                cursor,
                limit: 200,
                allowLegacyV1Fallback: false,
            });
            for (const row of page.sessions) {
                if (seenSessionIds.has(row.id)) {
                    throw new Error(
                        `Duplicate Session migration inventory row (${row.id})`,
                    );
                }
                seenSessionIds.add(row.id);
                const metadataLayoutVersion = readSessionMetadataLayoutVersion(row.metadataLayoutVersion);
                if (metadataLayoutVersion === 0) continue;
                if (metadataLayoutVersion !== 1) {
                    throw new Error(
                        `Unsupported Session metadata layout (${row.id})`,
                    );
                }
                if (row.share === undefined) {
                    throw new Error(
                        `Session ownership is unavailable (${row.id})`,
                    );
                }
                if (row.share !== null) continue;
                const ownerMetadata =
                    SessionOwnerMetadataEnvelopeV1Schema.safeParse(
                        row.ownerMetadata,
                    );
                if (
                    !ownerMetadata.success
                    || !Number.isSafeInteger(row.metadataVersion)
                    || !Number.isSafeInteger(row.agentStateVersion)
                ) {
                    throw new Error(
                        `Session migration snapshot is incomplete (${row.id})`,
                    );
                }
                rows.push({
                    id: row.id,
                    metadataLayoutVersion: 1,
                    metadataVersion: row.metadataVersion,
                    agentStateVersion: row.agentStateVersion!,
                    ownerMetadata: ownerMetadata.data,
                });
                if (
                    rows.length
                    > ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS
                ) {
                    throw new Error(
                        'Session migration inventory exceeds the supported bound',
                    );
                }
            }
            if (!page.hasNext) break;
            if (!page.nextCursor) {
                throw new Error(
                    `Session migration inventory pagination is incomplete (${sessionListPath})`,
                );
            }
            if (seenCursors.has(page.nextCursor)) {
                throw new Error(
                    `Session migration inventory returned a repeated cursor (${sessionListPath})`,
                );
            }
            seenCursors.add(page.nextCursor);
            cursor = page.nextCursor;
        }
    }
    return rows;
}
