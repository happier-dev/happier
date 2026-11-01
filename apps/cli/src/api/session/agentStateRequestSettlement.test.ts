import { describe, expect, it } from 'vitest';
import type { AgentState } from '@/api/types';
import { applyAgentStateRequestSettlement, buildAgentStateRequestSettlement } from './agentStateRequestSettlement';

describe('exact AgentState request settlement', () => {
    it('does not replay automatic history when a same-identity request appeared after capture', () => {
        const request = { tool: 'Write', arguments: { path: 'automatic' }, createdAt: 1 };
        const intent = buildAgentStateRequestSettlement({}, {
            completedRequests: { automatic: { ...request, completedAt: 2, status: 'approved' } },
        }, { automaticHistory: true });
        const current: AgentState = { requests: { automatic: request } };
        expect(applyAgentStateRequestSettlement(current, intent)).toEqual(current);
    });

    it('preserves an existing terminal outcome while recovering other automatic history', () => {
        const request = { tool: 'Write', arguments: {}, createdAt: 1 };
        const completed = { ...request, completedAt: 10, status: 'approved' as const };
        const intent = buildAgentStateRequestSettlement({}, {
            completedRequests: { decided: completed, automatic: completed },
        }, { automaticHistory: true });
        const authoritative = { ...request, completedAt: 9, status: 'denied' as const };
        const current: AgentState = { completedRequests: { decided: authoritative } };
        expect(applyAgentStateRequestSettlement(current, intent).completedRequests).toEqual({
            decided: authoritative, automatic: completed,
        });
    });
    const foreground = { tool: 'Write', arguments: { path: 'foreground' }, createdAt: 10 };
    const background = { tool: 'Write', arguments: { path: 'background' }, createdAt: 11 };
    const original: AgentState = { requests: { foreground, background } };
    const completed = { ...foreground, completedAt: 20, status: 'approved' as const };
    const intent = buildAgentStateRequestSettlement(original, {
        requests: { background }, completedRequests: { foreground: completed },
    });

    it('rebases a completion without dropping background or newly published requests and is idempotent', () => {
        const current: AgentState = {
            ...original, controlledByUser: true,
            requests: { ...original.requests, newer: { ...foreground, createdAt: 30 } },
        };
        const settled = applyAgentStateRequestSettlement(current, intent);
        expect(settled).toEqual({
            controlledByUser: true,
            requests: { background, newer: { ...foreground, createdAt: 30 } },
            completedRequests: { foreground: completed },
        });
        expect(applyAgentStateRequestSettlement(settled, intent)).toEqual(settled);
    });

    it('preserves an observed completion when later cancellation captured from the same stale request replays', () => {
        const cancellation = buildAgentStateRequestSettlement(original, {
            requests: { background },
            completedRequests: { foreground: { ...completed, completedAt: 21, status: 'canceled' } },
        });
        const observed = applyAgentStateRequestSettlement(original, intent);
        expect(applyAgentStateRequestSettlement(observed, cancellation)).toBe(observed);

        // A live replacement occurrence still supplies authority for its own terminal result.
        const replacement = { ...foreground, createdAt: 30 };
        const replacementCompletion = { ...replacement, completedAt: 40, status: 'canceled' as const };
        const current = { ...observed, requests: { background, foreground: replacement } };
        const replacementIntent = buildAgentStateRequestSettlement(current, {
            ...current, requests: { background }, completedRequests: { foreground: replacementCompletion },
        });
        expect(applyAgentStateRequestSettlement(current, replacementIntent).completedRequests?.foreground)
            .toEqual(replacementCompletion);
    });

    it('does not settle a replacement occurrence with the same request id or a claimed request', () => {
        const replacement = { ...foreground, createdAt: 30 };
        expect(applyAgentStateRequestSettlement({ requests: { foreground: replacement } }, intent).requests)
            .toEqual({ foreground: replacement });
        const claimed = { ...foreground, permissionResponseClaimV1: { owner: 'new-runtime' } };
        expect(applyAgentStateRequestSettlement({ requests: { foreground: claimed } }, intent).requests)
            .toEqual({ foreground: claimed });
    });
});
