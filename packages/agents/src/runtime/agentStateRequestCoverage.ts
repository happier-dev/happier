export type AgentStateRequestCoverageRecord = Readonly<Record<string, unknown>>;

export type AgentStateRequestCoverageOptions = Readonly<{
    equivalentSources?: readonly string[];
    equivalentCompletedStatuses?: readonly string[];
    equivalentCompletedReasons?: readonly string[];
    equivalentCompletionWindowMs?: number;
}>;

export const DEFAULT_AGENT_STATE_EQUIVALENT_REQUEST_COMPLETION_WINDOW_MS = 5_000;

export type AgentStateRequestCoverageOptionsKind = 'localPermissionBridge';

const AGENT_STATE_REQUEST_COVERAGE_OPTIONS: Record<
    AgentStateRequestCoverageOptionsKind,
    AgentStateRequestCoverageOptions
> = {
    localPermissionBridge: {
        equivalentSources: ['claude_local_permission_bridge'],
        equivalentCompletedStatuses: ['canceled'],
        equivalentCompletedReasons: ['Local permission bridge stopped'],
    },
};

export function resolveAgentStateRequestCoverageOptions(input: Readonly<{
    kind: AgentStateRequestCoverageOptionsKind;
}>): AgentStateRequestCoverageOptions {
    const options = AGENT_STATE_REQUEST_COVERAGE_OPTIONS[input.kind];
    return {
        equivalentSources: [...(options.equivalentSources ?? [])],
        equivalentCompletedStatuses: [...(options.equivalentCompletedStatuses ?? [])],
        equivalentCompletedReasons: [...(options.equivalentCompletedReasons ?? [])],
        ...(typeof options.equivalentCompletionWindowMs === 'number'
            ? { equivalentCompletionWindowMs: options.equivalentCompletionWindowMs }
            : {}),
    };
}

function readRecord(value: unknown): AgentStateRequestCoverageRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as AgentStateRequestCoverageRecord
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readAgentStateRequestCompletedAt(value: unknown): number {
    const record = readRecord(value);
    if (!record) return 0;
    return Math.max(readNumber(record.completedAt) ?? 0, readNumber(record.createdAt) ?? 0);
}

function normalizeJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeJson(item));
    }
    const record = readRecord(value);
    if (!record) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(record)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, normalizeJson(item)]),
    );
}

function areJsonValuesEquivalent(left: unknown, right: unknown): boolean {
    try {
        return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
    } catch {
        return false;
    }
}

function listIncludes(values: readonly string[] | undefined, value: string | null): boolean {
    return !!value && Array.isArray(values) && values.includes(value);
}

function hasEquivalentCompletionMetadata(
    completed: AgentStateRequestCoverageRecord,
    options: AgentStateRequestCoverageOptions,
): boolean {
    const statuses = options.equivalentCompletedStatuses;
    if (Array.isArray(statuses) && statuses.length > 0 && !listIncludes(statuses, readString(completed.status))) {
        return false;
    }

    const reasons = options.equivalentCompletedReasons;
    if (Array.isArray(reasons) && reasons.length > 0 && !listIncludes(reasons, readString(completed.reason))) {
        return false;
    }

    return true;
}

function hasTerminalCompletionStatus(completed: AgentStateRequestCoverageRecord): boolean {
    const status = readString(completed.status);
    return !!status && status !== 'pending';
}

function haveEquivalentOwners(
    request: AgentStateRequestCoverageRecord,
    completed: AgentStateRequestCoverageRecord,
): boolean {
    const requestOwner = readRecord(request.owner);
    const completedOwner = readRecord(completed.owner);
    return !(requestOwner || completedOwner) || areJsonValuesEquivalent(requestOwner, completedOwner);
}

