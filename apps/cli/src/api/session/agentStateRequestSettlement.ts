import { z } from 'zod';

import type { AgentState } from '@/api/types';
import { deepEqual } from '@/utils/deterministicJson';
import { hasPermissionResponseClaimV1, isSameAgentStateRequestOccurrence } from '@/agent/permissions/agentStateRequestStore';
import { cloneStringKeyedRecordToNullProto } from './agentStateRecords';
import { lazySchema } from '@happier-dev/protocol';

type CompletedRequest = NonNullable<AgentState['completedRequests']>[string];

const completedRequestSchema = lazySchema(() => z.object({
    tool: z.string(), arguments: z.unknown(), createdAt: z.number().finite(),
    completedAt: z.number().finite(), status: z.enum(['approved', 'denied', 'canceled']),
}).passthrough());

export const AgentStateRequestSettlementSchema = lazySchema(() => z.object({
    v: z.literal(1),
    entries: z.array(z.object({
        requestId: z.string().min(1),
        completed: completedRequestSchema,
        removeRequest: z.boolean(),
        requestAbsent: z.literal(true).optional(),
    }).strict()),
}).strict());

export type AgentStateRequestSettlement = z.infer<typeof AgentStateRequestSettlementSchema>;

/** Capture exact completions, never a stale session snapshot or an executable updater. */
export function buildAgentStateRequestSettlement(
    current: AgentState,
    updated: AgentState,
    options?: Readonly<{ automaticHistory?: boolean }>,
): AgentStateRequestSettlement {
    return AgentStateRequestSettlementSchema.parse({
        v: 1,
        entries: Object.entries(updated.completedRequests ?? {}).flatMap(([requestId, completed]) => (
            deepEqual(current.completedRequests?.[requestId], completed) ? [] : [{
                requestId, completed,
                removeRequest: updated.requests?.[requestId] === undefined,
                ...(options?.automaticHistory ? { requestAbsent: true } : {}),
            }]
        )),
    });
}

/** Rebase only these exact request occurrences onto the latest acknowledged AgentState. */
export function applyAgentStateRequestSettlement(current: AgentState, settlement: AgentStateRequestSettlement): AgentState {
    const requests = cloneStringKeyedRecordToNullProto(current.requests);
    const completedRequests = cloneStringKeyedRecordToNullProto(current.completedRequests);
    let didChange = false;
    for (const entry of settlement.entries) {
        const request = requests[entry.requestId];
        if (entry.requestAbsent && request !== undefined) continue;
        if (hasPermissionResponseClaimV1(request)) continue;
        if (request && !isSameAgentStateRequestOccurrence(request, entry.completed)) continue;
        const previousCompletion = completedRequests[entry.requestId];
        if (request === undefined && previousCompletion !== undefined) continue;
        if (previousCompletion && previousCompletion.createdAt > entry.completed.createdAt) continue;
        if (previousCompletion && previousCompletion.completedAt > entry.completed.completedAt) continue;
        if (deepEqual(previousCompletion, entry.completed)) continue;
        if (entry.removeRequest) delete requests[entry.requestId];
        // The encrypted local boundary is parsed above before projecting into the existing wire type.
        completedRequests[entry.requestId] = entry.completed as CompletedRequest;
        didChange = true;
    }
    return didChange ? { ...current, requests, completedRequests } : current;
}
