import { logger } from '@/ui/logger';

import type { SessionRuntimeActivityContributionHandle } from './types';

const ACTIVE_TURN_PROJECTION = Object.freeze({ state: 'active', activeCount: 1 } as const);
const IDLE_TURN_PROJECTION = Object.freeze({ state: 'idle', activeCount: 0 } as const);

/**
 * Publishes the runner's own in-flight turn as a Runtime Activity contribution. Turn
 * streaming writes feed no provider-task ledger and no execution run, so without this
 * slot a long turn projects `idle` and consumers that gate on the server projection
 * (planned runner restart, `after_runtime_idle` delivery) act against a live turn.
 */
export function createTurnActivityReporter(params: Readonly<{
    contributionHandle: SessionRuntimeActivityContributionHandle;
    isTurnActive: () => boolean;
}>) {
    let lastPublishedActive: boolean | null = null;
    let publicationTail: Promise<void> = Promise.resolve();

    const publishCurrent = (reason: string): Promise<void> => {
        const active = params.isTurnActive();
        const publish = async (): Promise<void> => {
            if (lastPublishedActive === active) return;
            try {
                await params.contributionHandle.report(
                    active ? ACTIVE_TURN_PROJECTION : IDLE_TURN_PROJECTION,
                    reason,
                );
            } catch (error) {
                // Boundary publication is best-effort at the thinking-transition call site;
                // keep the failure observable in the file log for support diagnosis.
                logger.infoFile('[turnRuntimeActivity] Activity publication failed', { active });
                throw error;
            }
            lastPublishedActive = active;
        };
        const result = publicationTail.then(publish, publish);
        publicationTail = result.catch(() => undefined);
        return result;
    };

    return Object.freeze({
        /** Re-reads turn truth and publishes only when the projection changed. */
        publishCurrent,
    });
}
