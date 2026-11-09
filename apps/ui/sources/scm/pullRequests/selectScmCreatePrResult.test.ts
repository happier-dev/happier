import { describe, expect, it } from 'vitest';

import type { ScmPullRequestOpenOrReuseResponse } from '@happier-dev/protocol/scm/pullRequests';
import { selectScmCreatePrResult } from './selectScmCreatePrResult';

describe('selectScmCreatePrResult', () => {
    it('distinguishes in-app creation, reuse, and provider-page handoff', () => {
        const pullRequest = {
            provider: { id: 'scm.github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'team/repo', urlSafety: { allowedSchemes: ['https:'] } },
            number: 12, title: 'New PR', url: 'https://github.com/team/repo/pull/12',
            baseBranch: 'main', headBranch: 'feature', state: 'open' as const,
        };
        const nextAction = { kind: 'openUrl' as const, purpose: 'pullRequest' as const, url: pullRequest.url,
            allowedBaseUrl: 'https://github.com', urlSafety: { allowedSchemes: ['https:' as const] } };
        const created: ScmPullRequestOpenOrReuseResponse = { success: true, pullRequest, reused: false, nextAction };
        expect(selectScmCreatePrResult(created, true)).toMatchObject({ kind: 'created', number: 12, url: pullRequest.url });
        expect(selectScmCreatePrResult({ ...created, reused: true }, true)).toMatchObject({ kind: 'reused', number: 12 });
        expect(selectScmCreatePrResult({ success: true, pullRequest: null, composeUrl: 'https://github.com/team/repo/compare', nextAction }, true)).toMatchObject({
            kind: 'provider-page', url: 'https://github.com/team/repo/compare', outcome: { kind: 'needs_input' },
        });
    });

    it('retains canonical compose handoff and unknown results without diagnosing prose or reachability', () => {
        const composeUrl = 'https://github.com/team/repo/compare';
        expect(selectScmCreatePrResult({ success: false, result: 'opened_compose', composeUrl, error: 'Open the provider page', outcome: { v: 1, kind: 'needs_input', errorCode: 'REMOTE_AUTH_REQUIRED', nextActions: [{ kind: 'open_url', url: composeUrl }] } }, false)).toMatchObject({ kind: 'provider-page', outcome: { kind: 'needs_input' } });
        const outcome = { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'pull_request', head: 'feature' }, nextActions: [{ kind: 'refresh' }] } satisfies import('@happier-dev/protocol/scm').ScmOperationOutcome;
        expect(selectScmCreatePrResult({ success: false, error: 'conflict network auth', outcome }, false)).toMatchObject({ kind: 'failed', errorCode: 'COMMAND_OUTCOME_UNKNOWN', outcome });
    });

    it('classifies typed provider failure for recovery', () => {
        expect(selectScmCreatePrResult({ success: false, error: 'Sign in on this machine', errorCode: 'REMOTE_AUTH_REQUIRED' }, true)).toMatchObject({
            kind: 'failed', errorCode: 'REMOTE_AUTH_REQUIRED', message: 'Sign in on this machine',
        });
    });
});
