import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ExecutionRunLaunchOriginSchema } from '../execution/runs/startRequest.js';
import { BackendTargetRefV2InputSchema, readBackendTargetRefV2 } from '../backends/targets/backendTargetRefV2.js';
import { isGenericSubAgentToolName, readSubAgentToolResultRecord, readSubAgentToolRunId, readSubAgentToolSidechainId } from '../tools/v2/subAgentFamilies.js';
import type { OpenedUsageSession } from './usageWorkEvidence.js';

const RelationSchema = lazyZodSchema(() => z.enum(['spawn', 'run', 'native', 'review', 'plan', 'report', 'replay', 'handoff']));
export type UsageCollaborationRelation = z.infer<typeof RelationSchema>;
/** Private, content-free evidence. Null attribution is never filled from current Session metadata. */
export interface UsageCollaborationFact {
    evidenceId: string;
    workId: string | null;
    sourceSessionId: string | null;
    targetId: string;
    /** Witnessed native identity for the host Run representation, retained across opened pages. */
    nativeTargetId?: string;
    sourceAgentId: string | null;
    targetAgentId: string | null;
    observedAtMs: number | null;
    relation: UsageCollaborationRelation;
}
const CountSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
/** Presentation-only additive output; all envelopes and nested rows are closed. */
export const UsageCollaborationSummarySchema = lazyZodSchema(() => z.strictObject({
    coverage: z.literal('partial'),
    edges: z.array(z.strictObject({ sourceAgentId: z.nullable(z.string()), targetAgentId: z.nullable(z.string()),
        relation: RelationSchema, count: CountSchema })),
    unknownTimestampCount: CountSchema,
    unknownSourceAgentCount: CountSchema,
    unknownTargetAgentCount: CountSchema,
}));
export type UsageCollaborationSummary = z.infer<typeof UsageCollaborationSummarySchema>;

function distinctCollaborationFacts(facts: readonly UsageCollaborationFact[]): UsageCollaborationFact[] {
    const unique = new Map<string, UsageCollaborationFact>();
    const runNativeTargets = new Set(facts.flatMap(fact => fact.relation !== 'native' && fact.nativeTargetId ? [fact.nativeTargetId] : []));
    for (const fact of facts) {
        if (fact.relation === 'native' && runNativeTargets.has(fact.targetId)) continue;
        const relation = fact.relation === 'review' || fact.relation === 'plan' ? 'run' : fact.relation;
        const key = JSON.stringify([relation, fact.relation === 'report' ? fact.sourceSessionId : null, fact.targetId,
            fact.relation === 'handoff' ? fact.evidenceId : null]);
        const previous = unique.get(key);
        if (!previous || fact.observedAtMs !== null && (previous.observedAtMs === null || fact.observedAtMs < previous.observedAtMs)
            || fact.observedAtMs === previous.observedAtMs && (previous.relation === 'run' && fact.relation !== 'run'
                || previous.sourceAgentId === null && fact.sourceAgentId !== null)) unique.set(key, fact);
    }
    return [...unique.values()];
}

export function resolveUsageCollaboration(input: Readonly<{
    facts: readonly UsageCollaborationFact[]; period: Readonly<{ startMs: number; endMs: number }>;
}>): UsageCollaborationSummary {
    const result: UsageCollaborationSummary = { coverage: 'partial', edges: [], unknownTimestampCount: 0,
        unknownSourceAgentCount: 0, unknownTargetAgentCount: 0 };
    const edges = new Map<string, UsageCollaborationSummary['edges'][number]>();
    for (const fact of distinctCollaborationFacts(input.facts)) {
        if (fact.observedAtMs === null || !Number.isSafeInteger(fact.observedAtMs) || fact.observedAtMs < 0) {
            result.unknownTimestampCount += 1;
            continue;
        }
        if (fact.observedAtMs < input.period.startMs || fact.observedAtMs >= input.period.endMs) continue;
        if (fact.sourceAgentId === null) result.unknownSourceAgentCount += 1;
        if (fact.targetAgentId === null) result.unknownTargetAgentCount += 1;
        const key = JSON.stringify([fact.sourceAgentId, fact.targetAgentId, fact.relation]);
        const edge = edges.get(key) ?? { sourceAgentId: fact.sourceAgentId, targetAgentId: fact.targetAgentId, relation: fact.relation, count: 0 };
        edge.count += 1;
        edges.set(key, edge);
    }
    result.edges = [...edges.values()].sort((a, b) => JSON.stringify([a.relation, a.sourceAgentId, a.targetAgentId])
        .localeCompare(JSON.stringify([b.relation, b.sourceAgentId, b.targetAgentId])));
    return result;
}

