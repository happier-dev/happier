import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import {
    fetchSessionListPageCompat,
} from '@/sync/engine/sessions/sessionHttpCompat';
import type {
    AccountEncryptionMigrationSessionRow,
} from './buildAccountEncryptionMigrationStorageDirectives';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import {
    assertAccountEncryptionMigrationScopeCurrent,
    type AccountEncryptionMigrationScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

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
        /** Must be the request captured for the mounted Home/Account scope. */
        request: SessionInventoryRequest;
        scope: AccountEncryptionMigrationScope;
        /** Every visible Session, including layout-0 and recipients, before migration filtering. */
        onSession?: (session: Readonly<{ sessionId: string; encryptionMode: 'plain' | 'e2ee' }>) => void;
    }>,
): Promise<readonly AccountEncryptionMigrationSessionRow[]> {
    const request = params.request;
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
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
            assertAccountEncryptionMigrationScopeCurrent(params.scope);
            for (const row of page.sessions) {
                if (seenSessionIds.has(row.id)) {
                    throw new Error(
                        `Duplicate Session migration inventory row (${row.id})`,
                    );
                }
                seenSessionIds.add(row.id);
                if (row.encryptionMode !== 'plain' && row.encryptionMode !== 'e2ee') {
                    throw new Error(`Session encryption mode is unavailable (${row.id})`);
                }
                params.onSession?.({ sessionId: row.id, encryptionMode: row.encryptionMode });
                const metadataLayoutVersion = readSessionMetadataLayoutVersion(row.metadataLayoutVersion);
                if (metadataLayoutVersion === 0) continue;
                if (metadataLayoutVersion !== 1) {
                    throw new Error(
                        `Unsupported Session metadata layout (${row.id})`,
                    );
                }
                const access = normalizeSessionAccessProjection(row, { allowLegacy: true });
                if (!access) {
                    throw new Error(
                        `Session ownership is unavailable (${row.id})`,
                    );
                }
                if (access.role !== 'owner') continue;
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
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    return rows;
}
