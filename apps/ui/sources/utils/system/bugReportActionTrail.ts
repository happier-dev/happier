export type BugReportUserAction = {
    timestamp: string;
    action: string;
    route?: string;
    metadata?: Record<string, string | number | boolean>;
};

const DEFAULT_MAX_ACTIONS = 250;
let maxActions = DEFAULT_MAX_ACTIONS;
const actionTrail: BugReportUserAction[] = [];

function sanitizeMetadata(
    metadata: Record<string, unknown> | undefined
): Record<string, string | number | boolean> | undefined {
    if (!metadata) return undefined;
    const sanitized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === 'string') {
            sanitized[key] = value.slice(0, 300);
            continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            sanitized[key] = value;
        }
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function appendAction(action: BugReportUserAction): void {
    actionTrail.push(action);
    if (actionTrail.length <= maxActions) return;
    actionTrail.splice(0, actionTrail.length - maxActions);
}

export function configureBugReportUserActionTrail(options?: { maxActions?: number }): void {
    if (typeof options?.maxActions !== 'number' || !Number.isFinite(options.maxActions)) return;
    maxActions = Math.max(1, Math.floor(options.maxActions));
    if (actionTrail.length > maxActions) {
        actionTrail.splice(0, actionTrail.length - maxActions);
    }
}

export function recordBugReportUserAction(action: string, input?: {
    route?: string;
    metadata?: Record<string, unknown>;
}): void {
    const normalizedAction = action.trim();
    if (!normalizedAction) return;
    appendAction({
        timestamp: new Date().toISOString(),
        action: normalizedAction.slice(0, 120),
        route: input?.route ? input.route.slice(0, 300) : undefined,
        metadata: sanitizeMetadata(input?.metadata),
    });
}

export function getBugReportUserActionTrail(options?: { sinceMs?: number }): BugReportUserAction[] {
    if (typeof options?.sinceMs !== 'number' || !Number.isFinite(options.sinceMs)) {
        return actionTrail.slice();
    }
    return actionTrail.filter((entry) => {
        const parsed = Date.parse(entry.timestamp);
        return Number.isFinite(parsed) && parsed >= options.sinceMs!;
    });
}

export function clearBugReportUserActionTrail(): void {
    actionTrail.length = 0;
}
