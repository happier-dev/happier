import { describe, expect, it } from 'vitest';
import { ScmPullRequestSummarySchema, ScmPullRequestSummaryProtocolSchema as canonicalSummary } from '@happier-dev/protocol/scm/pullRequests';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import { defineProtocolObject, ScmPullRequestSummaryProtocolSchema } from './index.public.js';

describe('SCM pull request surface input', () => {
    it('admits branch discovery through the canonical SCM projection without adding Session authority', () => {
        const pullRequest = ScmPullRequestSummarySchema.parse({
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/repo' },
            number: 42, url: 'https://github.com/acme/repo/pull/42', title: 'Retain repository context',
            baseBranch: 'main', headBranch: 'topic', state: 'open', checks: { state: 'pending' },
        });
        const input = defineProtocolObject({ pullRequest: ScmPullRequestSummaryProtocolSchema }, { policy: 'closed' });
        expect(ScmPullRequestSummaryProtocolSchema).toBe(canonicalSummary);
        expect(input.parse({ pullRequest })).toEqual({ pullRequest });
        expect(input.safeParse({ pullRequest, sessionId: 'other-session' }).success).toBe(false);
        expect(input.safeParse({ pullRequest: { ...pullRequest, url: 'invalid' } }).success).toBe(false);
        const validate = compilePluginJsonSchema(input.jsonSchema);
        expect(validate({ pullRequest })).toBe(true);
        expect(validate({ pullRequest, sessionId: 'other-session' })).toBe(false);
    });
});
