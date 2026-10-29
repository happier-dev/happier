import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { mayInjectSessionContextForDestinationsInTx } from '@/app/session/access/sessionContextInjection';

/** Read current executable destinations once for an original's relation set. */
export async function readSessionFollowRouteDestinationsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<ReadonlySet<string>> {
    const admitted = new Set<string>();
    // The admission owner also binds the source id and Prisma's OFFSET. Keep
    // each set below the existing portable provider boundary, without a cap on
    // how many receivers may follow the source.
    for (const ids of portableQueryChunks({ values: [...new Set(input.destinationSessionIds)], bindingsPerValue: 1, fixedBindings: 2 })) {
        const destinations = await tx.session.findMany({ where: { id: { in: [...ids] }, archivedAt: null }, select: { id: true } });
        const decisions = await mayInjectSessionContextForDestinationsInTx(tx, {
            configuringAccountId: input.accountId, sourceSessionId: input.sourceSessionId,
            authentication: input.authentication, destinationSessionIds: destinations.map(destination => destination.id),
        });
        for (const [id, decision] of decisions) if (decision.ok) admitted.add(id);
    }
    return admitted;
}
