import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod';
import type { AgentState } from '@/api/types';
import { deepEqual } from '@/utils/deterministicJson';
import { isSameAgentStateRequestOccurrence } from '@/agent/permissions/agentStateRequestStore';
import { clonePlainObjectToNullProto, cloneStringKeyedRecordToNullProto } from './agentStateRecords';

const completedRequestSchema = lazyZodSchema(() => z.object({
    tool: z.string(), arguments: z.unknown(), createdAt: z.number().finite(),
    completedAt: z.number().finite(), status: z.enum(['approved', 'denied', 'canceled']),
}).passthrough());

export const AgentStateRequestSettlementSchema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    entries: z.array(z.object({
        requestId: z.string().min(1), completed: completedRequestSchema, removeRequest: z.boolean(),
        requestAbsent: z.literal(true).optional(),
    }).strict()),
}).strict());
export type AgentStateRequestSettlement = z.infer<typeof AgentStateRequestSettlementSchema>;

function hasClaim(value: unknown): boolean {
    const record = clonePlainObjectToNullProto(value);
    return record !== null && Object.prototype.hasOwnProperty.call(record, 'permissionResponseClaimV1');
}

/** Local delivery intent contains only exact completions, never an executable updater or stale Session snapshot. */
export function buildAgentStateRequestSettlement(current: AgentState, updated: AgentState): AgentStateRequestSettlement {
    return AgentStateRequestSettlementSchema.parse({ v: 1,
        entries: Object.entries(updated.completedRequests ?? {}).flatMap(([requestId, completed]) => {
            if (deepEqual(current.completedRequests?.[requestId], completed)) return [];
            if (hasClaim(current.requests?.[requestId])) throw new Error('Claimed permission completion requires acknowledged persistence');
            return [{ requestId, completed, removeRequest: updated.requests?.[requestId] === undefined }];
        }),
    });
}

/** Replay against the current acknowledged tuple without changing another request occurrence or claim. */
export function applyAgentStateRequestSettlement(current: AgentState, settlement: AgentStateRequestSettlement): AgentState {
    const requests = cloneStringKeyedRecordToNullProto(current.requests);
    const completedRequests = cloneStringKeyedRecordToNullProto(current.completedRequests);
    let changed = false;
    for (const entry of settlement.entries) {
        const request = requests[entry.requestId];
        if (entry.requestAbsent && request !== undefined) continue;
        if (hasClaim(request) || request && !isSameAgentStateRequestOccurrence(request, entry.completed)) continue;
        const previous = completedRequests[entry.requestId];
        if (request === undefined && previous !== undefined) continue;
        if (previous && (previous.createdAt > entry.completed.createdAt || previous.completedAt > entry.completed.completedAt)) continue;
        if (deepEqual(previous, entry.completed)) continue;
        if (entry.removeRequest) delete requests[entry.requestId];
        // The local encrypted boundary is validated before reusing the existing AgentState wire shape.
        completedRequests[entry.requestId] = entry.completed as NonNullable<AgentState['completedRequests']>[string];
        changed = true;
    }
    return changed ? { ...current, requests, completedRequests } : current;
}
