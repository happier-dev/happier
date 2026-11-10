import {
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageGetResultV1Schema,
    type TriageEntryRefV1,
    type TriageGetResultV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

import { GITHUB_PLUGIN_ID } from '../../../scm-github/src/observations/githubProviderContracts.js';
import {
    GITHUB_ISSUE_RESPONSE,
    GITHUB_OTHER_REPOSITORY_RESPONSE,
    GITHUB_PULL_REQUEST_RESPONSE,
    GITHUB_REPOSITORY_RESPONSE,
} from '../../../scm-github/src/triage/__fixtures__/githubResponses.js';
import { runGithubTriageGet } from '../../../scm-github/src/triage/get.js';
import { toTriageGetResult } from '../../../scm-github/src/triage/mapping/protocol.js';
import { createStubGithubTransport, createTestGithubApiClient, githubChecksBatchResponse } from '../../../scm-github/src/triage/testkit/githubTriage.test-support.js';
import sentryIssue from '../../../sentry/src/fixtures/issueDetail.json' with { type: 'json' };
import { resolveSentryGetOutcome } from '../../../sentry/src/entries/getIssueOutcome.js';
import { toTriagePresentObservation } from '../../../sentry/src/source/observation.js';
import { SENTRY_CONTRIBUTION_ID, SENTRY_PLUGIN_ID } from '../../../sentry/src/sentryContracts.js';
import posthogIssue from '../../../posthog/src/api/__fixtures__/queryIssueDetail.json' with { type: 'json' };
import posthogCrud from '../../../posthog/src/api/__fixtures__/crudIssueRead.json' with { type: 'json' };
import { parsePosthogIssueCrudRead, parsePosthogIssueQueryDetail } from '../../../posthog/src/api/types/issues.js';
import { normalizePosthogApiOrigin } from '../../../posthog/src/connect/origin.js';
import { buildPosthogEntryLocator } from '../../../posthog/src/source/identity.js';
import { buildPosthogEntrySnapshot } from '../../../posthog/src/source/map/entrySnapshot.js';
import { buildPosthogPresentObservation } from '../../../posthog/src/source/map/observation.js';
import { POSTHOG_PLUGIN_ID, POSTHOG_SOURCE_CONTRIBUTION_ID } from '../../../posthog/src/posthogContracts.js';

type Present = Extract<TriageGetResultV1, Readonly<{ kind: 'present' }>>;
export type DispatchContextSpecimen = Readonly<{
    name: string;
    source: TriageEntryRefV1['source'];
    observation: Present;
    basis: string;
    nativeReadPaths?: readonly string[];
}>;

function present(value: unknown): Present {
    const parsed = TriageGetResultV1Schema.parse(value);
    if (parsed.kind !== 'present') throw new Error('Native fixture did not produce a present entry');
    return parsed;
}

async function github(kindId: 'pull-request' | 'issue', body?: string): Promise<DispatchContextSpecimen> {
    const pullRequest = kindId === 'pull-request';
    const repository = pullRequest ? 'octo-org/example-app' : 'octo-org/example-tools';
    const transport = createStubGithubTransport({ respond: request => {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith('/pulls/1284')) return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, ...(body === undefined ? {} : { body }) } };
        if (pathname.endsWith('/issues/7')) return { status: 200, body: { ...GITHUB_ISSUE_RESPONSE, ...(body === undefined ? {} : { body }) } };
        if (pathname === '/repos/octo-org/example-app') return { status: 200, body: GITHUB_REPOSITORY_RESPONSE };
        if (pathname === '/repos/octo-org/example-tools') return { status: 200, body: GITHUB_OTHER_REPOSITORY_RESPONSE };
        if (pathname.endsWith('/graphql')) return githubChecksBatchResponse(request);
        if (pathname.endsWith('/parent')) return { status: 404, body: {} };
        if (pathname.endsWith('/sub_issues') || pathname.endsWith('/blocked_by')) return { status: 200, body: [] };
        return undefined;
    } });
    const client = await createTestGithubApiClient(transport);
    const { observation } = await runGithubTriageGet({
        localRef: { kindId, collisionScope: pullRequest ? 'github:4210' : 'github:8815', entryId: pullRequest ? '1284' : '7' },
        routingToken: repository,
    }, { client, now: () => Date.UTC(2026, 7, 14, 12), signal: transport.context.signal });
    const source = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
    const fixtureInstance = createTriageSourceV1Fixture().configuredInstance;
    const instance = TriageConfiguredSourceInstanceV1Schema.parse({ ...fixtureInstance,
        instance: { ...fixtureInstance.instance, source } });
    return {
        name: pullRequest ? 'github-pr' : 'github-issue',
        source,
        observation: present(toTriageGetResult(observation, instance)),
        basis: 'scm-github/triage/__fixtures__/githubResponses.ts: synthetic REST/OpenAPI 2026-03-10; real HTTP decoder/get and authoritative public get projection',
        nativeReadPaths: transport.requests.map(request => new URL(request.url).pathname),
    };
}

/** Canonical schema-derived native fixtures, never live Account or tenant data. */
export async function loadDispatchContextSpecimens(input: Readonly<{ githubBody?: string }> = {}): Promise<readonly DispatchContextSpecimen[]> {
    const sentry = resolveSentryGetOutcome({
        requestedEntryId: sentryIssue.body.id,
        configured: { deploymentOrigin: 'https://us.sentry.io', organizationId: '7701' },
        requestUrl: `https://us.sentry.io/api/0/organizations/7701/issues/${sentryIssue.body.id}/`,
        organizationSlug: 'example-org', nowMs: Date.UTC(2026, 7, 14, 12),
        outcome: { kind: 'response', response: { status: sentryIssue.status, headers: sentryIssue.headers, bodyText: JSON.stringify(sentryIssue.body) } },
    });
    if (sentry.kind !== 'present') throw new Error('Sentry native fixture did not resolve');
    const origin = normalizePosthogApiOrigin('https://eu.posthog.com');
    if (!origin.ok) throw new Error('Invalid PostHog fixture origin');
    const query = parsePosthogIssueQueryDetail(posthogIssue);
    const crud = parsePosthogIssueCrudRead(posthogCrud);
    if (!query || !crud) throw new Error('PostHog native fixtures did not decode');
    const locator = buildPosthogEntryLocator(origin.origin, '00000000-0000-4000-8000-0000000000d1', query.id);
    if (!locator.ok) throw new Error('Invalid PostHog fixture identity');
    const snapshot = buildPosthogEntrySnapshot({
        locator: locator.value,
        row: { ...query, nativeStatus: crud.nativeStatus, assignee: crud.assignee, aggregations: query.impact ?? query.aggregations },
        scope: { displayName: 'Storefront production', teamRouteId: 4821 }, crud, enrichment: query,
        untitledLabel: 'Untitled issue',
        bounds: { textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1, factValueUtf8Bytes: MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1 },
    });
    return [await github('pull-request', input.githubBody), await github('issue', input.githubBody), {
        name: 'sentry-issue', source: { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONTRIBUTION_ID },
        observation: present(toTriagePresentObservation(sentry.snapshot)),
        basis: 'sentry/fixtures/issueDetail.json: synthetic native issue; real resolveSentryGetOutcome decoder/mapper and public observation projection',
    }, {
        name: 'posthog-issue', source: { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_SOURCE_CONTRIBUTION_ID },
        observation: present(buildPosthogPresentObservation({ snapshot })),
        basis: 'posthog/api/__fixtures__/{crudIssueRead,queryIssueDetail}.json: synthetic OpenAPI 2026-08-14; real CRUD/query decoders and production snapshot/observation mappers',
    }];
}
