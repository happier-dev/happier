import { createDeferred } from '../async/deferred';
import { stubUndiciFetch } from './stubUndiciFetch';

/**
 * Stub bundled Undici Fetch and report once the expected requests were issued.
 *
 * A fake clock must advance only after the transport has issued its request and armed its
 * timers. Awaiting the returned promise orders that deterministically, instead of relying on
 * how many macrotasks the transport's lazy module loads happen to need.
 */
export function stubIssuedFetch<Args extends unknown[]>(
    handler: (...args: Args) => Promise<Response>,
    expectedRequests = 1,
): Promise<void> {
    const issued = createDeferred();
    let count = 0;
    stubUndiciFetch((...args: Args): Promise<Response> => {
        count += 1;
        if (count === expectedRequests) issued.resolve();
        return handler(...args);
    });
    return issued.promise;
}
