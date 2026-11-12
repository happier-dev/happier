import { ExecutionRunGetResponseSchema, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { OtherFollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/followSourceRefTransportV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { subscribeExecutionRunActivity } from './executionRunActivityBus';

type Source = Extract<OtherFollowSourceRefV1, { kind: 'execution_run' }>;
export type ExecutionRunHeaderReference = Readonly<{ source: Source; demanded: boolean; refreshKey: string }>;
export type ExecutionRunHeaderSnapshot = Readonly<{
    run?: ExecutionRunPublicState; loading: boolean; failed: boolean;
    unavailable?: 'target_unavailable';
}>;
/** A known offline target is a settled Run state, not an incomplete source read. */
export function isExecutionRunTargetUnavailable(code: string | null | undefined): boolean {
    return code === 'target_unavailable' || code === 'execution_run_target_unavailable' || code === 'machine_offline';
}
const UNREAD: ExecutionRunHeaderSnapshot = Object.freeze({ loading: true, failed: false });
const executionRunHeaderKey = (source: Source): string => JSON.stringify('sessionId' in source
    ? ['session', source.sessionId, source.runId] : ['machine', source.machineId, source.runId]);
type Interest = Readonly<{ notify(): void; demanded: boolean; refreshKey: string }>;
type Header = {
    source: Source; snapshot: ExecutionRunHeaderSnapshot; interests: Map<object, Interest>;
    request: AbortController | null; dirty: boolean; dispose(): void;
};
const headers = new WeakMap<ServerAccountScopeLifetime, Map<string, Header>>();

function publish(header: Header, next: ExecutionRunHeaderSnapshot): void {
    const previous = header.snapshot;
    const run = next.run && previous.run && JSON.stringify(next.run) === JSON.stringify(previous.run) ? previous.run : next.run;
    if (previous.run === run && previous.loading === next.loading && previous.failed === next.failed
        && previous.unavailable === next.unavailable) return;
    header.snapshot = { ...next, ...(run ? { run } : {}) };
    for (const interest of header.interests.values()) interest.notify();
}

function demanded(header: Header): boolean { return [...header.interests.values()].some(interest => interest.demanded); }

function refresh(header: Header, lifetime: ServerAccountScopeLifetime): void {
    header.dirty = true;
    if (header.request || !demanded(header) || !lifetime.isCurrent()) return;
    const controller = new AbortController();
    header.request = controller;
    const current = () => header.request === controller && !controller.signal.aborted && lifetime.isCurrent();
    publish(header, { ...header.snapshot, loading: true });
    void (async () => {
        do {
            header.dirty = false;
            publish(header, { ...header.snapshot, loading: true });
            try {
                const source = header.source;
                const response = await callWorkflowAction({ actionId: 'execution.run.get',
                    input: { runId: source.runId, sessionId: 'sessionId' in source ? source.sessionId : null,
                        includeStructured: false, includeLatestToolResult: false },
                    context: 'machineId' in source ? { executionRunTargetMachineId: source.machineId } : undefined,
                    accountLifetime: lifetime, signal: controller.signal, parseResult: value => ExecutionRunGetResponseSchema.parse(value) });
                if (!current()) return;
                if (response.run.runId !== source.runId) throw new Error('execution_run_source_mismatch');
                publish(header, { run: response.run, loading: false, failed: false });
            } catch (error) {
                if (!current()) return;
                const unavailable = error instanceof WorkflowActionError && isExecutionRunTargetUnavailable(error.rawCode);
                const retain = unavailable || error instanceof WorkflowActionError && error.rawCode === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE;
                publish(header, { ...(retain && header.snapshot.run ? { run: header.snapshot.run } : {}),
                    loading: false, failed: !unavailable, ...(unavailable ? { unavailable: 'target_unavailable' } : {}) });
            }
        } while (header.dirty && current() && demanded(header));
    })().finally(() => { if (header.request === controller) header.request = null; });
}

/** Exact lean headers share acquisition, outage retention and push draining at the Run owner. */
export function createExecutionRunHeaderDemand(lifetime: ServerAccountScopeLifetime, notify: () => void) {
    const consumer = {};
    const retained = new Map<string, Header>();
    const release = (key: string, header: Header) => {
        header.interests.delete(consumer);
        if (!demanded(header)) {
            header.request?.abort(); header.request = null;
            if (header.snapshot.loading) { header.dirty = true; publish(header, { ...header.snapshot, loading: false }); }
        }
        if (header.interests.size === 0) { header.dispose(); headers.get(lifetime)?.delete(key); }
        retained.delete(key);
    };
    return {
        update(references: readonly ExecutionRunHeaderReference[]) {
            const keys = new Set(references.map(reference => executionRunHeaderKey(reference.source)));
            for (const [key, header] of retained) if (!keys.has(key)) release(key, header);
            for (const reference of references) {
                const key = executionRunHeaderKey(reference.source);
                let scoped = headers.get(lifetime);
                if (!scoped) { scoped = new Map(); headers.set(lifetime, scoped); }
                let header = scoped.get(key);
                if (!header) {
                    const ownedHeaders = scoped;
                    const source = reference.source;
                    const created: Header = { source, snapshot: UNREAD, interests: new Map(), request: null, dirty: true, dispose() {} };
                    const address = 'sessionId' in source ? { serverId: lifetime.scope.serverId, sessionId: source.sessionId }
                        : { serverId: lifetime.scope.serverId, machineId: source.machineId };
                    const activity = subscribeExecutionRunActivity(address, event => {
                        if (event.runId === null || event.runId === source.runId) refresh(created, lifetime);
                    });
                    const changes = subscribeHomeAccountChange(event => {
                        if (areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)
                            && (event.source === 'connected' || event.entityIds === undefined
                                || 'sessionId' in source && event.entityIds.includes(source.sessionId))) refresh(created, lifetime);
                    }, { reconnect: 'refresh' });
                    const retirement = lifetime.onRetire(() => {
                        created.request?.abort(); created.request = null;
                        publish(created, { loading: false, failed: true });
                        created.dispose(); ownedHeaders.delete(key);
                    });
                    created.dispose = () => { activity(); changes(); retirement.dispose(); };
                    header = created; scoped.set(key, header);
                }
                const previous = header.interests.get(consumer);
                header.interests.set(consumer, { ...reference, notify });
                retained.set(key, header);
                if (previous && previous.refreshKey !== reference.refreshKey) header.dirty = true;
                if (reference.demanded && header.dirty) refresh(header, lifetime);
                else if (!demanded(header) && header.request) {
                    header.request.abort(); header.request = null; header.dirty = true;
                    publish(header, { ...header.snapshot, loading: false });
                }
            }
            notify();
        },
        read(source: Source): ExecutionRunHeaderSnapshot { return retained.get(executionRunHeaderKey(source))?.snapshot ?? UNREAD; },
        dispose() { for (const [key, header] of retained) release(key, header); },
    };
}
