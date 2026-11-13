import * as React from 'react';
import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import { normalizeToolCallForRendering } from '@happier-dev/session-core/tools';
import { isRecord, readHappierActionToolPayload } from '@happier-dev/protocol/actions/happierActionToolResult';
import { bindContextualActionToolInput } from '@happier-dev/protocol/actions/actionToolContext';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { DeclinedApprovalDisposition } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { isHistoricalPublishApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

function stableSerialize(value: unknown): string | null {
    if (typeof value === 'undefined') return null;
    try {
        return JSON.stringify(value, (_key, nested) => {
            if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(nested).sort()) sorted[key] = (nested as Record<string, unknown>)[key];
            return sorted;
        });
    } catch {
        return null;
    }
}

// Approval bodies are immutable admitted snapshots. The reducer retains a ToolCall while replacing
// its input (toolCalls.ts / agentStatePermissions.ts), so tool identity alone is insufficient.
// These weak projections retain no superseded calls or requests and do no work on unchanged inputs.
// Baseline: 1,000 rows × 12 fallback requests serialized 24,000 inputs on each render.
const approvalInputs = new WeakMap<OpenApprovalArtifactForSession['approval'], string | null>();
type InputContext = Readonly<{ actionId: string; sessionId: string; machineId?: string; wrapped: boolean }>;
type InputContexts = Map<string, InputContext>;
const structuredToolInputs = new WeakMap<object, Map<string, string | null>>();
const primitiveToolInputs = new WeakMap<ToolCall, Readonly<{ input: unknown; values: Map<string, string | null> }>>();

function approvalInputContext(request: OpenApprovalArtifactForSession): InputContext {
    const { approval } = request;
    const declared = approval.origin?.toolInput;
    const binding = approval.v === 2 && !isHistoricalPublishApprovalRequestV2(approval) ? approval.executionOriginV1.externalActionExecutionAuthorization?.binding : undefined;
    // Execution placement can target another Machine; only admitted originating Session custody
    // establishes its contextual Machine. Never infer that default from the approved operand.
    const machineId = binding && 'sessionActionSource' in binding
        && binding.sessionActionOrigin?.caller.sessionId === approval.origin?.sessionId
        ? binding.sessionActionSource?.machineId : undefined;
    return { actionId: approval.actionId, sessionId: approval.origin?.sessionId ?? '',
        machineId,
        wrapped: approval.origin?.toolName === 'action_execute' || (isRecord(declared) && typeof declared.actionId === 'string' && Object.hasOwn(declared, 'input')) };
}

function inputContextKey(context: InputContext): string {
    // Wrapped calls carry their own exact Action id; direct tools get it from the admitted request.
    return `${context.wrapped ? 'w' : 'd'}${keyPart(context.wrapped ? '' : context.actionId)}${keyPart(context.sessionId)}${keyPart(context.machineId ?? '')}`;
}

function contextualInput(value: unknown, context: InputContext): unknown {
    const binding = { defaultSessionId: context.sessionId, defaultSessionMachineId: context.machineId };
    if (context.wrapped) {
        if (!isRecord(value) || typeof value.actionId !== 'string') return value;
        return { ...value, input: bindContextualActionToolInput({ actionId: value.actionId, input: value.input, context: binding }) };
    }
    return bindContextualActionToolInput({ actionId: context.actionId, input: value, context: binding });
}

function approvalInput(request: OpenApprovalArtifactForSession): string | null {
    const approval = request.approval;
    if (approvalInputs.has(approval)) return approvalInputs.get(approval)!;
    const origin = approval.origin;
    const expected = origin?.toolInput ?? (origin?.toolName === 'action_execute'
        ? { actionId: approval.actionId, input: approval.actionArgs } : approval.actionArgs);
    const value = stableSerialize(contextualInput(expected, approvalInputContext(request)));
    approvalInputs.set(approval, value);
    return value;
}

