import { PLUGIN_MANIFEST as azureDevOps } from '../../../scm-azure-devops/src/manifest.js';
import { activate as activateAzure } from '../../../scm-azure-devops/src/activate.js';
import { activate as activateAzureAccount } from '../../../scm-azure-devops/src/accountRuntime.js';
import azurePullRequests from '../../../scm-azure-devops/src/triage/fixtures/pullRequests.authored.page1.json' with { type: 'json' };
import { PLUGIN_MANIFEST as bitbucket } from '../../../scm-bitbucket/src/manifest.js';
import { activate as activateBitbucket } from '../../../scm-bitbucket/src/activate.js';
import { activate as activateBitbucketAccount } from '../../../scm-bitbucket/src/accountRuntime.js';
import bitbucketPullRequest from '../../../scm-bitbucket/src/triage/fixtures/pullRequestSelf.json' with { type: 'json' };
import { PLUGIN_MANIFEST as github } from '../../../scm-github/src/manifest.js';
import { activate as activateGithub } from '../../../scm-github/src/activate.js';
import { activate as activateGithubAccount } from '../../../scm-github/src/accountRuntime.js';
import { PLUGIN_MANIFEST as gitlab } from '../../../scm-gitlab/src/manifest.js';
import { activate as activateGitlab } from '../../../scm-gitlab/src/activate.js';
import { activate as activateGitlabAccount } from '../../../scm-gitlab/src/accountRuntime.js';
import gitlabMergeRequests from '../../../scm-gitlab/src/triage/__fixtures__/mergeRequestList.json' with { type: 'json' };
import type { JsonValue, PluginInvocationContext, PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ReviewReviewersSetInputV1Schema } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { ScmComparisonCaptureInputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { createInMemoryReviewRecordPortV1 } from '../../../../protocol/src/reviews/reviewArtifactV1.testkit.js';
import { REVIEW_HUMAN_ACTION_IDS_V1, REVIEW_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { expect, it } from 'vitest';
import { TRIAGE_PLUGIN } from '../definition.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_USER_MARKS_COLLECTION_ID,
} from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTriageReadEntryDetailActionHandler } from './readEntryDetail.js';

const gitlabBase = 'https://100.64.35.88:36331';
const gitlabUrl = `${gitlabBase}/qa/fixture/-/merge_requests/7`;
const bitbucketWorkspace = '{12345678-abcd-4000-8000-123456789abc}';
const azureBase = 'https://dev.azure.com/exampleorg';
const azureRequest = azurePullRequests.value[0]!;

const forges = [
    {
        manifest: github, activate: activateGithub, activateAccount: activateGithubAccount,
        providerId: 'github', repository: 'octo/repo', number: 17, url: 'https://github.com/octo/repo/pull/17',
        base: 'https://github.com', apiOrigin: 'https://api.github.com', apiPath: '/repos/octo/repo',
        localInstanceKey: 'github.com', configuration: { v: 1, selection: { kind: 'all' } },
        response: { id: 13, full_name: 'octo/repo' }, collisionScope: 'github:13',
    },
    {
        manifest: gitlab, activate: activateGitlab, activateAccount: activateGitlabAccount,
        providerId: 'gitlab', repository: `${gitlabBase}/qa/fixture`, number: 7, url: gitlabUrl,
        base: gitlabBase, apiOrigin: gitlabBase, apiPath: '/api/v4/projects/qa%2Ffixture/merge_requests/7',
        localInstanceKey: gitlabBase, configuration: { v: 1 },
        response: { ...gitlabMergeRequests[0], web_url: gitlabUrl, references: { full: 'qa/fixture!7' } },
        collisionScope: `gitlab:${Buffer.from(gitlabBase).toString('base64url')}:3`,
    },
    {
        manifest: bitbucket, activate: activateBitbucket, activateAccount: activateBitbucketAccount,
        providerId: 'bitbucket', repository: 'example-workspace/deploy-tools', number: 42,
        url: bitbucketPullRequest.links.html.href, base: 'https://bitbucket.org', apiOrigin: 'https://api.bitbucket.org',
        apiPath: `/2.0/repositories/${encodeURIComponent(bitbucketWorkspace)}/deploy-tools/pullrequests/42`,
        localInstanceKey: bitbucketWorkspace, configuration: { v: 1, workspaceUuid: bitbucketWorkspace },
        response: bitbucketPullRequest, collisionScope: `bitbucket:${bitbucketPullRequest.destination.repository.uuid}`,
    },
    {
        manifest: azureDevOps, activate: activateAzure, activateAccount: activateAzureAccount,
        providerId: 'azure-devops', repository: 'exampleorg/Payments/gateway', number: azureRequest.pullRequestId,
        url: `${azureRequest.repository.webUrl}/pullrequest/${azureRequest.pullRequestId}`,
        base: azureBase, apiOrigin: 'https://dev.azure.com',
        apiPath: `/exampleorg/Payments/_apis/git/repositories/gateway/pullrequests/${azureRequest.pullRequestId}`,
        localInstanceKey: azureBase, configuration: { v: 1, baseUrl: azureBase },
        response: azureRequest,
        collisionScope: `azure-devops:${Buffer.from(azureBase).toString('base64url')}:${azureRequest.repository.id}`,
    },
] as const;

