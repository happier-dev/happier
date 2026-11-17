import { describe, expect, it } from 'vitest';
import { projectResourceRequesterContext } from './daemonContributionRegistryProjection';

describe('Resource requester projection', () => {
    it.each(['present_user', 'account_automation'] as const)('preserves %s when neither caller is a Session agent', authority => {
        expect(projectResourceRequesterContext({ callerAuthority: authority })).toEqual({ agentCaller: false, authority });
    });
});
