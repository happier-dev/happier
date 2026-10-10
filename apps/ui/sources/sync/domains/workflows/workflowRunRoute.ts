import { WorkflowInvocationRecordIdSchema, WorkflowRunIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';

/** The Workflows collection, whose Saved/Runs views are route-selected. */
export const WORKFLOWS_ROUTE = '/workflows';

/**
 * The exact Run route. One owner so a notification tap, an agent result link
 * and a list row all address the same Run the same way, and so no caller has to
 * remember to encode the id.
 */
export function createWorkflowRunRoute(runId: string, serverId?: string | null): string {
    return appendWorkflowRunHome(`${WORKFLOWS_ROUTE}/runs/${encodeURIComponent(runId)}`, serverId);
}

/** An optional exact Home belongs to the route owner, after any invocation query. */
function appendWorkflowRunHome(route: string, serverId?: string | null): string {
    if (!serverId) return route;
    return `${route}${route.includes('?') ? '&' : '?'}serverId=${encodeURIComponent(serverId)}`;
}

/** The exact saved workflow's editor route (also the link a document share sheet copies). */
export function createWorkflowDefinitionRoute(definitionId: string): string {
    return `${WORKFLOWS_ROUTE}/${encodeURIComponent(definitionId)}`;
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
): string | null {
    if (workflowRun === undefined) return null;
    const runId = readWorkflowRunId(workflowRun.workflowRunId);
    return runId === null ? null : createWorkflowRunRoute(runId);
}

/**
 * Where one Automation history row opens.
 *
 * A definition whose `targetType` is `null` is, by the definition owner's own
 * contract, a strict managed-workflow recipe; and the admission receipt schema
 * binds `workflowRunId` to the returned Run id, so that Automation's Run ids
 * *are* Workflow Run ids. Such a row therefore composes the one shared managed
 * Run body rather than a second, materially different detail experience.
 *
 * This is a declared server-authored fact, not a recipe-shape inference. Every
 * other target keeps the incumbent Automation Run detail unchanged, and a
 * malformed id falls back to it rather than becoming Workflow navigation.
 */
export function createAutomationRunDetailRoute(params: Readonly<{
    automationId: string;
    runId: string;
    /** `AutomationDefinitionListItem['targetType']`, verbatim. */
    targetType: string | null;
}>): Readonly<{ pathname: string; params: Record<string, string> }> {
    const legacy = {
        pathname: '/automations/[id]/runs/[runId]',
        params: { id: params.automationId, runId: params.runId },
    } as const;
    if (params.targetType !== null) return legacy;
    const runId = readWorkflowRunId(params.runId);
    return runId === null
        ? legacy
        : { pathname: '/workflows/runs/[runId]', params: { runId } };
}

/** Address one exact invocation while retaining the Run as the route owner. */
export function createWorkflowInvocationRoute(runId: string, invocationId: string, serverId?: string | null): string {
    return appendWorkflowRunHome(`${createWorkflowRunRoute(runId)}?invocationId=${encodeURIComponent(invocationId)}`, serverId);
}

/**
 * Link an attached or detached leaf to the existing machine Run inspector.
 *
 * The inspector can identify a daemon Run only from the complete Home +
 * Machine + Run tuple. Callers omit the link when any opaque identity is not
 * exact instead of opening a broader collection that looks like the target.
 */
export function createMachineExecutionRunRoute(serverId: string, machineId: string, runId: string): string | null {
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