function toolInput(tool: ToolCall, context: InputContext): string | null {
    // Rendering normalization can project a new ToolCall for an output/name change while keeping
    // the same input. Key structured inputs directly, so the projection neither recomputes nor
    // retains a previous input after the reducer replaces it.
    // The same input object may be displayed in different Session contexts. Never reuse a bound
    // signature across those scopes (or across distinct Session Machines/direct Actions).
    let values: Map<string, string | null>;
    if (tool.input !== null && typeof tool.input === 'object') {
        values = structuredToolInputs.get(tool.input) ?? new Map();
        structuredToolInputs.set(tool.input, values);
    } else {
        const previous = primitiveToolInputs.get(tool);
        values = previous && previous.input === tool.input ? previous.values : new Map();
        primitiveToolInputs.set(tool, { input: tool.input, values });
    }
    const key = inputContextKey(context);
    if (values.has(key)) return values.get(key)!;
    const value = stableSerialize(contextualInput(readHappierActionToolPayload(tool.input), context));
    values.set(key, value);
    return value;
}

type ToolApprovalMatch = Readonly<{
    sessionId: string | undefined;
    messageId: string | undefined;
    tool: ToolCall;
    normalizedToolName: string;
}>;
type Requests = readonly OpenApprovalArtifactForSession[];
const noRequests: Requests = Object.freeze([]);
type ApprovalIndex = Readonly<{
    buckets: ReadonlyMap<string, Requests>;
    fallbackNames: ReadonlyMap<string, InputContexts>;
    fallbackSessions: ReadonlyMap<string, InputContexts>;
    selections: Map<string, Requests>;
    order: ReadonlyMap<OpenApprovalArtifactForSession, number>;
}>;
const approvalIndexes = new WeakMap<Requests, ApprovalIndex>();
const keyPart = (value: string) => `${value.length}:${value}`;
const matchKey = (sessionId: string, kind: string, value: string) => `${keyPart(sessionId)}${kind}${keyPart(value)}`;
const sameRequests = (a: Requests | undefined, b: Requests) => a?.length === b.length && b.every((request, i) => a[i] === request);

/** One immutable association projection per transcript approval publication, shared by all its rows. */
function prepareToolApprovalRequests(requests: Requests, prior?: ApprovalIndex): ApprovalIndex {
    const existing = approvalIndexes.get(requests);
    if (existing) return existing;
    const buckets = new Map<string, OpenApprovalArtifactForSession[]>();
    const fallbackNames = new Map<string, InputContexts>();
    const fallbackSessions = new Map<string, InputContexts>();
    const addContext = (index: Map<string, InputContexts>, key: string, context: InputContext) => {
        const contexts = index.get(key) ?? new Map<string, InputContext>();
        contexts.set(inputContextKey(context), context);
        index.set(key, contexts);
    };
    const add = (key: string, request: OpenApprovalArtifactForSession) => {
        const bucket = buckets.get(key);
        if (bucket) { if (bucket[bucket.length - 1] !== request) bucket.push(request); }
        else buckets.set(key, [request]);
    };
    for (const request of requests) {
        const origin = request.approval.origin;
        if (origin?.kind !== 'transcript_tool_call') continue;
        for (const id of [origin.messageId, origin.parentMessageId]) if (id) add(matchKey(origin.sessionId, 'm', id), request);
        if (origin.toolCallId) add(matchKey(origin.sessionId, 't', origin.toolCallId), request);
        if (origin.messageId || origin.parentMessageId || origin.toolCallId || !origin.toolName) continue;
        const input = approvalInput(request);
        if (input === null) continue;
        const nameKey = matchKey(origin.sessionId, 'n', origin.toolName);
        const context = approvalInputContext(request);
        addContext(fallbackNames, nameKey, context);
        addContext(fallbackSessions, origin.sessionId, context);
        add(`${nameKey}${keyPart(input)}`, request);
        add(matchKey(origin.sessionId, 'i', input), request);
    }
    const projectedBuckets = new Map<string, Requests>(buckets);
    for (const [key, bucket] of buckets) {
        const old = prior?.buckets.get(key);
        if (sameRequests(old, bucket)) projectedBuckets.set(key, old!);
    }
    const order = new Map(requests.map((request, i) => [request, i]));
    const selections = new Map<string, Requests>();
    // Keep only selections whose requests still belong to this publication; revoked/withdrawn rows
    // cannot survive in the projection. Each mounted transcript owns only its current associations.
    for (const [key, value] of prior?.selections ?? []) if (value.every(request => order.has(request))) selections.set(key, value);
    const result: ApprovalIndex = { buckets: projectedBuckets, fallbackNames, fallbackSessions, selections, order };
    approvalIndexes.set(requests, result);
    return result;
}