export interface UsageCollaborationToolEvidence {
    id: string;
    name: string;
    input?: unknown;
    result?: unknown;
    observedAtMs: number | null;
    nativeAgentId: string | null;
}
const launchOriginReadSchema = createStoredReadSchema(ExecutionRunLaunchOriginSchema);
const targetReadSchema = createStoredReadSchema(BackendTargetRefV2InputSchema);
const id = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The only structured tool payload leaves consumed by Usage collaboration. */
export const USAGE_COLLABORATION_TOOL_LEAF_KEYS = [
    'runId', 'sidechainId', 'callId', 'launchOrigin', 'backendTarget', 'intent', 'startedAtMs',
] as const;

/** Remove bodies without changing input/result precedence or interpreting text blocks. */
export function projectUsageCollaborationToolPayload(value: unknown): Record<string, unknown> | null {
    const record = readSubAgentToolResultRecord(value);
    if (!record) return null;
    const projected: Record<string, unknown> = {};
    for (const key of USAGE_COLLABORATION_TOOL_LEAF_KEYS) {
        const leaf = record[key];
        if (leaf === undefined) continue;
        if (leaf === null) { projected[key] = null; continue; }
        // Nonnull invalid input must still suppress the result fallback. False
        // preserves that fact without retaining malformed prose or nested bodies.
        if (key === 'launchOrigin') {
            const parsed = launchOriginReadSchema.safeParse(leaf);
            projected[key] = parsed.success && parsed.data.kind === 'session'
                ? { kind: 'session', sessionId: parsed.data.sessionId } : false;
        } else if (key === 'backendTarget') {
            const parsed = targetReadSchema.safeParse(leaf);
            projected[key] = parsed.success ? parsed.data : false;
        } else if (key === 'intent') {
            projected[key] = leaf === 'review' || leaf === 'plan' ? leaf : false;
        } else if (key === 'startedAtMs') {
            projected[key] = timestamp(leaf) ?? false;
        } else {
            projected[key] = typeof leaf === 'string' ? leaf : false;
        }
    }
    return projected;
}

/** A unique witnessed Turn can identify the Agent at an event time; overlap supplies no relation itself. */
function turnAt(session: OpenedUsageSession, instant: number | null) {
    if (instant === null || session.sessionTurns?.sessionId !== session.id) return null;
    const turns = session.sessionTurns.turns.filter(turn => turn.startedAt <= instant
        && (turn.terminalAt !== undefined ? instant < turn.terminalAt : turn.status === 'in_progress'));
    return turns.length === 1 ? turns[0]! : null;
}

/** The metadata relationship owner also supplies timing-only publication without a Session identity. */
export function readUsageCollaborationMetadata(metadata: OpenedUsageSession['metadata']): Readonly<{
    source: string | undefined; replayAt: number | null;
    handoff: NonNullable<OpenedUsageSession['metadata']>['handoffV1'];
}> {
    const fork = metadata?.forkV1;
    const replay = metadata?.replaySeedV1;
    return { source: fork?.parentSessionId ?? replay?.sourceSessionId,
        replayAt: timestamp(fork?.createdAtMs ?? replay?.createdAtMs), handoff: metadata?.handoffV1 };
}

/** Join only a source Session already admitted by the query owner; this never requests another Session. */
export function resolveUsageCollaborationHistoricalSource(fact: UsageCollaborationFact, source: OpenedUsageSession | undefined,
    admittedWork?: ReadonlySet<string>): UsageCollaborationFact {
    if (fact.sourceAgentId !== null || !source || fact.sourceSessionId !== source.id) return fact;
    const turn = turnAt(source, fact.observedAtMs);
    // Resolve against the original turns first: filtering before the time join
    // could turn overlapping, ambiguous history into a false unique witness.
    if (!turn || admittedWork && !admittedWork.has(JSON.stringify([source.id, turn.turnId]))) return fact;
    const sourceAgentId = turn.agentId ?? null;
    return sourceAgentId === null ? fact : { ...fact, sourceAgentId };
}

