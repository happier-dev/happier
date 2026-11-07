import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { readTriageSourceOperationOutcomeV1, SessionPullRequestStatusResourceResultV1Schema, TriagePullRequestStatusResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

import { PLUGIN_MANIFEST as GITHUB_MANIFEST, GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../scm-github/src/manifest.js';
import { activate as activateGithub, activateAccount as activateGithubAccount } from '../../../scm-github/src/activate.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../../scm-github/src/observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from '../../../scm-github/src/triage/configuration.js';
import { GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../../scm-github/src/triage/__fixtures__/githubResponses.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT, readRecordedJsonBody } from '../../../scm-github/src/triage/testkit/githubTriage.test-support.js';
import { executeTriageSessionPullRequestOperationV1 } from './sessionPullRequestControls.js';

const repository = 'octo-org/example-app';
const head = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
const localRef = { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '1284' };

describe('shared offer to the original registered GitHub Action', () => {
    it.each(['dequeue', 'cancelAutoMerge', 'merge', 'headChanged'] as const)(
        'consumes the native %s offer without another Overview and leaves final admission with the source', async mode => {
        let queued = mode === 'dequeue';
        let autoMerge = mode === 'cancelAutoMerge';
        let merged = false;
        let advanced = false;
        const mutations: unknown[] = [];
        // Only HTTP and credentials are substituted; source admission, presenter, schemas and native writers run.
        const transport = createStubGithubTransport({ respond(request) {
            const path = new URL(request.url).pathname;
            if (request.method === 'GET' && path === `/repos/${repository}/pulls/1284`) return { status: 200, body: {
                ...GITHUB_PULL_REQUEST_RESPONSE, draft: false, mergeable: true, mergeable_state: 'clean',
                head: { ...(typeof GITHUB_PULL_REQUEST_RESPONSE.head === 'object' && GITHUB_PULL_REQUEST_RESPONSE.head !== null
                    ? GITHUB_PULL_REQUEST_RESPONSE.head : {}), sha: advanced ? 'b'.repeat(40) : head },
                merged, state: merged ? 'closed' : 'open',
                auto_merge: autoMerge ? { merge_method: 'squash' } : null,
            } };
            if (request.method === 'GET' && path === `/repos/${repository}`) return { status: 200, body: {
                ...GITHUB_REPOSITORY_RESPONSE, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false,
            } };
            if (request.method === 'GET' && path.includes('/rules/branches/')) return { status: 200, body: [] };
            if (request.method === 'PUT' && path.endsWith('/merge')) {
                mutations.push(readRecordedJsonBody(request)); merged = true;
                return { status: 200, body: { merged: true, sha: head } };
            }
            if (path !== '/graphql') return undefined;
            const body = readRecordedJsonBody(request);
            if (!body || typeof body !== 'object' || !('query' in body) || typeof body.query !== 'string') throw new Error('Expected native query');
            if (body.query.startsWith('mutation')) {
                mutations.push(body); queued = false; autoMerge = false;
                return { status: 200, body: { data: {} } };
            }
            return { status: 200, body: { data: { repository: {
                databaseId: 4210, isArchived: false, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false,
                pullRequest: { id: GITHUB_PULL_REQUEST_RESPONSE.node_id, headRefOid: advanced ? 'b'.repeat(40) : head,
                    mergeStateStatus: 'CLEAN', viewerCanUpdate: true, viewerCanMergeAsAdmin: true,
                    viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: true,
                    mergeQueueEntry: queued ? { id: 'queue-entry', state: 'QUEUED', position: 1 } : null,
                    reviewDecision: 'APPROVED', reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
                    reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
                    commits: { nodes: [{ commit: { oid: advanced ? 'b'.repeat(40) : head,
                        statusCheckRollup: { contexts: { nodes: [], pageInfo: { hasNextPage: false } } } } }] },
                },
            } } } };
        } });
        const plugin = await createPluginTestkit({ manifest: GITHUB_MANIFEST, module: { activate: activateGithub, activateAccount: activateGithubAccount }, services: {
            http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
        } });
        try {
            const fixture = createTriageSourceV1Fixture();
            const token = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: repository } });
            if (!token) throw new Error('Expected canonical fixture configuration');
            const instance = { ...fixture.configuredInstance,
                instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' },
                    sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId },
                binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
                localInstanceKey: 'github.com', configuration: { v: 1, token },
            };
            const native = TriagePullRequestStatusResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.readPullRequestStatus,
                { v: 1, instance, localRef, lastKnownLocator: { v: 1, routingToken: repository, displayPath: '#1284' } }, { surface: 'ui' }));
            expect(native.kind).toBe('status');
            if (native.kind !== 'status') throw new Error('Expected admitted native status');
            expect(native.operations).toBeDefined();
            const operationId = mode === 'headChanged' ? 'merge' : mode;
            const offered = native.operations && [native.operations.primary, ...native.operations.alternatives]
                .find(offer => offer.id === operationId);
            expect(offered).toMatchObject({ disabledReason: null });
            expect(transport.requests.map(request => new URL(request.url).pathname).sort()).toEqual([
                '/graphql', `/repos/${repository}/pulls/1284`, `/repos/${repository}/rules/branches/main`,
            ].sort());
            const resource = SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'ready', sessionId: 'session-1', pullRequests: [{
                bindingId: 'binding-1', revision: 1, link: { provider: 'github', repository, number: 1284,
                    url: `https://github.com/${repository}/pull/1284` },
                watch: { policy: { mode: 'off', archiveAfterMerge: false }, reason: null,
                    fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
                entry: { entryRef: { source: instance.instance.source, ...localRef }, sourceInstanceId: instance.instance.sourceInstanceId },
                nativeStatus: { kind: 'current', checkedAtMs: 100, value: native },
            }] });
            if (resource.kind !== 'ready' || !resource.pullRequests[0]) throw new Error('Expected admitted Resource binding');
            const binding = resource.pullRequests[0];
            advanced = mode === 'headChanged';
            const actions: unknown[] = [];
            const result = await executeTriageSessionPullRequestOperationV1({ async executeAction(action, input, options) {
                actions.push(action);
                expect(action.pluginId).toBe(GITHUB_PLUGIN_ID);
                return plugin.invokeAction(action.localId, input, { surface: 'ui', signal: options?.signal });
            } }, { binding,
                operationId: mode === 'headChanged' ? 'merge' : mode,
                ...(['merge', 'headChanged'].includes(mode) ? { variantId: 'squash' } : {}),
            });
            expect(result).toMatchObject(mode === 'headChanged' ? { kind: 'refused', reason: 'head_advanced' } : { kind: 'applied' });
            expect(readTriageSourceOperationOutcomeV1(result)).toMatchObject({
                kind: mode === 'headChanged' ? 'refused' : 'applied',
            });
            expect(actions).toHaveLength(1);
            expect(mutations).toHaveLength(mode === 'headChanged' ? 0 : 1);
            if (mode === 'merge') expect(mutations[0]).toMatchObject({ sha: head, merge_method: 'squash' });
            if (mode === 'dequeue') expect(mutations[0]).toMatchObject({ variables: { input: { pullRequestId: GITHUB_PULL_REQUEST_RESPONSE.node_id } } });
        } finally { await plugin.dispose(); }
    });
});
