import type { Tx } from '@/storage/inTx';
import type { TeamOperationAuthenticationContext } from '../actorContext';
import { readTeamCredentialSourceResourceAdministrationInTx } from './resourceRead';

/** Direct reconciliation consumes the existing custodian/source summary owner,
 * not a Team census or the stripped public source-administration projection. */
export async function readTeamCredentialCustodianResourcePageInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    authentication: TeamOperationAuthenticationContext;
    cursor?: string;
    limit?: number;
}>) {
    const result = await readTeamCredentialSourceResourceAdministrationInTx(tx, { ...input, scope: 'custodian' });
    return result.ok ? { ...result, page: {
        resources: result.readinessResources,
        nextCursor: result.page.nextCursor,
        viewer: { manageCredentials: false, offerOwnCredential: true },
    } } : result;
}
