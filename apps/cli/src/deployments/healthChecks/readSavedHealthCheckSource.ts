import { WorkflowTriggerListResultV1Schema,
    type WorkflowTriggerListRequestV1, type WorkflowTriggerHealthSourceV1,
} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

export type SavedHealthCheckSourceRead =
    | Readonly<{ kind: 'available' } & WorkflowTriggerHealthSourceV1>
    | Readonly<{ kind: 'unconfigured' }>
    | Readonly<{ kind: 'unavailable'; code: string }>;

/** The saved source owner alone decides whether off-app alerts are paused. */
export function projectSavedHealthAlertSelection(source: WorkflowTriggerHealthSourceV1):
    Readonly<{ kind: 'active'; alerts: WorkflowTriggerHealthSourceV1['source']['alerts'] } | { kind: 'paused' }> {
    return source.enabled ? { kind: 'active', alerts: source.source.alerts } : { kind: 'paused' };
}

/** One public source read supplies both Health and Alerts; the retained Event owner decides its facts. */
export async function readSavedHealthCheckSourcesForHost(input: Readonly<{
    sourceInstanceIds: readonly string[]; signal?: AbortSignal;
}>, host: Readonly<{
    list(request: WorkflowTriggerListRequestV1, signal?: AbortSignal): Promise<unknown>;
}>): Promise<ReadonlyMap<string, SavedHealthCheckSourceRead>> {
    input.signal?.throwIfAborted();
    const selected = [...new Set(input.sourceInstanceIds)];
    if (selected.length === 0) return new Map();
    try {
        const raw = await host.list({ healthSource: { sourceInstanceIds: selected } }, input.signal);
        input.signal?.throwIfAborted();
        const result = WorkflowTriggerListResultV1Schema.parse(raw);
        const sources = new Map(result.healthSources?.map(source => [source.sourceInstanceId, source]));
        return new Map<string, SavedHealthCheckSourceRead>(selected.map(id => {
            const source = sources.get(id);
            return [id, source ? { kind: 'available', ...source } : { kind: 'unconfigured' }];
        }));
    } catch (error) {
        input.signal?.throwIfAborted();
        const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'health_check_source_unavailable';
        return new Map<string, SavedHealthCheckSourceRead>(selected.map(id => [id, { kind: 'unavailable', code }]));
    }
}

export async function readSavedHealthCheckSourceForHost(input: Readonly<{
    sourceInstanceId: string; signal?: AbortSignal;
}>, host: Parameters<typeof readSavedHealthCheckSourcesForHost>[1]): Promise<SavedHealthCheckSourceRead> {
    return (await readSavedHealthCheckSourcesForHost({ sourceInstanceIds: [input.sourceInstanceId],
        signal: input.signal }, host)).get(input.sourceInstanceId)!;
}
