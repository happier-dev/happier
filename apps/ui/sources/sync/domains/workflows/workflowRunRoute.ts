import { WorkflowInvocationRecordIdSchema, WorkflowRunIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

/** The Workflows collection, whose Saved/Runs views are route-selected. */
export const WORKFLOWS_ROUTE = '/workflows';

export type WorkflowRunRouteTarget = Readonly<
    | { kind: 'managed'; runId: string }
    | { kind: 'occurrence'; automationId: string; runId: string }
>;

function routeParam(value: unknown): string | null {
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' && first.length > 0 ? first : null;
}

/** Select the reader from the declared route identity, never from a failed read. */
export function readWorkflowRunTarget(params: Readonly<Record<string, unknown>>): WorkflowRunRouteTarget | null {
    const runId = readWorkflowRunId(routeParam(params.runId));
    if (!runId) return null;
    const target = routeParam(params.target);
    if (target === 'occurrence') {
        const automationId = routeParam(params.automationId);
        return automationId && automationId === automationId.trim() ? { kind: 'occurrence', automationId, runId } : null;
    }
    return (params.target === undefined || target === 'managed') && params.automationId === undefined
        ? { kind: 'managed', runId } : null;
}

/**
 * The exact Run route. One owner so a notification tap, an agent result link
 * and a list row all address the same Run the same way, and so no caller has to
 * remember to encode the id.
 */
export function createWorkflowRunRoute(target: string | WorkflowRunRouteTarget, serverId?: string | null): `/workflows/runs/${string}` {
    const runId = typeof target === 'string' ? target : target.runId;
    const route: `/workflows/runs/${string}` = `${WORKFLOWS_ROUTE}/runs/${encodeURIComponent(runId)}`;
    return appendWorkflowRunHome(typeof target !== 'string' && target.kind === 'occurrence'
        ? `${route}?target=occurrence&automationId=${encodeURIComponent(target.automationId)}` : route, serverId);
}

/** A held Run row already declares its reader, including retained Automation occurrences. */
export function createWorkflowRunListRowRoute(row: Readonly<{
    id: string;
    summary: Pick<WorkflowRunSummaryV1, 'origin'> | null;
    automation: Readonly<{ automationId: string }> | null;
}>, serverId?: string | null): ReturnType<typeof createWorkflowRunRoute> {
    const origin = row.summary?.origin;
    const automationId = origin ? (origin.kind === 'automation' ? origin.automationId : undefined) : row.automation?.automationId;
    return createWorkflowRunRoute(automationId ? { kind: 'occurrence', automationId, runId: row.id } : row.id, serverId);
}

/**
 * The Run (and invocation) one of this owner's own route strings addresses, or `null` for anything
 * else. A host that shows a Run inside a pane reads its navigation back through this, so opening a
 * step stays in the pane while every other destination leaves it.
 */
export function readWorkflowRunRouteTarget(href: unknown): Readonly<{ runId: string; invocationId: string | null }> | null {
    if (typeof href !== 'string') return null;
    const [path, query = ''] = href.split('?', 2);
    const prefix = `${WORKFLOWS_ROUTE}/runs/`;
    if (!path?.startsWith(prefix)) return null;
    const segment = path.slice(prefix.length);
    if (segment.length === 0 || segment.includes('/')) return null;
    let runId: string;
    try { runId = decodeURIComponent(segment); } catch { return null; }
    const search = new URLSearchParams(query);
    const target = readWorkflowRunTarget({ runId, ...(search.has('target') ? { target: search.get('target') } : {}),
        ...(search.has('automationId') ? { automationId: search.get('automationId') } : {}) });
    // An invocation link in the managed Run peek must not replace its body with a different reader.
    if (target?.kind !== 'managed') return null;
    const invocationId = search.get('invocationId');
    return { runId, invocationId: invocationId && invocationId.length > 0 ? invocationId : null };
}

/** An optional exact Home belongs to the route owner, after any invocation query. */
function appendWorkflowRunHome(route: `/workflows/runs/${string}`, serverId?: string | null): `/workflows/runs/${string}` {
    if (!serverId) return route;
    return `${route}${route.includes('?') ? '&' : '?'}serverId=${encodeURIComponent(serverId)}`;
}

/** The exact saved workflow's editor route (also the link a document share sheet copies). */
export function createWorkflowDefinitionRoute(definitionId: string, serverId?: string | null): `/workflows/${string}` {
    const route: `/workflows/${string}` = `${WORKFLOWS_ROUTE}/${encodeURIComponent(definitionId)}`;
    return serverId ? `${route}?serverId=${encodeURIComponent(serverId)}` : route;
}

/**
 * The exact managed Run an admission receipt declared, or `null`.
 *
 * `null` is the legacy one-shot Automation answer: the server said nothing
 * about a managed workflow, so there is no managed Run to open and the caller
 * keeps its existing acknowledgement behaviour. The correspondence is never
 * inferred from a recipe shape, and the id still goes through the canonical
 * identity schema so a malformed receipt cannot become navigation.
 */
export function createAdmittedWorkflowRunRoute(
    workflowRun: Readonly<{ recipeKind: 'workflow-v2'; workflowRunId: string }> | undefined,
    serverId?: string | null,
): ReturnType<typeof createWorkflowRunRoute> | null {
    if (workflowRun === undefined) return null;
    const runId = readWorkflowRunId(workflowRun.workflowRunId);
    return runId === null ? null : createWorkflowRunRoute(runId, serverId);
}

/** Address one exact invocation while retaining the Run as the route owner. */
export function createWorkflowInvocationRoute(runId: string, invocationId: string, serverId?: string | null): ReturnType<typeof createWorkflowRunRoute> {
    return appendWorkflowRunHome(`${createWorkflowRunRoute(runId)}?invocationId=${encodeURIComponent(invocationId)}`, serverId);
}

/**
 * Link an attached or detached leaf to the existing machine Run inspector.
 *
 * The inspector can identify a daemon Run only from the complete Home +
 * Machine + Run tuple. Callers omit the link when any opaque identity is not
 * exact instead of opening a broader collection that looks like the target.
 */
export function createMachineExecutionRunRoute(serverId: string, machineId: string, runId: string): `/runs?${string}` | null {
    if (!serverId || serverId !== serverId.trim()) return null;
    if (!machineId || machineId !== machineId.trim()) return null;
    if (!runId || runId !== runId.trim()) return null;
    return `/runs?serverId=${encodeURIComponent(serverId)}&machineId=${encodeURIComponent(machineId)}&runId=${encodeURIComponent(runId)}`;
}

/**
 * Validate a Run id supplied by an untrusted payload through the canonical
 * Protocol identity schema. A notification carries an id, never a route: an
 * arbitrary caller-supplied URL must not become navigation.
 */
export function readWorkflowRunId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value !== value.trim()) return null;
    const parsed = WorkflowRunIdV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function readWorkflowInvocationId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value !== value.trim()) return null;
    const parsed = WorkflowInvocationRecordIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
