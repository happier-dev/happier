import { describe, expect, it } from 'vitest';
import { workflowTriggerQueryKey, workflowTriggerRequestForQueryKey } from './workflowTriggerQuery';

describe('trigger query identity', () => {
    it('retains selected Action phase and paging without a resource identity', () => {
        const request = { actionId: 'session.archive', phase: 'after' as const, limit: 1 };
        const query = workflowTriggerQueryKey(request);
        expect(query).toMatch(/^selected:/);
        expect(workflowTriggerRequestForQueryKey(query)).toEqual(request);
        expect(workflowTriggerQueryKey({ ...request, phase: 'before' })).not.toBe(query);
    });
    it('refreshes a lifetime Session query without turning it into a watched subject query', () => {
        const request = { lifetimeSession: { sessionId: 'lifetime-session' } };
        expect(workflowTriggerQueryKey(request)).toBe('session:lifetime-session');
        expect(workflowTriggerRequestForQueryKey('session:lifetime-session')).toEqual(request);
        expect(workflowTriggerQueryKey({ subject: { kind: 'session', serverId: 'home', sessionId: 'lifetime-session' } }))
            .not.toBe(workflowTriggerQueryKey(request));
    });
});
