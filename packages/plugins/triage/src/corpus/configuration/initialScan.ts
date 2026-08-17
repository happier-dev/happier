import {
    createTriageRefreshCoordinator,
    type TriageRefreshCoordinatorV1,
    type TriageRefreshPassOutcomeV1,
} from '../../refresh/refreshCoordinator.js';

/**
 * The one bounded pass that follows explicit source configuration.
 *
 * `core/CORPUS.md` §4.1 names explicit configuration and reactivation as one of
 * the few materialization producers, and it produces exactly one immediate pass
 * for that exact instance — not a poll, not a schedule, and nothing durable. If
 * it is interrupted or the provider is unavailable, the next qualifying view or
 * manual trigger simply starts again from the first page.
 *
 * The single-flight itself is not written here. This owner holds the shipped
 * `TriageRefreshCoordinatorV1`, so a Select-all configuration scope, a
 * double-submitted Settings form and a retried Action all collapse into one
 * provider read per configured instance by construction rather than by a local
 * boolean. Nothing survives the process: the map, the pacing state and the
 * in-flight pass all disappear with it.
 */

export type TriageInitialScanPassV1 = (
    input: Readonly<{ signal: AbortSignal }>,
) => Promise<TriageRefreshPassOutcomeV1>;

export type TriageInitialScanOwnerV1 = Readonly<{
    /**
     * Requests the one pass for a just-configured instance and settles when it
     * reaches idle. The registered pass carries everything provider-specific,
     * so this owner never learns a source id, an account or a routing value.
     */
    request(input: Readonly<{
        sourceInstanceId: string;
        pass: TriageInitialScanPassV1;
    }>): Promise<void>;
    /** Retirement, reconfiguration or contribution loss for one instance. */
    retire(sourceInstanceId: string): void;
    dispose(): void;
}>;

export function createTriageInitialScanOwner(deps: Readonly<{
    nowMs: () => number;
    onUnexpectedError?: (error: unknown) => void;
}>): TriageInitialScanOwnerV1 {
    const passes = new Map<string, TriageInitialScanPassV1>();

    const coordinator: TriageRefreshCoordinatorV1 = createTriageRefreshCoordinator({
        runPass: async ({ sourceInstanceId, signal }) => {
            const pass = passes.get(sourceInstanceId);
            // A pass withdrawn by retirement between the request and the drain
            // is an interruption, never provider evidence about the source.
            if (!pass) return { kind: 'interrupted' };
            return await pass({ signal });
        },
        nowMs: deps.nowMs,
        ...(deps.onUnexpectedError ? { onUnexpectedError: deps.onUnexpectedError } : {}),
    });

    return Object.freeze({
        async request(input): Promise<void> {
            passes.set(input.sourceInstanceId, input.pass);
            await coordinator.request({
                sourceInstanceId: input.sourceInstanceId,
                trigger: 'sourceConfigured',
            }).settled;
        },
        retire(sourceInstanceId): void {
            passes.delete(sourceInstanceId);
            coordinator.retire(sourceInstanceId);
        },
        dispose(): void {
            passes.clear();
            coordinator.dispose();
        },
    });
}
