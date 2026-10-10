import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { AccountEncryptionProjectRowMigrationCandidate } from './buildAccountEncryptionProjectRowsDirective';

/** Census every registered family at the captured Home, never a local projected subset. */
export async function fetchAccountEncryptionProjectRowsMigrationCandidates(params: Readonly<{
    credentials: AuthCredentials;
    mode: 'plain' | 'e2ee';
    request(path: string, init?: RequestInit): Promise<Response>;
}>): Promise<readonly AccountEncryptionProjectRowMigrationCandidate[]> {
    const cipher = createProjectAccountRowCipherV1({ mode: params.mode,
        material: params.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials), randomBytes: getRandomBytes });
    const response = await params.request(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(`Project Account row census failed (${response.status})`);
    const result = ProjectAccountRowListResponseV1Schema.parse(await response.json());
    if (result.status !== 'listed') throw new Error(`Project Account row census refused (${result.status})`);
    return result.rows.flatMap(row => row.content === null ? [] : [{ revision: row.revision, payload: cipher.open(row.key, row.content) }]);
}