/** Share unchanged candidate arrays across publications; never replace producer-owned entries. */
export function useToolApprovalRequestsIndex(requests: Requests | undefined): void {
    const previous = React.useRef<ApprovalIndex | undefined>(undefined);
    previous.current = prepareToolApprovalRequests(requests ?? noRequests, previous.current);
}

/** Exact associations first; fallback input is prepared once per changed ToolCall input. */
export function selectMatchingToolApprovalRequests(params: ToolApprovalMatch & Readonly<{ requests: Requests | undefined }>): Requests {
    if (!params.sessionId || !params.requests?.length) return noRequests;
    const index = prepareToolApprovalRequests(params.requests);
    const keys: string[] = [];
    if (params.messageId) keys.push(matchKey(params.sessionId, 'm', params.messageId));
    if (typeof params.tool.id === 'string') keys.push(matchKey(params.sessionId, 't', params.tool.id));
    const names = new Set([params.tool.name, params.normalizedToolName,
        ...(params.tool.name.startsWith('mcp__happier__') ? [params.tool.name.slice('mcp__happier__'.length)] : [])]);
    const nameKeys = [...names].map(name => matchKey(params.sessionId!, 'n', name)).filter(key => index.fallbackNames.has(key));
    for (const key of nameKeys) {
        for (const context of index.fallbackNames.get(key)!.values()) {
            const input = toolInput(params.tool, context);
            if (input !== null) keys.push(`${key}${keyPart(input)}`);
        }
    }
    const buckets = keys.flatMap(key => { const bucket = index.buckets.get(key); return bucket ? [bucket] : []; });
    if (!buckets.length) return noRequests;
    const matches = (request: OpenApprovalArtifactForSession) => doesApprovalMatchToolCall({ ...params, request });
    // The index supplies candidates; the canonical matcher still owns correlation policy.
    if (buckets.length === 1 && buckets[0]!.every(matches)) return buckets[0]!;
    const result = [...new Set(buckets.flat())].filter(matches).sort((a, b) => index.order.get(a)! - index.order.get(b)!);
    if (!result.length) return noRequests;
    const key = keys.map(keyPart).join('');
    const previous = index.selections.get(key);
    if (sameRequests(previous, result)) return previous!;
    index.selections.set(key, result);
    return result;
}

/** Narrow the list/turn/group's props before they reach memoized message and tool rows. */
export function selectToolApprovalRequestsForMessages(params: Readonly<{
    requests: Requests | undefined;
    sessionId: string;
    rowId: string;
    messages: readonly Message[];
    messageId?: string;
}>): Requests {
    if (!params.requests?.length) return noRequests;
    const index = prepareToolApprovalRequests(params.requests);
    const selected = new Set<OpenApprovalArtifactForSession>();
    const visit = (message: Message) => {
        if (message.kind !== 'tool-call') return;
        const tool = normalizeToolCallForRendering(message.tool);
        // Tool chrome receives the canonical displayed route, which can differ from the reducer id.
        const displayedId = params.messageId ?? message.id;
        for (const messageId of new Set([message.id, displayedId])) {
            for (const request of selectMatchingToolApprovalRequests({ requests: params.requests, sessionId: params.sessionId,
                messageId, tool, normalizedToolName: tool.name })) selected.add(request);
        }
        // Header inference may name an old tool differently. This parent projection narrows by the
        // reviewed input only; the leaf still enforces its exact raw/normalized name through the matcher.
        for (const context of index.fallbackSessions.get(params.sessionId)?.values() ?? []) {
            const input = toolInput(tool, context);
            if (input !== null) for (const request of index.buckets.get(matchKey(params.sessionId, 'i', input)) ?? []) selected.add(request);
        }
        for (const child of message.children) visit(child);
    };
    for (const message of params.messages) visit(message);
    if (!selected.size) return noRequests;
    const result = [...selected].sort((a, b) => index.order.get(a)! - index.order.get(b)!);
    const key = `g${keyPart(params.sessionId)}${keyPart(params.rowId)}`;
    const previous = index.selections.get(key);
    if (sameRequests(previous, result)) return previous!;
    index.selections.set(key, result);
    return result;
}

