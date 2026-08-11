import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';
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
    let observationState: 'inactive' | 'activating' | 'active' | 'failed' = 'inactive';
    let observationComplete = true;
    let lastPublishedProjection: ClaudeProviderRuntimeActivityProjection | null = null;
    let publicationTail: Promise<void> = Promise.resolve();

    const currentProjection = (): ClaudeProviderRuntimeActivityProjection => {
        const activeCount = params.providerActivityLedger.getActiveProviderTaskCount();
        if (activeCount > 0) return { state: 'active', activeCount };
        return observationComplete
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
            if (projection.state === 'unknown') {
                await params.contributionHandle.markUnknown(reason);
            } else {
                await params.contributionHandle.report(
                    projection,
                    reason,
                );
            }
            lastPublishedProjection = projection;
        };
        const result = publicationTail.then(publish, publish);
        publicationTail = result.catch(() => undefined);
        return result;
    };

    return {
        async activateObservation(reasonCode: string): Promise<void> {
            if (!isCurrentRuntime() || observationState !== 'inactive') return;
            observationState = 'activating';
            try {
                await enqueueProjection(currentProjection(), reasonCode);
                if (!isCurrentRuntime()) return;
                observationState = 'active';
                await enqueueProjection(currentProjection(), `${reasonCode}-current`);
            } catch (error) {
                observationState = 'failed';
                throw error;
            }
        },
        async observeActivity(input: Readonly<{
            activity: ClaudeProviderTaskActivity;
            evidence: ClaudeTaskEvidence;
        }>): Promise<void> {
            if (!isCurrentRuntime() || input.evidence !== 'live') return;
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
            if (!isCurrentRuntime() || observationState !== 'active') return;
            await enqueueProjection(currentProjection(), reasonCode);
        },
        async handleRuntimeLoss(reasonCode: string): Promise<void> {
            if (!isCurrentRuntime()) return;
            observationComplete = false;
            if (observationState !== 'active') return;
            // Observation loss is published as `unknown` whatever the ledger still holds. Tasks left
            // in flight when the query dies are not evidence of liveness — they are exactly the
            // tasks whose outcome we can no longer observe. Projecting `active` from that residue
            // is what left a dead session claiming background work forever.
            await enqueueProjection({ state: 'unknown', activeCount: 0 }, reasonCode);
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