function hasOwnRecordKey(record: AgentStateRequestCoverageRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function areEquivalentCrossIdRequests(params: Readonly<{
    request: AgentStateRequestCoverageRecord;
    completed: AgentStateRequestCoverageRecord;
    options: AgentStateRequestCoverageOptions;
}>): boolean {
    const source = readString(params.request.source);
    if (!listIncludes(params.options.equivalentSources, source)) return false;
    if (readString(params.completed.source) !== source) return false;
    if (!hasEquivalentCompletionMetadata(params.completed, params.options)) return false;

    const tool = readString(params.request.tool);
    if (!tool || readString(params.completed.tool) !== tool) return false;

    const requestKind = readString(params.request.kind);
    const completedKind = readString(params.completed.kind);
    if (requestKind && completedKind && requestKind !== completedKind) return false;

    if (!haveEquivalentOwners(params.request, params.completed)) return false;

    if (!areJsonValuesEquivalent(params.request.arguments, params.completed.arguments)) return false;

    const requestCreatedAt = readNumber(params.request.createdAt);
    const completedAt = readAgentStateRequestCompletedAt(params.completed);
    if (requestCreatedAt === null || completedAt <= 0) return false;

    const windowMs = typeof params.options.equivalentCompletionWindowMs === 'number'
        && Number.isFinite(params.options.equivalentCompletionWindowMs)
        && params.options.equivalentCompletionWindowMs >= 0
        ? params.options.equivalentCompletionWindowMs
        : DEFAULT_AGENT_STATE_EQUIVALENT_REQUEST_COMPLETION_WINDOW_MS;
    return Math.abs(requestCreatedAt - completedAt) <= windowMs;
}

function areEquivalentSameIdRequests(params: Readonly<{
    request: AgentStateRequestCoverageRecord;
    completed: AgentStateRequestCoverageRecord;
    options: AgentStateRequestCoverageOptions;
}>): boolean {
    const source = readString(params.request.source);
    if (!listIncludes(params.options.equivalentSources, source)) return false;
    if (readString(params.completed.source) !== source) return false;
    if (!hasEquivalentCompletionMetadata(params.completed, params.options)) return false;

    const tool = readString(params.request.tool);
    if (!tool || readString(params.completed.tool) !== tool) return false;

    const requestKind = readString(params.request.kind);
    const completedKind = readString(params.completed.kind);
    if (requestKind && completedKind && requestKind !== completedKind) return false;

    const requestSource = readString(params.request.source);
    const completedSource = readString(params.completed.source);
    if ((requestSource || completedSource) && requestSource !== completedSource) return false;

    if (!haveEquivalentOwners(params.request, params.completed)) return false;

    if (
        hasOwnRecordKey(params.completed, 'arguments')
        && !areJsonValuesEquivalent(params.request.arguments, params.completed.arguments)
    ) {
        return false;
    }

    const requestCreatedAt = readNumber(params.request.createdAt);
    const completedAt = readAgentStateRequestCompletedAt(params.completed);
    if (requestCreatedAt === null || completedAt <= 0) return false;

    const windowMs = typeof params.options.equivalentCompletionWindowMs === 'number'
        && Number.isFinite(params.options.equivalentCompletionWindowMs)
        && params.options.equivalentCompletionWindowMs >= 0
        ? params.options.equivalentCompletionWindowMs
        : DEFAULT_AGENT_STATE_EQUIVALENT_REQUEST_COMPLETION_WINDOW_MS;
    return Math.abs(requestCreatedAt - completedAt) <= windowMs;
}

function areSameIdTerminalCompletedRequests(params: Readonly<{
    request: AgentStateRequestCoverageRecord;
    completed: AgentStateRequestCoverageRecord;
}>): boolean {
    if (!hasTerminalCompletionStatus(params.completed)) return false;

    const tool = readString(params.request.tool);
    if (!tool || readString(params.completed.tool) !== tool) return false;

    const requestKind = readString(params.request.kind);
    const completedKind = readString(params.completed.kind);
    if (requestKind && completedKind && requestKind !== completedKind) return false;

    const requestSource = readString(params.request.source);
    const completedSource = readString(params.completed.source);
    if ((requestSource || completedSource) && requestSource !== completedSource) return false;

    if (!haveEquivalentOwners(params.request, params.completed)) return false;

    if (!areJsonValuesEquivalent(params.request.arguments, params.completed.arguments)) return false;

    const requestCreatedAt = readNumber(params.request.createdAt);
    const completedAt = readAgentStateRequestCompletedAt(params.completed);
    if (requestCreatedAt === null || completedAt <= 0) return false;

    return completedAt >= requestCreatedAt;
}

export function isAgentStateRequestCoveredByCompletedRequests(params: Readonly<{
    requestId: string;
    request: unknown;
    completedRequests: Record<string, unknown> | null | undefined;
    options?: AgentStateRequestCoverageOptions;
}>): boolean {
    const request = readRecord(params.request);
    const completedRequests = params.completedRequests;
    if (!request || !completedRequests || typeof completedRequests !== 'object') return false;

    const sameIdCompleted = completedRequests[params.requestId];
    const sameIdCompletedRecord = readRecord(sameIdCompleted);
    const options = params.options ?? {};
    if (
        sameIdCompletedRecord
        && areSameIdTerminalCompletedRequests({ request, completed: sameIdCompletedRecord })
    ) {
        return true;
    }
    if (
        sameIdCompletedRecord
        && areEquivalentSameIdRequests({ request, completed: sameIdCompletedRecord, options })
    ) {
        return true;
    }

    if (!Array.isArray(options.equivalentSources) || options.equivalentSources.length === 0) {
        return false;
    }

    for (const [completedId, completedValue] of Object.entries(completedRequests)) {
        if (completedId === params.requestId) continue;
        const completed = readRecord(completedValue);
        if (!completed) continue;
        if (areEquivalentCrossIdRequests({ request, completed, options })) {
            return true;
        }
    }

    return false;
}
