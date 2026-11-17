import { healthResultProjectionIdentity, readHealthResultProjections,
    type HealthResultProjection, type HealthResultProjectionPage } from '@happier-dev/plugins-machine-services/health-results';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { AccountKvService } from '@happier-dev/plugin-sdk/storage';
import type { HealthCheckResultV1 } from '@happier-dev/plugin-sdk';
import { runSavedHealthCheck, type SavedHealthCheckRunInput } from '@happier-dev/plugins-machine-services/health-results';
import { createFrontDoorUiActionExecutor, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

export type ConfiguredHealthResultsState = Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'neverObserved' }>
    | Readonly<{ kind: 'notLoaded' }> | Readonly<{ kind: 'unavailable'; code: string }>
    | Readonly<{ kind: 'available'; checks: HealthResultProjection['checks']; source?: HealthResultProjectionPage['items'][number]['source'] }>;
export const CONFIGURED_HEALTH_LOADING: ConfiguredHealthResultsState = Object.freeze({ kind: 'loading' });
const NEVER_OBSERVED: ConfiguredHealthResultsState = Object.freeze({ kind: 'neverObserved' });
const NOT_LOADED: ConfiguredHealthResultsState = Object.freeze({ kind: 'notLoaded' });
export type ConfiguredHealthResultsSnapshot = ReadonlyMap<string, Readonly<{ revision: number; selector: string; state: ConfiguredHealthResultsState }>>;
export type ConfiguredHealthResultsPage = Readonly<{ results: ConfiguredHealthResultsSnapshot; nextCursor?: string; preceding: boolean }>;
export type ConfiguredHealthResultsRead = ConfiguredHealthResultsPage | Readonly<{ kind: 'unavailable'; code: string }>;
export const configuredHealthResultKey = (automationId: string, triggerId: string) => JSON.stringify([automationId, triggerId]);

/** The retained source owns Check identity; the reader's captured Account scope owns its Home. */
export function configuredHealthCheckAutomationSubject(state: ConfiguredHealthResultsState, checkId: string,
    serverId: string): Extract<AutomationSubjectV1, { kind: 'healthCheck' }> | null {
    if (state.kind !== 'available' || !state.source || !state.checks.some(check => check.checkId === checkId)) return null;
    return { kind: 'healthCheck', serverId, sourceInstanceId: state.source.sourceInstanceId, checkId };
}

/** The existing public Action front door owns policy, approval and Machine targeting. */
export async function checkNowConfiguredHealthCheck(input: SavedHealthCheckRunInput & Readonly<{
    serverId: string; expectedAccountId?: string;
}>, execute = createFrontDoorUiActionExecutor(undefined, { serverId: input.serverId, expectedAccountId: input.expectedAccountId }),
    operation?: UiActionOperation): Promise<HealthCheckResultV1> {
    return (await runSavedHealthCheck(input, (action, value, options) => execute('action.invoke', { action, input: value },
        { ...operation, signal: options.signal }))).result;
}

/** observedAt is the actual probe time retained with the current sample history. */
export function configuredHealthResultsForTrigger(page: ConfiguredHealthResultsPage, automationId: string,
    trigger: Readonly<{ id: string; revision: number; sourceSelectorId: string }>): ConfiguredHealthResultsState {
    const result = page.results.get(configuredHealthResultKey(automationId, trigger.id));
    return result?.revision === trigger.revision && result.selector === trigger.sourceSelectorId ? result.state
        : page.preceding || page.nextCursor !== undefined ? NOT_LOADED : NEVER_OBSERVED;
}

/** One native page per demand. More pages require the person's continuation; no row performs a read. */
export async function readConfiguredHealthResults(kv: Pick<AccountKvService, 'list'>, signal: AbortSignal,
    previous: ConfiguredHealthResultsPage, cursor?: string): Promise<ConfiguredHealthResultsPage> {
    const page = await readHealthResultProjections(kv, { signal, cursor });
    const next = new Map<string, Readonly<{ revision: number; selector: string; state: ConfiguredHealthResultsState }>>();
    for (const { projection, source } of page.items) {
        for (const member of projection.members) {
            const key = configuredHealthResultKey(member.automationId, member.triggerId);
            const prior = previous.results.get(key);
            const retainedSource = retainDeep(prior?.state.kind === 'available' ? prior.state.source : undefined, source);
            const equal = prior?.state.kind === 'available' && prior.revision === member.triggerRevision
                && prior.selector === member.sourceSelectorId && prior.state.source === retainedSource
                && healthResultProjectionIdentity({ ...projection, checks: prior.state.checks }) === healthResultProjectionIdentity(projection);
            next.set(key, equal ? prior : { revision: member.triggerRevision, selector: member.sourceSelectorId,
                state: { kind: 'available', checks: projection.checks, ...(retainedSource ? { source: retainedSource } : {}) } });
        }
    }
    const results = next.size === previous.results.size && [...next].every(([key, value]) => previous.results.get(key) === value) ? previous.results : next;
    const preceding = cursor !== undefined;
    return results === previous.results && page.nextCursor === previous.nextCursor && preceding === previous.preceding ? previous
        : { results, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), preceding };
}

/** Share concurrent acquisition. Push returns to the first page; continuation selects one following page. */
export function observeConfiguredHealthResults(input: Readonly<{ kv: Pick<AccountKvService, 'list'>; signal: AbortSignal;
    subscribe(listener: () => void): () => void; publish(snapshot: ConfiguredHealthResultsRead): void }>) {
    let previous: ConfiguredHealthResultsPage = { results: new Map(), preceding: false };
    let published: ConfiguredHealthResultsRead | undefined;
    let cursor: string | undefined;
    let running = false;
    let pending = false;
    const refresh = async () => {
        pending = true;
        if (running) return;
        running = true;
        try {
            while (pending && !input.signal.aborted) {
                pending = false;
                try {
                    const next = await readConfiguredHealthResults(input.kv, input.signal, previous, cursor);
                    if (!input.signal.aborted) { previous = next; if (published !== next) { published = next; input.publish(next); } }
                } catch (error) {
                    if (!input.signal.aborted) {
                        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'health_result_read_failed';
                        if (!published || !('kind' in published) || published.code !== code) { published = { kind: 'unavailable', code }; input.publish(published); }
                    }
                }
            }
        } finally { running = false; }
    };
    const unsubscribe = input.subscribe(() => { cursor = undefined; void refresh(); });
    void refresh();
    return { dispose: unsubscribe, loadNext() { cursor = previous.nextCursor; void refresh(); } };
}
