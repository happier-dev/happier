import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { buildSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import {
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    resolveSessionTranscriptPublicationConstraints,
    type SessionTranscriptPublicationConstraint,
} from '@/app/session/sessionTranscriptPublicationPolicy';
import { inTx } from '@/storage/inTx';

/** Resolve current access and publication ceilings, narrowing Session scope at the query owner. */
export async function readHomeSearchVisibleSessionConstraints(input: Readonly<{
    accountId: string;
    authentication: SessionAccessAuthentication;
    scope: MemorySearchScope;
}>): Promise<readonly SessionTranscriptPublicationConstraint[]> {
    return resolveSessionTranscriptPublicationConstraints(await inTx(async tx => {
        const accessWhere = await buildSessionAccessWhere({
            tx,
            accountId: input.accountId,
            capability: 'readTranscript',
            mode: 'effective_access_v1',
            authentication: input.authentication,
        });
        return tx.session.findMany({
            where: input.scope.type === 'session'
                ? { AND: [accessWhere, { id: input.scope.sessionId }] }
                : accessWhere,
            select: withSessionContentSelect({ id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT }),
        }).then(decodeSessionStoredContent);
    }));
}
