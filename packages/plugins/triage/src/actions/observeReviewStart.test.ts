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
import { REVIEW_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
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

it.each([
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
])('links, replaces, and ignores stale $providerId Review receipts', async ({
    manifest, activate, activateAccount, providerId, repository, number, url, base, apiOrigin, apiPath,
    localInstanceKey, configuration, response, collisionScope,
}) => {
    const fixture = createTriageSourceV1Fixture();
    const source = manifest.contributes.targetedPluginContributions.find(
        contribution => contribution.operations?.get !== undefined,
    );
    const connectedAccount = manifest.contributes.connectedAccountDescriptors[0];
    const getDeclaration = manifest.contributes.actions.find(({ id }) => id === source?.operations?.get);
    const purpose = getDeclaration?.connectedAccountPurposeBindings?.[0]?.purpose;
    if (!source || !purpose || !connectedAccount) throw new Error('Expected a configured forge source');
    const resolve = source.operations?.resolveResource;
    const account = { service: { pluginId: manifest.id, localId: connectedAccount.id }, accountId: 'account-forge' };
    const configured = { ...fixture.configuredInstance,
        instance: { ...fixture.configuredInstance.instance, source: { pluginId: manifest.id, localId: source.id } },
        binding: { purpose, account }, localInstanceKey, configuration: { v: 1 as const, token: JSON.stringify(configuration) },
    };
    const kindId = providerId === 'gitlab' ? 'merge-request' : 'pull-request';
    const localRef = { kindId, collisionScope, entryId: String(number) };
    const entryRef = { source: configured.instance.source, ...localRef };
    const provider = await createPluginTestkit({ manifest, module: { activate, activateAccount }, services: {
        connectedAccounts: {
            async listAccounts() {
                return { status: 'complete', accounts: [{ account, displayName: 'Forge account', state: 'connected',
                    connectedAccountOrigins: [new URL(base).origin, apiOrigin], connectedAccountBases: [base] }] };
            },
            async materializeListedAccount() { return { kind: 'httpHeaders', headers: { authorization: 'Basic test-only' } }; },
        } as PluginServices['connectedAccounts'],
        http: createPluginHttpFixture({ async request(input) {
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
                if (definition.id === CORPUS_USER_MARKS_COLLECTION_ID) return collections.userMarks;
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
        const observe = async (reviewId: string, headOid: string) => {
            for (const declaration of TRIAGE_PLUGIN.manifest.contributes.hooks ?? []) {
                if (declaration.on !== 'action.execute.after') continue;
                await plugin.registration('hooks', declaration.id)?.({
                    actionId: REVIEW_START_ACTION_ID_V1, input: {},
                    invocation: { surface: 'agent', caller: { kind: 'host' } },
                    timestampMs: 1,
                    outcome: { status: 'succeeded', result: {
                        reviewTarget: { locator: { providerId, repository, number }, url, headOid },
                        reviewRound: { reviewId, roundOrdinal: 1 },
                    } },
                }, context);
            }
        };
        expect(await read()).toMatchObject({ kind: 'read' });
        expect(await read()).not.toHaveProperty('admittedReview');
        await observe('first-review', head);
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: { reviewId: 'first-review', roundOrdinal: 1 } });
        await observe('second-review', head);
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: { reviewId: 'second-review', roundOrdinal: 1 } });
        await observe('stale-review', 'older-head');
        expect(await read()).toMatchObject({ kind: 'read', admittedReview: { reviewId: 'second-review', roundOrdinal: 1 } });
    } finally {
        await plugin.dispose();
        await provider.dispose();
    }
});
