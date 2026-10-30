import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';
import { logger } from '@/ui/logger';
import type {
    ClaudeProviderTaskActivity,
    createClaudeProviderActivityLedger,
} from './createClaudeProviderActivityLedger';

type ClaudeTaskEvidence = 'live' | 'historical-replay';
type ClaudeProviderRuntimeActivityProjection =
    | Readonly<{ state: 'active'; activeCount: number }>
    | Readonly<{ state: 'idle'; activeCount: 0 }>
    | Readonly<{ state: 'unknown'; activeCount: 0 }>;

export function createClaudeProviderRuntimeActivityAdapter(params: Readonly<{
    contributionHandle: SessionRuntimeActivityContributionHandle;
    providerActivityLedger: ReturnType<typeof createClaudeProviderActivityLedger>;
    isCurrentRuntime?: () => boolean;
}>) {
    const isCurrentRuntime = (): boolean => params.isCurrentRuntime?.() !== false;
    let observationState: 'inactive' | 'activating' | 'active' | 'failed' | 'stopped' = 'inactive';
    let observationComplete = true;
    let lastPublishedProjection: ClaudeProviderRuntimeActivityProjection | null = null;
    let publicationTail: Promise<void> = Promise.resolve();

    const currentProjection = (): ClaudeProviderRuntimeActivityProjection => {
        const activeCount = params.providerActivityLedger.getObservedActiveProviderTaskCount();
        if (activeCount > 0) return { state: 'active', activeCount };
        return observationComplete && !params.providerActivityLedger.hasActiveProviderTasks()
            ? { state: 'idle', activeCount: 0 }
            : { state: 'unknown', activeCount: 0 };
    };

    const sameProjection = (
        left: ClaudeProviderRuntimeActivityProjection | null,
        right: ClaudeProviderRuntimeActivityProjection,
    ): boolean => left?.state === right.state && left.activeCount === right.activeCount;

    const enqueueProjection = (
        projection: ClaudeProviderRuntimeActivityProjection,
        reason: string,
    ): Promise<void> => {
        const publish = async (): Promise<void> => {
            if (!isCurrentRuntime() || sameProjection(lastPublishedProjection, projection)) return;
            try {
                if (projection.state === 'unknown') {
                    await params.contributionHandle.markUnknown(reason);
                } else {
                    await params.contributionHandle.report(projection, reason);
                }
            } catch (error) {
                // Every producer uses this transport boundary, including local lifecycle hooks
                // whose best-effort caller cannot otherwise surface a rejected publication.
                logger.infoFile('[claudeProviderRuntimeActivity] Activity publication failed', { state: projection.state });
                throw error;
            }
            lastPublishedProjection = projection;
        };
        const result = publicationTail.then(publish, publish);
        publicationTail = result.catch(() => undefined);
        return result;
    };

    return {
        /** Live provider-task state; `unknown` (lost or incomplete observation) is never idle. */
        readCurrentState(): ClaudeProviderRuntimeActivityProjection['state'] {
            return currentProjection().state;
        },
        async publishBeforeRuntimeStart(reasonCode: string): Promise<void> {
            if (!isCurrentRuntime()) return;
            if (observationState === 'stopped') {
                observationState = 'inactive';
                observationComplete = true;
            }
            if (observationState === 'active' && !observationComplete) {
                // The previous owned provider has stopped. Its lost observer cannot establish
                // liveness for a new launch; only a zero-task inventory establishes prelaunch idle.
                if (params.providerActivityLedger.hasActiveProviderTasks()) return;
                observationState = 'inactive';
                observationComplete = true;
            }
            if (observationState !== 'inactive' || !observationComplete) return;
            // A launcher that has not started its owned provider process can publish its
            // current inventory without claiming that the provider observer is installed.
            await enqueueProjection(currentProjection(), reasonCode);
        },
        async activateObservation(reasonCode: string): Promise<void> {
            if (!isCurrentRuntime() || observationState !== 'inactive') return;
            observationState = 'activating';
            try {
                await enqueueProjection(currentProjection(), reasonCode);
                if (!isCurrentRuntime() || observationState !== 'activating') return;
                observationState = 'active';
                await enqueueProjection(currentProjection(), `${reasonCode}-current`);
            } catch (error) {
                if (observationState === 'activating' || observationState === 'active') observationState = 'failed';
                throw error;
            }
        },
        async observeActivity(input: Readonly<{
            activity: ClaudeProviderTaskActivity;
            evidence: ClaudeTaskEvidence;
        }>): Promise<void> {
            if (!isCurrentRuntime() || input.evidence !== 'live' || observationState === 'stopped') return;
            const didChange = params.providerActivityLedger.apply(input.activity);
            if (observationState !== 'active') return;
            if (!didChange && !params.providerActivityLedger.hasActiveProviderTasks()) return;
            await enqueueProjection(
                currentProjection(),
                input.activity.type === 'terminal'
                    ? 'claude-native-terminal'
                    : 'claude-provider-task-observed',
            );
        },
        async publishCurrent(reasonCode: string): Promise<void> {
            if (!isCurrentRuntime() || (observationState !== 'active' && observationState !== 'stopped')) return;
            await enqueueProjection(currentProjection(), reasonCode);
        },
        async handleRuntimeLoss(
            reasonCode: string,
            options?: Readonly<{ providerStopped?: boolean }>,
        ): Promise<void> {
            if (!isCurrentRuntime()) return;
            if (observationState === 'stopped') {
                // Delayed observer loss cannot weaken physical exit proof; a rejected idle
                // publication can still use the existing serialized publication path to retry.
                await enqueueProjection(currentProjection(), reasonCode);
                return;
            }
            const observationOffered = observationState === 'active' || observationState === 'activating';
            observationComplete = options?.providerStopped === true;
            if (observationComplete) observationState = 'stopped';
            if (!observationComplete) params.providerActivityLedger.noteObservationLost();
            // A stopped provider process orphans its background tasks: no terminal event for them
            // can arrive, and kept in the ledger the next turn-end publish would project them as
            // `active` again for the rest of the process. A lost observer alone proves nothing about
            // the process, so its tasks stay until their own evidence or the process exit settles them.
            const abandoned = options?.providerStopped === true
                ? params.providerActivityLedger.abandonActiveProviderTasks()
                : [];
            if (abandoned.length > 0) {
                logger.infoFile('[claudeProviderRuntimeActivity] Abandoned provider tasks after process exit', {
                    reasonCode,
                    abandoned,
                });
            }
            if (!observationOffered) return;
            await enqueueProjection(currentProjection(), reasonCode);
        },
    };
}

export function createClaudeProviderRuntimeActivityBindingOwner(
    contributionHandle: SessionRuntimeActivityContributionHandle,
) {
    let bindingEpoch = 0;
    let disposed = false;
    return Object.freeze({
        async activate() {
            if (disposed) {
                throw new Error('Claude provider Runtime Activity binding owner is disposed');
            }
            const epoch = ++bindingEpoch;
            return Object.freeze({
                providerTasks: contributionHandle,
                isCurrentRuntime: () => !disposed && bindingEpoch === epoch,
            });
        },
        invalidate() {
            if (disposed) return;
            disposed = true;
            bindingEpoch += 1;
        },
    });
}
