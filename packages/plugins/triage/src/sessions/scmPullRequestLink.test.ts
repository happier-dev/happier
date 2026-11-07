import { describe, expect, it } from 'vitest';
import { ScmPullRequestSummaryProtocolSchema } from '@happier-dev/plugin-sdk/protocol';

import { chooseAndLinkTriageSnapshotPullRequestV1, linkTriageSnapshotPullRequestV1, type TriageSnapshotPullRequestLinkHostV1 } from './scmPullRequestLink.js';

const pullRequest = ScmPullRequestSummaryProtocolSchema.parse({
    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
    number: 7, url: 'https://github.com/acme/widgets/pull/7', title: 'The PR already detected in this checkout',
    baseBranch: 'main', headBranch: 'topic', state: 'open', checks: { state: 'pending' },
});

describe('linking the detected SCM pull request', () => {
    it('uses the current snapshot URL and exact picked Session through attach only', async () => {
        const calls: unknown[] = [];
        const host: TriageSnapshotPullRequestLinkHostV1 = {
            async selectActionInput(request) {
                calls.push(request);
                return { kind: 'sessionAddress', session: { serverId: 'home-1', sessionId: 'picked-session' } };
            },
            async executeAction(action, input) {
                calls.push({ action, input });
                return { kind: 'attached', bindingId: 'binding-1' } as never;
            },
        };
        await expect(chooseAndLinkTriageSnapshotPullRequestV1(host, { homeServerId: 'home-1', pullRequest }))
            .resolves.toEqual({ kind: 'attached', bindingId: 'binding-1' });
        expect(calls).toEqual([
            { hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' } },
            { action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' },
                input: { kind: 'attach', sessionId: 'picked-session', pullRequestUrl: pullRequest.url } },
        ]);
    });

    it('cancels without attaching and refuses a foreign Home before an outward Action', async () => {
        let writes = 0;
        const host: TriageSnapshotPullRequestLinkHostV1 = {
            async selectActionInput() { return { kind: 'cancelled' }; },
            async executeAction() { writes += 1; throw new Error('No attachment is admitted'); },
        };
        await expect(chooseAndLinkTriageSnapshotPullRequestV1(host, { homeServerId: 'home-1', pullRequest }))
            .resolves.toEqual({ kind: 'cancelled' });
        await expect(linkTriageSnapshotPullRequestV1(host, { homeServerId: 'home-1', pullRequest,
            session: { serverId: 'other-home', sessionId: 'same-looking-id' } }))
            .rejects.toMatchObject({ code: 'denied' });
        expect(writes).toBe(0);
    });

    it('preserves an uncertain attachment failure without retrying or creating a PR', async () => {
        const uncertainty = new Error('The existing Action could not confirm settlement');
        const actions: unknown[] = [];
        const host: TriageSnapshotPullRequestLinkHostV1 = {
            async selectActionInput() { throw new Error('An exact Session was already supplied'); },
            async executeAction(action) { actions.push(action); throw uncertainty; },
        };
        await expect(linkTriageSnapshotPullRequestV1(host, { homeServerId: 'home-1', pullRequest,
            session: { serverId: 'home-1', sessionId: 'picked-session' } })).rejects.toBe(uncertainty);
        expect(actions).toEqual([{ pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' }]);
    });

    it('preserves a pending attachment approval without invoking placement', async () => {
        const actions: unknown[] = [];
        const approval = { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'happier.channels/actions/session-pull-request-binding-v1' } as const;
        const host: TriageSnapshotPullRequestLinkHostV1 = {
            async selectActionInput() { return { kind: 'cancelled' }; },
            async executeAction(action) { actions.push(action); return approval as never; },
        };
        await expect(linkTriageSnapshotPullRequestV1(host, { homeServerId: 'home-1', pullRequest,
            session: { serverId: 'home-1', sessionId: 'picked-session' } })).resolves.toEqual(approval);
        expect(actions).toEqual([{ pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' }]);
    });
});