export function doesApprovalMatchToolCall(params: Readonly<{
    request: OpenApprovalArtifactForSession;
    sessionId: string | undefined;
    messageId: string | undefined;
    tool: ToolCall;
    normalizedToolName: string;
}>): boolean {
    const origin = params.request.approval.origin;
    if (origin?.kind !== 'transcript_tool_call') return false;
    if (!params.sessionId || origin.sessionId !== params.sessionId) return false;
    if (origin.messageId || origin.parentMessageId) {
        if (params.messageId && (origin.messageId === params.messageId || origin.parentMessageId === params.messageId)) {
            return true;
        }
        if (origin.toolCallId) {
            return typeof params.tool.id === 'string' && origin.toolCallId === params.tool.id;
        }
        return false;
    }
    if (origin.toolCallId) {
        return typeof params.tool.id === 'string' && origin.toolCallId === params.tool.id;
    }
    if (!origin.toolName || (origin.toolName !== params.tool.name
        && `mcp__happier__${origin.toolName}` !== params.tool.name
        && origin.toolName !== params.normalizedToolName)) return false;
    // Clients without native correlation can only match the exact reviewed
    // input. Reuse the stored Action operands; never persist another raw input
    // copy or fall back to a tool name alone (notably action_execute).
    const originInput = approvalInput(params.request);
    return originInput !== null && originInput === toolInput(params.tool, approvalInputContext(params.request));
}

/** A declined request (rejected or canceled) at this call: its card says what was asked and that the person said no. */
export function readDeclinedApprovalAtCall(requests: readonly OpenApprovalArtifactForSession[]): DeclinedApprovalDisposition | null {
    for (const { approval } of requests) {
        if (approval.status === 'rejected' || approval.status === 'canceled') return approval.status;
    }
    return null;
}

/** The declined disposition of the approvals that belong to one transcript call, for surfaces that show no card. */
export function readDeclinedApprovalAtToolCall(params: Readonly<{
    requests: readonly OpenApprovalArtifactForSession[] | undefined;
    sessionId: string | undefined;
    messageId: string | undefined;
    tool: ToolCall;
}>): DeclinedApprovalDisposition | null {
    if (!params.requests || params.requests.length === 0) return null;
    return readDeclinedApprovalAtCall(selectMatchingToolApprovalRequests({
        requests: params.requests,
        sessionId: params.sessionId,
        messageId: params.messageId,
        tool: params.tool,
        normalizedToolName: params.tool.name,
    }));
}

/** The call's raw output as text, for the Technical details of the declined card that replaces it in the row. */
export function readToolOutputText(tool: ToolCall): string | null {
    const result = tool.result;
    if (result === undefined || result === null) return null;
    if (typeof result === 'string') return result.trim() || null;
    try {
        return JSON.stringify(result, null, 2) ?? null;
    } catch {
        return null;
    }
}

export function buildApprovalToolCallLocation(params: Readonly<{
    messageId: string | undefined;
}>): PermissionToolCallMessageLocation | null {
    if (!params.messageId) return null;
    return { kind: 'top', messageId: params.messageId, seq: null };
}
