import type { LocalServicePublicExposureAudienceV1 } from '@happier-dev/protocol/local/services/public/v1';
import { inTx } from '@/storage/inTx';
import { readResourceGrantPrincipalFactsInTx, resolveResourceGrantAccessFromFacts,
    validateResourceGrantPrincipalInTx } from '@/app/teams/resourceGrantAccess';

/**
 * A `people` Service preview share stores its audience on the in-memory exposure, not in a
 * grant table: the exposure is never persisted. Who may be named and who is a member are
 * still decided by the one resource-grant owner (share eligibility; Team grants exclude
 * guests, explicit Group grants admit them).
 */
export async function isLocalServicePublicAudienceEligible(input: Readonly<{
    actorAccountId: string; ownerAccountId: string; audience: LocalServicePublicExposureAudienceV1;
}>): Promise<boolean> {
    return await inTx(async (tx) => {
        for (const principal of input.audience) {
            const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
                ownerAccountId: input.ownerAccountId, principal, hasExistingGrant: false });
            if (error) return false;
        }
        return true;
    });
}

export async function isLocalServicePublicAudienceMember(input: Readonly<{
    sharerAccountId: string; audience: LocalServicePublicExposureAudienceV1; viewerAccountId: string;
}>): Promise<boolean> {
    return await inTx(async (tx) => {
        const facts = await readResourceGrantPrincipalFactsInTx(tx, { ownerAccountId: input.sharerAccountId,
            principals: input.audience, actorAccountId: input.viewerAccountId });
        return resolveResourceGrantAccessFromFacts(facts, input.viewerAccountId) !== null;
    });
}
