import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';

type WorkItem = Exclude<SessionListIndexItem, { type: 'header' }>;

/** Only an admitted Agent start makes the origin Session the Run's list parent. */
export function resolveWorkflowRunParentSessionId(summary: WorkflowRunSummaryV1 | null | undefined): string | null {
    return summary?.startedBy === 'agent' ? summary.origin.originSessionId ?? null : null;
}

/** One parent-work tree: reportsTo stays group-local; workflow steps belong only to their Run. */
export function nestSessionListReports(
    items: SessionListIndexItem[],
    resolveSessionRow: (serverId: string | null, sessionId: string) => SessionListRenderableSession | null,
    resolveRunOriginSession?: (serverId: string, runId: string) => string | null,
): SessionListIndexItem[] {
    const byKey = new Map<string, WorkItem>();
    const groups = new Map<WorkItem, number>();
    let group = 0;
    let previousGroupKey: string | undefined;
    for (const item of items) {
        if (item.type === 'header') { group += 1; previousGroupKey = undefined; continue; }
        if (previousGroupKey !== item.groupKey) group += 1;
        previousGroupKey = item.groupKey;
        groups.set(item, group);
        byKey.set(buildSessionListIndexNodeId(item), item);
    }
    const parentByItem = new Map<WorkItem, WorkItem>();
    const children = new Map<WorkItem, WorkItem[]>();
    const orphanSteps = new Set<WorkItem>();
    const sessionKey = (serverId: string | undefined, sessionId: string) => buildSessionListIndexNodeId({ type: 'session', serverId, sessionId });
    for (const item of byKey.values()) {
        let parent: WorkItem | undefined;
        if (item.type === 'session') {
            const row = resolveSessionRow(item.serverId ?? null, item.sessionId);
            if (row?.origin?.kind === 'run_step') {
                parent = item.serverId && row.origin.runId ? byKey.get(buildSessionListIndexNodeId({
                    type: 'workflow_run', serverId: item.serverId, runId: row.origin.runId,
                })) : undefined;
                if (!parent) orphanSteps.add(item);
            } else {
                const lead = row?.reportsTo?.sessionId;
                const candidate = lead ? byKey.get(sessionKey(item.serverId, lead)) : undefined;
                if (candidate && candidate !== item && groups.get(candidate) === groups.get(item)) parent = candidate;
            }
        } else {
            const origin = resolveRunOriginSession?.(item.serverId, item.runId);
            const candidate = origin ? byKey.get(sessionKey(item.serverId, origin)) : undefined;
            // A Run cannot be nested under one of its own steps.
            const candidateOrigin = candidate?.type === 'session'
                ? resolveSessionRow(candidate.serverId ?? null, candidate.sessionId)?.origin : null;
            if (candidate && !(candidateOrigin?.kind === 'run_step' && candidateOrigin.runId === item.runId)) parent = candidate;
        }
        if (parent) {
            parentByItem.set(item, parent);
            const siblings = children.get(parent) ?? [];
            siblings.push(item);
            children.set(parent, siblings);
        }
    }
    // Break a transient reportsTo cycle at its first observed member, before
    // walking the original groups. Appending it after the final header would
    // silently move the whole cycle into another group.
    const checkedParents = new Set<WorkItem>();
    for (const item of byKey.values()) {
        const path: WorkItem[] = [];
        const pathPositions = new Map<WorkItem, number>();
        let current: WorkItem | undefined = item;
        while (current && !checkedParents.has(current)) {
            const cycleAt = pathPositions.get(current);
            if (cycleAt !== undefined) {
                const root = path[cycleAt]!;
                if (!orphanSteps.has(root) && !(root.type === 'session'
                    && resolveSessionRow(root.serverId ?? null, root.sessionId)?.origin?.kind === 'run_step')) {
                    parentByItem.delete(root);
                }
                break;
            }
            pathPositions.set(current, path.length);
            path.push(current);
            current = parentByItem.get(current);
        }
        for (const member of path) checkedParents.add(member);
    }
    const output: SessionListIndexItem[] = [];
    const visited = new Set<WorkItem>();
    const emit = (item: WorkItem, depth: number, groupOwner: WorkItem = item) => {
        if (visited.has(item) || orphanSteps.has(item)) return;
        visited.add(item);
        const movedGroup = depth > 0 && groups.get(item) !== groups.get(groupOwner);
        const parent = item.type === 'session' && (children.get(item)?.length ?? 0) > 0;
        const defaultCollapsed = parent && item.type === 'session'
            && resolveSessionRow(item.serverId ?? null, item.sessionId)?.metadata?.bot?.kind === 'bot';
        const { reportsDepth: _oldDepth, ...withDefault } = item;
        const rest = withDefault.type === 'session'
            ? (({ reportsDefaultCollapsed: _oldDefault, reportsParent: _oldParent, reportsCollapsed: _oldCollapsed, ...fields }) => fields)(withDefault)
            : withDefault;
        output.push(!movedGroup && (item.reportsDepth ?? 0) === depth
            && (item.type !== 'session' || ((item.reportsDefaultCollapsed === true) === defaultCollapsed
                && (item.reportsParent === true) === parent && item.reportsCollapsed === undefined)) ? item : {
            ...rest,
            ...(depth > 0 ? { reportsDepth: depth } : {}),
            ...(parent ? { reportsParent: true as const } : {}),
            ...(defaultCollapsed ? { reportsDefaultCollapsed: true as const } : {}),
            ...(movedGroup ? {
                groupKey: groupOwner.groupKey, groupKind: groupOwner.groupKind,
                workspace: groupOwner.workspace, section: groupOwner.section,
                folderId: groupOwner.folderId, folderDepth: groupOwner.folderDepth,
            } : {}),
        });
        for (const child of children.get(item) ?? []) emit(child, depth + 1, groupOwner);
    };
    for (const item of items) {
        if (item.type === 'header') output.push(item);
        else if (!parentByItem.has(item)) emit(item, 0);
    }
    return output.length === items.length && output.every((item, i) => item === items[i]) ? items : output;
}
