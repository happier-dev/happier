import { WorkflowRunSourceV1Schema, type WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { DiscussionAddressV1Schema, type DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { t } from '@/text';

export type WorkflowStartSource = Extract<WorkflowRunStartRequestV1['source'], { kind: 'saved' | 'catalog' }>;
export type WorkflowStartOrigin = Readonly<{ kind: 'discussion'; discussion: DiscussionAddressV1 }>;
export type WorkflowStartResource = Readonly<{ kind: 'workflowStart'; source: WorkflowStartSource; origin?: WorkflowStartOrigin }>;

/** Details stores only a qualified definition reference; authored content belongs to its mounted body. */
export function createWorkflowStartDetailsTab(source: WorkflowStartSource, title?: string, origin?: WorkflowStartOrigin): DetailsTab {
    return { key: `workflowStart:${JSON.stringify([source, origin ?? null])}`, kind: 'workflowStart',
        title: title ?? t('workflows.start.workflow'), resource: { kind: 'workflowStart', source, ...(origin ? { origin } : {}) } };
}

export function isWorkflowStartResource(value: unknown): value is WorkflowStartResource {
    if (value === null || typeof value !== 'object' || !('kind' in value) || value.kind !== 'workflowStart' || !('source' in value)) return false;
    const source = WorkflowRunSourceV1Schema.safeParse(value.source);
    if (!source.success || source.data.kind === 'inline') return false;
    if (!('origin' in value) || value.origin === undefined) return true;
    const origin = value.origin;
    return origin !== null && typeof origin === 'object' && 'kind' in origin && origin.kind === 'discussion'
        && 'discussion' in origin && DiscussionAddressV1Schema.safeParse(origin.discussion).success;
}

