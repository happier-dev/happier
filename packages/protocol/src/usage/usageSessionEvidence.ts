import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema, usageQueryToAnalyticsRequest, type UsageQuery } from '../inputs/usageQuery.js';
import { SessionReadBatchResultV1Schema } from '../sessions/read/sessionReadBatchV1.js';
import { UsageSessionMessageEvidenceSchema, UsageSessionStateEvidenceSchema,
    type UsageSessionMessageEvidence, type UsageSessionStateEvidence } from './usageWorkEvidence.js';
import { SessionSystemRecordContentSchema } from '../sessions/system/records/sessionSystemRecordContent.js';
import { SessionEffectiveAccessV1Schema } from '../sessions/access/sessionEffectiveAccessV1.js';
import { UsageSessionFactKindV1Schema, getUsageSessionFactKinds } from './usageSessionFactKinds.js';

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
        includeTranscriptEvidence: query.includeSessionEvidence && query.includeTranscriptEvidence,
        workFactKinds: getUsageSessionFactKinds(query) });
}

const Id = lazyZodSchema(() => z.string().check(z.minLength(1)));
const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export { UsageSessionMessageEvidenceSchema, UsageSessionStateEvidenceSchema } from './usageWorkEvidence.js';

// Host projection demand never changes the Session evidence wire contract.
const UsageSessionEvidenceQuerySchema = lazyZodSchema(() => z.pipe(UsageQuerySchema,
    z.transform(({ includeCoach: _coach, includeQuota: _quota, ...query }) => query)));

export const UsageSessionEvidenceRequestSchema = lazyZodSchema(() => z.strictObject({
    nowMs: Time,
    readWorkFacts: z.optional(z.literal(true)),
    workFactKinds: z.optional(z.array(UsageSessionFactKindV1Schema)),
    requests: z.array(z.strictObject({ query: UsageSessionEvidenceQuerySchema, sessionIds: z.optional(z.array(Id)),
        /** Row-level window question: which of these Sessions belong to the window. Ignored with explicit sessionIds. */
        candidateSessionIds: z.optional(z.array(Id)) })),
}));
export type UsageSessionEvidenceRequest = z.infer<typeof UsageSessionEvidenceRequestSchema>;

const UsageSessionEvidenceResultSchema = lazyZodSchema(() => z.safeExtend(SessionReadBatchResultV1Schema, {
    workFacts: z.optional(z.strictObject({
        session: z.strictObject({ id: Id, seq: Time, createdAt: Time, updatedAt: Time,
            active: z.boolean(), metadataVersion: Time, agentStateVersion: Time, metadataLayoutVersion: Time,
            encryptionMode: z.enum(['plain', 'e2ee']), dataEncryptionKey: z.nullable(z.string()),
            viewerRole: z.enum(['owner', 'recipient']), access: SessionEffectiveAccessV1Schema }),
        records: z.array(z.strictObject({ kind: UsageSessionFactKindV1Schema, content: z.nullable(SessionSystemRecordContentSchema) })),
    })),
    stateEvidence: z.optional<z.ZodMiniType<UsageSessionStateEvidence>>(UsageSessionStateEvidenceSchema),
    messageEvidence: z.optional<z.ZodMiniType<UsageSessionMessageEvidence>>(UsageSessionMessageEvidenceSchema), messagesComplete: z.optional(z.boolean()),
}));
const UsageSessionEvidenceHeaderSchema = lazyZodSchema(() => z.strictObject({
    requests: z.array(z.strictObject({ query: UsageSessionEvidenceQuerySchema, sessionIds: z.array(Id) })),
}));
/** Responses correspond positionally to requests, including repeated query identities. */
export const UsageSessionEvidenceResponseSchema = lazyZodSchema(() => z.strictObject({
    requests: UsageSessionEvidenceHeaderSchema.shape.requests,
    results: z.array(UsageSessionEvidenceResultSchema),
}));
export type UsageSessionEvidenceResponse = z.infer<typeof UsageSessionEvidenceResponseSchema>;


export { USAGE_HISTORY_OPERATIONS, UsageHistoryReadInputSchema, UsageHistoryReadProgressSchema,
    UsageHistoryReadStateSchema } from '../inputs/usageQuery.js';
export type { UsageHistoryReadInput, UsageHistoryReadProgress, UsageHistoryReadState } from '../inputs/usageQuery.js';

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
