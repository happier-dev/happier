import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema, usageQueryToAnalyticsRequest, type UsageQuery } from '../inputs/usageQuery.js';
import { SessionReadBatchResultV1Schema } from '../sessions/read/sessionReadBatchV1.js';
import { UsagePromptCompositionSchema, UsageCoachModelRequestSchema } from './coach/usagePromptComposition.js';
import { UsageMcpBindingUsageSchema } from './coach/usageMcpBindingUsage.js';
import { SessionPermissionAnsweringClientCategoryV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import type { UsageSessionStateEvidence, UsageSessionMessageEvidence } from './usageWorkEvidence.js';

export const USAGE_SESSION_EVIDENCE_PATH = '/v2/usage/session-evidence';
/** Full Session histories retain relative window identity as its read end advances. */
export function getUsageSessionEvidenceDemandKey(query: UsageQuery, nowMs: number, sessionIds?: readonly string[]): string {
    const request = usageQueryToAnalyticsRequest(query, nowMs);
    const period = request.dateRange;
    const demandPeriod = query.period.relative === undefined
        ? { startMs: period?.startMs ?? 0, endMs: period?.endMs ?? nowMs }
        : { relative: query.period.relative, startMs: period?.startMs ?? 0 };
    return JSON.stringify({ period: demandPeriod,
        filters: request.filters, population: request.population ?? 'all_personal_history',
        sessionIds: sessionIds === undefined ? null : [...new Set(sessionIds)].sort(), includeSessionEvidence: query.includeSessionEvidence,
        includeTranscriptEvidence: query.includeSessionEvidence && query.includeTranscriptEvidence });
}

const Id = lazyZodSchema(() => z.string().check(z.minLength(1)));
const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const NullableId = lazyZodSchema(() => z.nullable(Id));

/** Content-free message evidence; ordinary transcript content never crosses this boundary. */
export const UsageSessionMessageEvidenceSchema: z.ZodMiniType<UsageSessionMessageEvidence> = lazyZodSchema(() => z.strictObject({
    acceptedInputs: z.optional(z.array(z.strictObject({ inputId: Id, workId: Id, acceptedAtMs: Time,
        deliveryKind: z.enum(['newTurn', 'followUp', 'steer']), turnId: Id }))),
    phaseEvents: z.optional(z.array(z.strictObject({ evidenceId: Id, sessionId: Id, turnId: NullableId,
        observedAtMs: Time, kind: z.enum(['read', 'change', 'execute', 'delegate', 'compaction', 'unknown']),
        method: z.enum(['tool_classification', 'native_event']) }))),
    collaboration: z.optional(z.array(z.strictObject({ evidenceId: Id, workId: NullableId, sourceSessionId: NullableId,
        targetId: Id, nativeTargetId: z.optional(Id), sourceAgentId: NullableId, targetAgentId: NullableId,
        observedAtMs: z.nullable(Time), relation: z.enum(['spawn', 'run', 'native', 'review', 'plan', 'report', 'replay', 'handoff']) }))),
    coach: z.optional(z.strictObject({ composition: z.optional(z.array(UsagePromptCompositionSchema)),
        compositionCoverage: z.optional(z.enum(['complete', 'partial', 'unknown'])),
        detail: z.optional(z.strictObject({ coverage: z.enum(['complete', 'partial', 'unknown']),
            compactions: z.optional(z.array(z.strictObject({ evidenceId: Id, observedAtMs: Time, sessionId: Id, turnId: NullableId,
                immediateRefillToLimit: z.optional(z.nullable(z.boolean())) }))),
            mcpUsage: z.optional(z.array(UsageMcpBindingUsageSchema)),
            modelRequests: z.optional(z.array(UsageCoachModelRequestSchema)),
        })),
    })),
}));

/** Already-projected state facts; request arguments and private provider state are absent. */
export const UsageSessionStateEvidenceSchema: z.ZodMiniType<UsageSessionStateEvidence> = lazyZodSchema(() => z.strictObject({
    permissions: z.array(z.strictObject({ requestId: Id, workId: Id, requestedAtMs: z.nullable(Time),
        decidedAtMs: z.nullable(Time), toolId: NullableId,
        answeringClientCategory: z.nullable(SessionPermissionAnsweringClientCategoryV1Schema) })),
    waits: z.array(z.strictObject({ workId: Id, evidenceId: Id, agentId: NullableId, machineId: NullableId,
        kind: z.enum(['permission_wait', 'user_wait']), startMs: Time, endMs: z.nullable(Time) })),
}));

export const UsageSessionEvidenceRequestSchema = lazyZodSchema(() => z.strictObject({
    nowMs: Time,
    requests: z.array(z.strictObject({ query: UsageQuerySchema, sessionIds: z.optional(z.array(Id)),
        /** Row-level window question: which of these Sessions belong to the window. Ignored with explicit sessionIds. */
        candidateSessionIds: z.optional(z.array(Id)) })),
}));
export type UsageSessionEvidenceRequest = z.infer<typeof UsageSessionEvidenceRequestSchema>;

const UsageSessionEvidenceResultSchema = lazyZodSchema(() => z.safeExtend(SessionReadBatchResultV1Schema, {
    stateEvidence: z.optional(UsageSessionStateEvidenceSchema),
    messageEvidence: z.optional(UsageSessionMessageEvidenceSchema), messagesComplete: z.optional(z.boolean()),
}));
const UsageSessionEvidenceHeaderSchema = lazyZodSchema(() => z.strictObject({
    requests: z.array(z.strictObject({ query: UsageQuerySchema, sessionIds: z.array(Id) })),
}));
/** Responses correspond positionally to requests, including repeated query identities. */
export const UsageSessionEvidenceResponseSchema = lazyZodSchema(() => z.strictObject({
    requests: UsageSessionEvidenceHeaderSchema.shape.requests,
    results: z.array(UsageSessionEvidenceResultSchema),
}));
export type UsageSessionEvidenceResponse = z.infer<typeof UsageSessionEvidenceResponseSchema>;

/** Admit one NDJSON record at a time; aggregate opaque histories never form one JSON string. */
export function createUsageSessionEvidenceStreamDecoder(input: Readonly<{
    onRequests: (requests: UsageSessionEvidenceResponse['requests']) => void;
    onResult: (result: UsageSessionEvidenceResponse['results'][number]) => void;
}>): Readonly<{ write: (text: string) => void; finish: () => void }> {
    let headerRead = false;
    let finished = false;
    const fragments: string[] = [];
    const readLine = () => {
        const line = fragments.join('');
        fragments.length = 0;
        if (!line.trim()) return;
        const value: unknown = JSON.parse(line);
        if (!headerRead) {
            const header = UsageSessionEvidenceHeaderSchema.parse(value);
            headerRead = true;
            input.onRequests(header.requests);
        } else input.onResult(UsageSessionEvidenceResultSchema.parse(value));
    };
    return {
        write(text) {
            if (finished) throw new Error('Usage evidence stream already finished');
            let offset = 0;
            for (let newline = text.indexOf('\n', offset); newline !== -1; newline = text.indexOf('\n', offset)) {
                fragments.push(text.slice(offset, newline));
                readLine();
                offset = newline + 1;
            }
            if (offset < text.length) fragments.push(text.slice(offset));
        },
        finish() {
            if (finished) throw new Error('Usage evidence stream already finished');
            finished = true;
            if (fragments.length) readLine();
            if (!headerRead) throw new Error('Missing Usage evidence stream header');
        },
    };
}
