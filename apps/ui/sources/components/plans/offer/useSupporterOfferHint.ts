import * as React from 'react';

import { log } from '@/log';
import { fetchSupportersWall } from '@/sync/api/supporters/fetchSupportersWall';

/** A public count can show how many have joined. It cannot predict the next assigned number. */
export function useSupporterOfferHint(): Readonly<{ total: number }> | null {
    const [hint, setHint] = React.useState<Readonly<{ total: number }> | null>(null);

    React.useEffect(() => {
        const controller = new AbortController();
        fetchSupportersWall(controller.signal).then(
            ({ total }) => {
                if (!controller.signal.aborted) setHint({ total });
            },
            (error: unknown) => {
                if (!controller.signal.aborted) {
                    log.log(`[supporter] public count unavailable: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        );
        return () => controller.abort();
    }, []);

    return hint;
}
