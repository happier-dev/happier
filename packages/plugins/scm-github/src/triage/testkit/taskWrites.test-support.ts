import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN, GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../manifest.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_RESPONSE_FAILURE_CODE } from '../../observations/githubResponseFailure.js';
import { GITHUB_ISSUE_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from '../configuration.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT, readRecordedJsonBody } from './githubTriage.test-support.js';

/** Registered GitHub Task Actions with only HTTP and connected-account boundaries replaced. */
export async function createGithubTaskWriteTestkit(kind: 'refused' | 'uncertain') {
    const route = 'octo-org/example-app';
    const issueNumber = String(GITHUB_ISSUE_RESPONSE.number);
    const source = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
    const localRef = { kindId: 'issue', collisionScope: `github:${GITHUB_REPOSITORY_RESPONSE.id}`, entryId: issueNumber };
    const fixture = createTriageSourceV1Fixture().configuredInstance;
    const instance = { ...fixture, instance: { ...fixture.instance, source },
        binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
        configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: route } })! } } satisfies TriageConfiguredSourceInstanceV1;
    let title = 'Before';
    const transport = createStubGithubTransport({ respond(request) {
        if (request.method === 'PATCH') { title = 'Changed'; return { status: 200, body: {} }; }
        if (request.method === 'POST') return { status: 403, body: { message: 'Forbidden' } };
        if (new URL(request.url).pathname === `/repos/${route}/issues/${issueNumber}`) return { status: 200, body: {
            ...GITHUB_ISSUE_RESPONSE, repository_url: `https://api.github.com/repos/${route}`, title, labels: [], assignees: [],
            state: kind === 'refused' ? 'closed' : 'open', state_reason: kind === 'refused' ? 'completed' : null,
        } };
        return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
        services: { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts } });
    return { plugin, instance, localRef, source, locator: { v: 1, routingToken: route },
        expectedCode: kind === 'refused' ? 'state_changed' : GITHUB_RESPONSE_FAILURE_CODE.forbidden,
        // Consumers can invoke the registered source Action through their own
        // transport fixture instead of authoring a second copy of its result.
        writeAction: kind === 'refused' ? GITHUB_TRIAGE_ACTION_IDS_V1.transition : GITHUB_TRIAGE_ACTION_IDS_V1.edit,
        writeInput: { v: 1, instance, localRef, lastKnownLocator: { v: 1, routingToken: route },
            ...(kind === 'refused' ? { transitionId: 'not_planned', fieldValues: [] }
                : { fields: { title: 'Changed', labelIds: ['bug'] } }) },
        readIssueReadCount: () => transport.requests.filter(request => request.method === 'GET'
            && new URL(request.url).pathname === `/repos/${route}/issues/${issueNumber}`).length,
        readWrites: () => transport.requests.filter(request => request.method !== 'GET')
            .map(request => ({ method: request.method, body: readRecordedJsonBody(request) })),
    };
}
