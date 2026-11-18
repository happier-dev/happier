import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

import { HappyError } from '@/utils/errors/errors';

import type { SessionListPageCompat } from './sessionHttpCompat';

/**
 * The Home's personal Session list: `my_work`, inactive rows included, with attention.
 * Activity reads this corpus, and the cold page-one read asks for it when no query reader came first.
 */
export const HOME_PERSONAL_SESSION_LIST_QUERY: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: true,
    scope: 'my_work',
    attention: 'any',
    audiences: [],
    tagIds: [],
    includeAttention: true,
};

type OpenPageOneRead = {
    read: Promise<SessionListPageCompat>;
    /** The cold ordinary acquisition this read answers; a retired or replaced one cannot take it. */
    ordinaryScope: string;
    /** The exact query transport body and the Home's read fence when the read began. */
    queryKey: string;
    queryFreshness: string;
    ordinaryOpen: boolean;
    queryOpen: boolean;
};

/**
 * The cold load's one Session-list read on a Home that answers `ordinaryPage`: a query
 * page one that also carries the ordinary first page. Whichever page-one reader comes
 * first starts it and the other takes its part, once. The query part is taken only
 * for the same transport body and while no invalidation has fenced the Home since
 * the read began, the same rule that lets concurrent query reads share one request.
 */
export class SessionListPageOneRead {
    private open: OpenPageOneRead | null = null;

    start(input: Readonly<{
        read: Promise<SessionListPageCompat>;
        ordinaryScope: string;
        queryKey: string;
        queryFreshness: string;
        takenBy: 'ordinary' | 'query';
    }>): Promise<SessionListPageCompat> {
        // Each taker attaches its own handlers; an untaken part must not report an unhandled rejection.
        input.read.catch(() => {});
        this.open = { read: input.read, ordinaryScope: input.ordinaryScope, queryKey: input.queryKey,
            queryFreshness: input.queryFreshness,
            ordinaryOpen: input.takenBy !== 'ordinary', queryOpen: input.takenBy !== 'query' };
        return input.read;
    }

    /** The ordinary first page of the open read, for the cold acquisition it was started for. */
    takeOrdinary(ordinaryScope: string): Promise<SessionListPageCompat> | null {
        const open = this.open;
        if (!open?.ordinaryOpen || open.ordinaryScope !== ordinaryScope) return null;
        open.ordinaryOpen = false;
        return readOrdinaryPart(open.read);
    }

    /** Whether a cold ordinary acquisition already started or awaits this scope's read. */
    hasOrdinaryReader(ordinaryScope: string): boolean {
        return this.open?.ordinaryScope === ordinaryScope;
    }

    /** The query page of the open read, for the same query asked under the same read fence. */
    takeQuery(queryKey: string, queryFreshness: string): Promise<SessionListPageCompat> | null {
        const open = this.open;
        if (!open?.queryOpen || open.queryKey !== queryKey || open.queryFreshness !== queryFreshness) return null;
        open.queryOpen = false;
        return open.read;
    }

    clear(): void {
        this.open = null;
    }
}

/**
 * The ordinary page a page-one read carries. Its taker awaits it only after its own earlier
 * reads, so a failure is marked handled here and still rejects for that taker.
 */
export function readOrdinaryPart(read: Promise<SessionListPageCompat>): Promise<SessionListPageCompat> {
    const ordinary = read.then((page) => {
        if (!page.ordinary) throw new HappyError('Session list query omitted its ordinary page', false, { code: 'invalid_response' });
        return page.ordinary;
    });
    ordinary.catch(() => {});
    return ordinary;
}