const startPaths = [
    { name: 'direct', context: { surface: 'cli' } },
    { name: 'Agent', context: { surface: 'agent', actionCaller: { kind: 'session', sessionId: 'review-session' } } },
    { name: 'Workflow', context: { surface: 'agent', authority: 'account_automation', actionCaller: {
        kind: 'workflowRun', runId: 'review-workflow',
        authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
    } } },
] as const satisfies readonly { name: string; context: ActionExecutorContext }[];

it.each(forges.flatMap(forge => startPaths.map(path => ({ ...forge, path }))))(
    'links, replaces, and rejects stale $providerId Review receipts with $path.name caller context', async ({
    manifest, activate, activateAccount, providerId, repository, number, url, base, apiOrigin, apiPath,
    localInstanceKey, configuration, response, collisionScope, path,
}) => {
    const fixture = createTriageSourceV1Fixture();
    const source = manifest.contributes.targetedPluginContributions.find(
        contribution => contribution.operations?.get !== undefined,
    );
    const connectedAccount = manifest.contributes.connectedAccountDescriptors[0];
    const getDeclaration = manifest.contributes.actions.find(({ id }) => id === source?.operations?.get);
    const purpose = getDeclaration?.connectedAccountPurposeBindings?.[0]?.purpose;
    if (!source || !getDeclaration || !purpose || !connectedAccount) throw new Error('Expected a configured forge source');
    const resolve = source.operations?.resolveResource;
    const account = { service: { pluginId: manifest.id, localId: connectedAccount.id }, accountId: 'account-forge' };
    const configured = { ...fixture.configuredInstance,
        instance: { ...fixture.configuredInstance.instance, source: { pluginId: manifest.id, localId: source.id } },
        binding: { purpose, account }, localInstanceKey, configuration: { v: 1 as const, token: JSON.stringify(configuration) },
    };
    const kindId = providerId === 'gitlab' ? 'merge-request' : 'pull-request';
    const localRef = { kindId, collisionScope, entryId: String(number) };
    const entryRef = { source: configured.instance.source, ...localRef };
    let providerReads = 0;
    let exactReads = 0;
    let relationWrites = 0;
    const provider = await createPluginTestkit({ manifest, module: { activate, activateAccount }, services: {
        connectedAccounts: {
            async listAccounts() {
                return { status: 'complete', accounts: [{ account, displayName: 'Forge account', state: 'connected',
                    connectedAccountOrigins: [new URL(base).origin, apiOrigin], connectedAccountBases: [base] }] };
            },
            async materializeListedAccount() { return { kind: 'httpHeaders', headers: { authorization: 'Basic test-only' } }; },
        } as PluginServices['connectedAccounts'],
        http: createPluginHttpFixture({ async request(input) {
            providerReads += 1;
            const request = new URL(input.url);
            expect(request.origin).toBe(apiOrigin);
            expect(request.pathname).toBe(apiPath);
            return { status: 200, finalUrl: input.url, headers: {},
                body: new TextEncoder().encode(JSON.stringify(response)) };
        } }),
    } });
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${entryRef.source.pluginId}/${entryRef.source.localId}`,
        configuredAtMs: 1,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configured,
    }));
    if (fixture.getResult.kind !== 'present') throw new Error('Expected a present PR fixture');
    const head = fixture.getResult.snapshot.reviewRevision?.headSha;
    if (!head) throw new Error('Expected a current PR head');
    const get = {};
    let locator: JsonValue | undefined;
    // Host dispatch and persistence are fixtures. Resolve executes the real
    // source Action down to HTTP. Exact get returns the current observed head.
    const context = {
        surface: 'agent', invokedAtMs: 1, signal: new AbortController().signal,
        services: {
            storage: { account: { collection: (definition: { id: string }) => {
                if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return collections.sourceInstances;
                if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return collections.sessionLinks;
                if (definition.id === CORPUS_USER_MARKS_COLLECTION_ID) return {
                    ...collections.userMarks,
                    async batch(...args: Parameters<typeof collections.userMarks.batch>) {
                        relationWrites += args[0].filter(operation => operation.kind === 'put').length;
                        return collections.userMarks.batch(...args);
                    },
                };
                throw new Error(`Unexpected Collection ${definition.id}`);
            } } },
            targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => ({ contributions: [{
                    contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId },
                    descriptor: source.descriptor, operations: { ...(resolve === undefined ? {} : { resolveResource: resolve }), get },
                }] }),
                dispose() {},
            }) },
            actions: { async executeAdmittedTargetedOperation(operation: unknown, input: JsonValue) {
                if (resolve !== undefined && operation === resolve) {
                    expect(input).toMatchObject({ resource: { kind: 'pullRequest', url }, instance: configured });
                    const resolved = await provider.invokeAction(resolve, input, { surface: 'plugin' });
                    expect(resolved).toMatchObject({ kind: 'resolved', localRef, locator: { webUrl: url } });
                    if (resolved === null || typeof resolved !== 'object' || !('locator' in resolved)) {
                        throw new Error('Expected a source-minted locator');
                    }
                    locator = resolved.locator;
                    return resolved;
                }
                if (operation !== get) throw new Error('Expected the source’s exact get');
                exactReads += 1;
                expect(input).toMatchObject({ localRef, instance: configured, lastKnownLocator: locator });
                return { ...fixture.getResult, localRef, locator };
            } },
        },
    } as unknown as PluginInvocationContext;
    const plugin = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: TRIAGE_PLUGIN });
    try {
        const read = () => createTriageReadEntryDetailActionHandler()({
            v: 1, entryRef, sourceInstanceId: configured.instance.sourceInstanceId,
        }, context);
        const hook = plugin.registration('hooks', 'associate-pr-review');
        if (!hook) throw new Error('Expected the PR Review hook');
        let observed: Promise<unknown> | undefined;
        const observe = (actionId: string, result: JsonValue) => hook({
            actionId, input: {}, invocation: { surface: path.context.surface, caller: { kind: 'host' } },
            timestampMs: 1, outcome: { status: 'succeeded', result },
        }, context);
        const records = createInMemoryReviewRecordPortV1();
        const person = { kind: 'person', principal: { kind: 'account', accountId: 'reviewer' }, required: true } as const;
        const executor = createActionExecutor({
            reviewRecords: () => records,
            observeActionExecution: ({ actionId, result }) => {
                if (actionId === REVIEW_START_ACTION_ID_V1 && result.ok) {
                    observed = Promise.resolve(observe(actionId, StrictJsonValueSchema.parse(result.result)));
                    return observed.then(() => undefined);
                }
            },
            homeDomainAction: async ({ actionId, input }) => {
                expect(actionId).toBe(REVIEW_HUMAN_ACTION_IDS_V1.setReviewers);
                const { reviewId, roundOrdinal } = ReviewReviewersSetInputV1Schema.parse(input);
                return { reviewId, roundOrdinal, requests: [], verdicts: [], needsYou: {
                    reviewId, roundOrdinal, reason: 'review_needs_you', needsYou: true,
                    requestedVerdict: true, pendingDecisions: false, canSubmitVerdict: true,
                } };
            },
            scmActionExecute: async ({ input }) => {
                const { source } = ScmComparisonCaptureInputSchema.parse(input);
                if (source?.kind !== 'pullRequest') throw new Error('Expected a PR capture');
                return { success: true, comparison: {
                    id: 'a'.repeat(64), source, repository: { rootPath: '/review-repo' },
                    endpoints: { before: 'base', after: source.locator.headOid },
                    pullRequest: { baseOid: 'base', url },
                    inventory: { state: 'complete', files: [], reasons: [] },
                }, metadata: { source, sourceKey: 'selected-pr' } };
            },
        });
        const start = async (headOid: string) => {
            observed = undefined;
            const result = await executor.execute(REVIEW_START_ACTION_ID_V1, {
                target: { kind: 'detached' }, cwd: '/review-repo', instructions: 'Review this PR.',
                source: { kind: 'pullRequest', locator: { providerId, repository, number, headOid } },
                reviewers: [person],
            }, { authority: 'present_user', ...path.context,
                runtimeAccountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1',
                externalActionTarget: { kind: 'machine', machineId: 'review-machine' },
                executionRunTargetMachineId: 'review-machine',
            });
            if (!result.ok) throw new Error(JSON.stringify(result));
            expect(result).toMatchObject({ ok: true, result: {
                reviewTarget: { url, headOid }, reviewRound: { reviewId: expect.any(String), roundOrdinal: 1 },
            } });
            if (!observed) throw new Error('Review settlement did not emit an observer receipt');
            await observed;
            return (result.result as { reviewRound: { reviewId: string; roundOrdinal: number } }).reviewRound;
        };
        expect(await read()).toMatchObject({ kind: 'read' });
        expect(await read()).not.toHaveProperty('admittedReview');
        const cost = () => ({ providerReads, exactReads, relationWrites });
        const before = cost();
        await observe(getDeclaration.id, {});
        await observe(REVIEW_START_ACTION_ID_V1, { reviewRound: { reviewId: 'non-pr-review', roundOrdinal: 1 } });
        expect(cost()).toEqual(before);

        const first = await start(head);
        expect(cost()).toEqual({
            providerReads: before.providerReads + 1,
            exactReads: before.exactReads + 1,
            relationWrites: before.relationWrites + 1,
        });
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: first });
        const second = await start(head);
        expect(second.reviewId).not.toBe(first.reviewId);
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: second });
        const beforeStale = cost();
        await start('older-head');
        expect(cost()).toEqual({
            providerReads: beforeStale.providerReads + 1,
            exactReads: beforeStale.exactReads + 1,
            relationWrites: beforeStale.relationWrites,
        });
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: second });
    } finally {
        await plugin.dispose();
        await provider.dispose();
    }
});
