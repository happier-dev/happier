import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from '../reducer.js';

describe('selected agent request coverage', () => {
    it('suppresses an equivalent cancellation only with the selected agent coverage', () => {
        const request = { tool: 'Shell', arguments: { command: 'pwd' }, createdAt: 10_500, source: 'custom_bridge' };
        const agentState = {
            requests: { pending: request },
            completedRequests: { pending: { ...request, createdAt: 1_000, completedAt: 10_000,
                status: 'canceled' as const, reason: 'Custom bridge stopped' } },
        };
        const context = { mainHistoryStartLoaded: false, requestCoverage: {
            equivalentSources: ['custom_bridge'],
            equivalentCompletedStatuses: ['canceled'],
            equivalentCompletedReasons: ['Custom bridge stopped'],
        } };
        expect(reducer(createReducer(), [], agentState, [], context).messages).toEqual([]);
        expect(reducer(createReducer(), [], agentState).messages[0]?.tool?.permission?.status).toBe('pending');
    });
});