/** Projects only already-opened metadata and typed native/tool witnesses; never scrapes prose. */
export function projectSessionUsageCollaboration(input: Readonly<{
    session: OpenedUsageSession; tools: readonly UsageCollaborationToolEvidence[];
    observedSidechainIds: ReadonlySet<string>; retained?: readonly UsageCollaborationFact[];
}>): UsageCollaborationFact[] {
    const { session } = input;
    const facts: UsageCollaborationFact[] = [];
    const make = (relation: UsageCollaborationRelation, targetId: string, observedAtMs: number | null,
        sourceSessionId: string | null, targetAgentId: string | null = null, evidenceId = targetId): UsageCollaborationFact => {
        const turn = turnAt(session, observedAtMs);
        return { relation, targetId, observedAtMs, sourceSessionId, targetAgentId, evidenceId,
            sourceAgentId: sourceSessionId === session.id ? turn?.agentId ?? null : null,
            workId: turn ? JSON.stringify([session.id, turn.turnId]) : null };
    };
    const { source, replayAt, handoff } = readUsageCollaborationMetadata(session.metadata);
    if (!source && (session.origin?.kind === 'session' || session.origin?.kind === 'execution_run')) {
        // The admitted origin projection exposes kind, not the immutable parent Session id.
        // Current manager membership must never substitute that missing birth provenance.
        facts.push(make('spawn', `session:${session.id}`, timestamp(session.createdAt), null));
    }
    if (session.manager?.sessionId) facts.push(make('report', `session:${session.manager.sessionId}`, null, session.id));
    if (source) facts.push(make('replay', `session:${session.id}`, replayAt, source,
        turnAt(session, replayAt)?.agentId ?? null));
    if (handoff) facts.push({ ...make('handoff', `session:${session.id}`, timestamp(handoff.completedAtMs), session.id,
        handoff.agentId, JSON.stringify([session.id, handoff.sourceMachineId, handoff.targetMachineId, handoff.completedAtMs])),
        sourceAgentId: handoff.agentId });

    const merged = new Map<string, UsageCollaborationToolEvidence>();
    for (const tool of input.tools) {
        const previous = merged.get(tool.id);
        merged.set(tool.id, { ...previous, ...tool, name: tool.name || previous?.name || '',
            input: tool.input ?? previous?.input, result: tool.result ?? previous?.result,
            observedAtMs: previous?.observedAtMs ?? tool.observedAtMs,
            nativeAgentId: previous?.nativeAgentId ?? tool.nativeAgentId });
    }
    const runs: UsageCollaborationFact[] = [];
    const native: UsageCollaborationFact[] = [];
    for (const tool of merged.values()) {
        if (tool.name !== 'SubAgentRun' && !isGenericSubAgentToolName(tool.name)) continue;
        const toolInput = projectUsageCollaborationToolPayload(tool.input);
        const toolResult = projectUsageCollaborationToolPayload(tool.result);
        const structuredTool = { id: tool.id, input: toolInput, result: toolResult };
        const sidechainId = readSubAgentToolSidechainId(structuredTool, tool.name);
        const runId = readSubAgentToolRunId(structuredTool);
        if (tool.name === 'SubAgentRun' && runId) {
            const origin = launchOriginReadSchema.safeParse(toolInput?.launchOrigin ?? toolResult?.launchOrigin);
            const target = targetReadSchema.safeParse(toolInput?.backendTarget ?? toolResult?.backendTarget);
            let targetAgentId: string | null = null;
            if (target.success) {
                try {
                    const resolved = readBackendTargetRefV2(target.data);
                    // A configured definition id is not an Agent identity.
                    targetAgentId = resolved.configuredBackendId ? null : resolved.backendId;
                } catch { /* An unresolvable contributed identity remains Unknown. */ }
            }
            const intent = toolInput?.intent ?? toolResult?.intent;
            const relation = intent === 'review' || intent === 'plan' ? intent : 'run';
            const observedAtMs = timestamp(toolInput?.startedAtMs ?? toolResult?.startedAtMs) ?? tool.observedAtMs;
            runs.push({ ...make(relation, `run:${runId}`, observedAtMs,
                origin.success && origin.data.kind === 'session' ? origin.data.sessionId : null, targetAgentId, tool.id),
                ...(sidechainId ? { nativeTargetId: `sidechain:${session.id}:${sidechainId}` } : {}) });
        } else if (sidechainId && (id(toolInput?.sidechainId) || id(toolResult?.sidechainId) || input.observedSidechainIds.has(sidechainId))) {
            native.push(make('native', `sidechain:${session.id}:${sidechainId}`, tool.observedAtMs,
                session.id, tool.nativeAgentId, tool.id));
        }
    }
    // Retained message evidence cannot preserve replaced current metadata relationships.
    const retained = (input.retained ?? []).filter(fact => ['run', 'native', 'review', 'plan'].includes(fact.relation));
    const all = [...facts, ...retained, ...runs, ...native];
    // Multiple child turns share one native child identity; run/native representations
    // sharing a witnessed sidechain resolve to the host's run, as in the Session roster.
    return distinctCollaborationFacts(all);
}
