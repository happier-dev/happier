import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    isExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/plugin-sdk/actions';
// The published result schemas live on the protocol entry point; `testing/v1` publishes
// only the conformance helpers and the fixture builder.
import {
    TriageGetResultV1Schema,
    TriageListInstancesResultV1Schema,
    TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';

import organizationsPage from '../api/__fixtures__/organizationsPage.json' with { type: 'json' };
import projectsPage from '../api/__fixtures__/organizationProjectsPage.json' with { type: 'json' };
import queryIssuesPage1 from '../api/__fixtures__/queryIssuesPage1.json' with { type: 'json' };
import queryIssuesPage2 from '../api/__fixtures__/queryIssuesPage2.json' with { type: 'json' };
import crudIssueRead from '../api/__fixtures__/crudIssueRead.json' with { type: 'json' };
import queryIssueEventsPage from '../api/__fixtures__/queryIssueEventsPage.json' with { type: 'json' };
import queryIssueDetail from '../api/__fixtures__/queryIssueDetail.json' with { type: 'json' };
import issueActivityPage from '../api/__fixtures__/issueActivityPage.json' with { type: 'json' };
import { POSTHOG_ACTION_IDS, POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_PLUGIN_ID } from '../posthogContracts.js';
import { PosthogConfigurationDirectoryResultV1Schema } from '../connect/configurationContract.js';
import {
    POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1,
    PosthogSampledEventsResultV1Schema,
} from './detail/issueEventsContract.js';
import {
    POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1,
    PosthogIssueActivityResultV1Schema,
} from './detail/issueActivityContract.js';
import { PosthogCodeVariablesResultV1Schema } from './detail/codeVariablesContract.js';
import {
    POSTHOG_FAILURE_CODES,
    createPosthogCodeVariablesReader,
    createPosthogConfigurationDirectoryReader,
    createPosthogIssueActivityReader,
    createPosthogSampledEventsReader,
    createPosthogSourceEntryReader,
    getPosthogSourceEntry,
    listPosthogInstances,
    readPosthogCodeVariablesForIssue,
    readPosthogConfigurationDirectory,
    readPosthogSampledEvents,
    scanPosthogSource,
    toTriageSourceFailure,
} from './operations.js';
import { encodePosthogConfiguration } from './instance.js';

// The purpose doubles as this plugin's connected-account contribution id, so the
// account ref names it in the one spelling the canonical local-id pattern admits.
const ACCOUNT = {
    service: { pluginId: 'happier.posthog', localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE },
    accountId: 'account-1',
} as const;

type MaterializeStub = (
    request: unknown,
    options: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

type RequestStub = (
    input: Readonly<{ url: string }>,
    options: Readonly<{ signal: AbortSignal }>,
) => Promise<unknown>;

function context(
    responses: readonly unknown[],
    statuses: readonly number[] = [],
    options: Readonly<{
        /** Extra response headers per call, merged over the JSON content type. */
        responseHeaders?: readonly Readonly<Record<string, string>>[];
        /** Replaces the host materialization boundary for one exact case. */
        materialize?: MaterializeStub;
        /** Replaces the HTTP boundary while retaining the action signal under test. */
        request?: RequestStub;
        /** Lets a cancellation/deadline case own the invocation's caller signal. */
        signal?: AbortSignal;
        /** Lets a mounted-deadline case own the host-stamped invocation surface. */
        surface?: PluginInvocationContext['surface'];
        /** The host-stamped caller provenance for the invocation under test. */
        caller?: PluginInvocationContext['caller'];
    }> = {},
) {
    let call = 0;
    const listAccounts = vi.fn(async () => ({
        status: 'complete' as const,
        accounts: [{
            account: ACCOUNT,
            displayName: 'PostHog production',
            state: 'connected' as const,
            connectedAccountOrigins: ['https://eu.posthog.com'],
            connectedAccountBases: ['https://eu.posthog.com'],
        }],
    }));
    const defaultMaterialize: MaterializeStub = async () => ({
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer secret' },
    });
    const materializeListedAccount = vi.fn(options.materialize ?? defaultMaterialize);
    const request = vi.fn(async (
        input: Readonly<{ url: string }>,
        requestOptions: Readonly<{ signal: AbortSignal }>,
    ) => {
        if (options.request !== undefined) {
            return await options.request(input, requestOptions);
        }
        const index = call++;
        const body = responses[index];
        return {
            status: statuses[index] ?? 200,
            finalUrl: input.url,
            headers: {
                'content-type': 'application/json',
                ...(options.responseHeaders?.[index] ?? {}),
            },
            body: new TextEncoder().encode(JSON.stringify(body)),
        };
    });
    return {
        value: {
            signal: options.signal ?? new AbortController().signal,
            ...(options.surface === undefined ? {} : { surface: options.surface }),
            ...(options.caller === undefined ? {} : { caller: options.caller }),
            services: {
                connectedAccounts: { listAccounts, materializeListedAccount },
                http: { request },
            },
        } as unknown as PluginInvocationContext,
        listAccounts,
        materializeListedAccount,
        request,
    };
}

function configuredInstance() {
    const fixture = createTriageSourceV1Fixture();
    const encoded = encodePosthogConfiguration({
        v: 1,
        organizationUuid: '00000000-0000-4000-8000-0000000000a1',
        environments: [{
            teamPathId: 4821,
            teamUuid: '00000000-0000-4000-8000-0000000000d1',
            parentProjectId: 4820,
            displayName: 'Storefront production',
        }],
        scanWindowPolicy: {
            kind: 'exact',
            from: '2026-07-01T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
        },
        detailWindowPolicy: { kind: 'relative', durationMs: 30 * 86_400_000 },
    });
    if (!encoded.ok) throw new Error('fixture configuration must encode');
    return {
        ...fixture.configuredInstance,
        instance: {
            ...fixture.configuredInstance.instance,
            source: { pluginId: 'happier.posthog', localId: 'posthog-error-tracking' },
        },
        binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
        localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
        configuration: { v: 1 as const, token: encoded.token },
    };
}

describe('PostHog Triage source operations', () => {
    it('discovers one non-durable candidate per organization using each exact listed account', async () => {
        const host = context([organizationsPage, projectsPage]);

        const result = await listPosthogInstances({ v: 1 }, host.value);

        expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
        // Both fixture directory pages still carry a provider `next`, and discovery
        // reads exactly one bounded page per route rather than crawling. An instance may
        // therefore be unrepresented, which is `incomplete` — `complete` would claim a
        // finished per-account discovery this source did not perform.
        expect(result.kind).toBe('incomplete');
        if (result.kind === 'failed') return;
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({
            binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
            // The organization uuid is the one the fixture organization page returns.
            localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000b1',
            keyStability: 'locatorDerived',
        });
        expect(host.listAccounts).toHaveBeenCalledWith(
            { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE },
            { signal: host.value.signal },
        );
        expect(host.materializeListedAccount).toHaveBeenCalledWith(expect.objectContaining({
            purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            account: ACCOUNT,
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://eu.posthog.com',
                headerNames: ['authorization'],
            },
        }), { signal: expect.any(AbortSignal) });
    });

    /**
     * `next` is the only field that says whether more pages exist, and this walk reads
     * one page per route. A `next` the parser cannot read used to fold into "absent",
     * which is the one reading it must never take: it turns *I do not know* into *this
     * is the last page*, and discovery then reports COMPLETE while the provider is still
     * offering organizations and environments the user never sees.
     *
     * Both pages below are otherwise finished walks — `next: null`, no skipped rows — so
     * the only thing that can move this result off `complete` is the malformed field.
     */
    it('never reports discovery complete on a pagination field it could not read', async () => {
        const host = context([
            { ...organizationsPage, next: { url: 'https://eu.posthog.com/api/organizations/?offset=1' } },
            { ...projectsPage, next: null },
        ]);

        const result = await listPosthogInstances({ v: 1 }, host.value);

        expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
        expect(result.kind).toBe('incomplete');
        if (result.kind !== 'incomplete') return;
        expect(result.failure).toEqual({
            class: 'unknown',
            code: POSTHOG_FAILURE_CODES.discoveryPageBounded,
        });
        // The valid rows on that page are still published: a pagination field this
        // parser could not read is not a reason to discard an organization it could.
        expect(result.candidates).toHaveLength(1);
    });

    it('reads only the requested organization directory page and exposes the next page', async () => {
        const secondOrganization = {
            ...organizationsPage.results[0],
            id: '00000000-0000-4000-8000-0000000000b2',
            name: 'Second organization',
        };
        const host = context([organizationsPage, {
            count: 2,
            next: null,
            previous: organizationsPage.next,
            results: [secondOrganization],
        }]);
        const binding = { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT };

        const first = await readPosthogConfigurationDirectory({
            v: 1,
            kind: 'organizations',
            binding,
            page: { kind: 'initial' },
        }, host.value);
        expect(() => PosthogConfigurationDirectoryResultV1Schema.parse(first)).not.toThrow();
        expect(first).toMatchObject({
            kind: 'organizations',
            rows: [{ organizationUuid: organizationsPage.results[0]?.id }],
            next: organizationsPage.next,
        });
        expect(host.request).toHaveBeenCalledTimes(1);
        if (first.kind !== 'organizations' || first.next === undefined) return;

        const second = await readPosthogConfigurationDirectory({
            v: 1,
            kind: 'organizations',
            binding,
            page: { kind: 'continuation', next: first.next },
        }, host.value);
        expect(second).toMatchObject({
            kind: 'organizations',
            rows: [{ organizationUuid: secondOrganization.id }],
        });
        expect(second.kind === 'organizations' ? second.next : undefined).toBeUndefined();
        expect(host.request).toHaveBeenCalledTimes(2);
    });

    it('reads a later environment page only through its explicit continuation', async () => {
        const laterEnvironment = {
            ...projectsPage.results[0],
            id: 4822,
            uuid: '00000000-0000-4000-8000-0000000000d2',
            name: 'Storefront staging',
        };
        const host = context([projectsPage, {
            count: 2,
            next: null,
            previous: projectsPage.next,
            results: [laterEnvironment],
        }]);
        const input = {
            v: 1 as const,
            kind: 'environments' as const,
            binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
            organizationUuid: organizationsPage.results[0]?.id,
        };

        const first = await readPosthogConfigurationDirectory({
            ...input,
            page: { kind: 'initial' },
        }, host.value);
        if (first.kind !== 'environments' || first.next === undefined) {
            throw new Error('fixture first environment page must expose a continuation');
        }
        expect(host.request).toHaveBeenCalledTimes(1);

        const second = await readPosthogConfigurationDirectory({
            ...input,
            page: { kind: 'continuation', next: first.next },
        }, host.value);

        expect(second).toMatchObject({
            kind: 'environments',
            rows: [{ teamPathId: laterEnvironment.id, teamUuid: laterEnvironment.uuid }],
        });
        expect(second.kind === 'environments' ? second.next : undefined).toBeUndefined();
        expect(host.request).toHaveBeenCalledTimes(2);
    });

    it('keeps valid environment rows but reports an unsafe provider next as incomplete', async () => {
        const host = context([{ ...projectsPage, next: 'https://attacker.invalid/projects/?offset=2' }]);
        const result = await readPosthogConfigurationDirectory({
            v: 1,
            kind: 'environments',
            binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
            organizationUuid: organizationsPage.results[0]?.id,
            page: { kind: 'initial' },
        }, host.value);

        expect(() => PosthogConfigurationDirectoryResultV1Schema.parse(result)).not.toThrow();
        expect(result).toMatchObject({ kind: 'environments', incomplete: true });
        expect(result.kind === 'environments'
            ? result.rows.map((row) => row.teamUuid)
            : []).toContain(projectsPage.results[0]?.uuid);
        expect(result.kind === 'environments' ? result.next : undefined).toBeUndefined();
        expect(host.request).toHaveBeenCalledTimes(1);
    });

    it('preserves a long same-origin advancing continuation without a source-local URL cap', async () => {
        const next = `https://eu.posthog.com/api/organizations/?offset=1&cursor=${'a'.repeat(9 * 1024)}`;
        const host = context([{ ...organizationsPage, next }]);
        const result = await readPosthogConfigurationDirectory({
            v: 1,
            kind: 'organizations',
            binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
            page: { kind: 'initial' },
        }, host.value);

        expect(result).toMatchObject({ kind: 'organizations', next });
        expect(result.kind === 'organizations' ? result.incomplete : true).toBeUndefined();
    });

    it('omits only an oversized provider continuation and states that the directory is incomplete', async () => {
        const next = `https://eu.posthog.com/api/organizations/?offset=1&cursor=${'a'.repeat(
            EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        )}`;
        const host = context([{ ...organizationsPage, next }]);
        const result = await readPosthogConfigurationDirectory({
            v: 1,
            kind: 'organizations',
            binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
            page: { kind: 'initial' },
        }, host.value);

        expect(PosthogConfigurationDirectoryResultV1Schema.safeParse(result).success).toBe(true);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
        expect(result.kind).toBe('organizations');
        if (result.kind !== 'organizations') return;
        expect(result.rows).toHaveLength(1);
        expect(result.next).toBeUndefined();
        expect(result.incomplete).toBe(true);
    });

    it('projects a provider-overdelivered directory page instead of rejecting every row', async () => {
        const host = context([{
            ...organizationsPage,
            results: Array.from({ length: 101 }, () => organizationsPage.results[0]),
        }]);
        const result = await readPosthogConfigurationDirectory({
            v: 1,
            kind: 'organizations',
            binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
            page: { kind: 'initial' },
        }, host.value);

        expect(() => PosthogConfigurationDirectoryResultV1Schema.parse(result)).not.toThrow();
        expect(result).toMatchObject({ kind: 'organizations', incomplete: true });
        expect(result.kind === 'organizations' ? result.rows : []).toHaveLength(100);
    });

    it('does not publish a directory continuation whose offset does not advance', async () => {
        const host = context([{
            ...organizationsPage,
            next: 'https://eu.posthog.com/api/organizations/?limit=100&offset=0',
        }]);
        const result = await readPosthogConfigurationDirectory({
            v: 1,
            kind: 'organizations',
            binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
            page: { kind: 'initial' },
        }, host.value);

        expect(result).toMatchObject({ kind: 'organizations', incomplete: true });
        expect(result.kind === 'organizations' ? result.next : undefined).toBeUndefined();
        expect(host.request).toHaveBeenCalledTimes(1);
    });

    it('returns a bounded scan page and carries frozen geometry only in its continuation', async () => {
        const host = context([queryIssuesPage1, queryIssuesPage2]);
        const instance = configuredInstance();

        const first = await scanPosthogSource({
            v: 1,
            instance,
            page: { kind: 'initial', limit: 3 },
        }, host.value);

        expect(() => TriageScanResultV1Schema.parse(first)).not.toThrow();
        expect(first.kind).toBe('page');
        if (first.kind !== 'page') return;
        expect(first.observations).toHaveLength(3);
        expect(first.continuation.token).not.toContain('Bearer');

        const second = await scanPosthogSource({
            v: 1,
            instance,
            page: { kind: 'continuation', continuation: first.continuation },
        }, host.value);
        expect(() => TriageScanResultV1Schema.parse(second)).not.toThrow();
        expect(second.kind).toBe('complete');
        expect(host.request).toHaveBeenCalledTimes(2);
    });

    it('preserves a wide continuation and leaves size to the Action envelope', async () => {
        const geometry = (offset: number, pad: number): string => JSON.stringify({
            v: 1,
            environmentIndex: 0,
            offset,
            from: `2026-07-01T00:00:00.000Z${'x'.repeat(pad)}`,
            to: null,
            nativeLimit: 3,
            // The walk's carried caveats travel in the token, so they are part of
            // the geometry whose width decides whether the NEXT one still fits.
            walkHealth: [],
        });
        const pad = 32 * 1024;

        const host = context([{ ...queryIssuesPage1, nextOffset: 12 }]);
        const result = await scanPosthogSource({
            v: 1,
            instance: configuredInstance(),
            page: { kind: 'continuation', continuation: { v: 1, token: geometry(9, pad) } },
        }, host.value);

        expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
        expect(result.kind).toBe('page');
        if (result.kind !== 'page') return;
        expect(result.observations).toHaveLength(3);
        expect(result.continuation.token).toBe(geometry(12, pad));
    });

    /**
     * A walk's pages are separate invocations of this source, so a caveat one
     * page established has nowhere to live but the continuation it mints.
     *
     * Without that, page one skipping an undecodable row and page two running
     * clean out of `hasMore` settled the whole pass as `walkFinished` — and the
     * aggregate reads exactly that member to claim lane exhaustion, whose
     * exhausted-replaces branch then deletes every retained row the truncated
     * walk did not name. The falsifier is any later page that can erase an
     * earlier page's caveat.
     */
    it('never finishes a walk clean when an earlier page skipped a row', async () => {
        const malformed = { id: 'not-a-uuid', status: 'active' };
        const host = context([
            { ...queryIssuesPage1, results: [...queryIssuesPage1.results, malformed] },
            { ...queryIssuesPage2, hasMore: false, nextOffset: null },
        ]);
        const instance = configuredInstance();

        const first = await scanPosthogSource({
            v: 1,
            instance,
            page: { kind: 'initial', limit: 4 },
        }, host.value);
        expect(() => TriageScanResultV1Schema.parse(first)).not.toThrow();
        expect(first.kind).toBe('page');
        if (first.kind !== 'page') return;
        expect(first.evidence).toEqual({
            kind: 'partial',
            reason: POSTHOG_FAILURE_CODES.malformedRows,
            omittedItemCount: 1,
        });

        const second = await scanPosthogSource({
            v: 1,
            instance,
            page: { kind: 'continuation', continuation: first.continuation },
        }, host.value);
        expect(() => TriageScanResultV1Schema.parse(second)).not.toThrow();
        expect(second.kind).toBe('complete');
        if (second.kind !== 'complete') return;
        // Names only: the omitted count belongs to the call that omitted the row,
        // so the aggregate's per-page `observations + omittedItemCount <= limit`
        // check stays exact.
        expect(second.evidence).toEqual({
            kind: 'partial',
            reason: POSTHOG_FAILURE_CODES.malformedRows,
        });
        // The clean page's own rows are untouched by the caveat it carries.
        expect(second.observations.length).toBeGreaterThan(0);
    });

    it('performs CRUD-first get and returns one strict present observation', async () => {
        const host = context([crudIssueRead, queryIssueDetail]);
        const instance = configuredInstance();
        const result = await getPosthogSourceEntry({
            v: 1,
            instance,
            localRef: {
                kindId: 'error-issue',
                collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
                entryId: '00000000-0000-4000-8000-000000000001',
            },
        }, host.value);

        expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
        expect(result).toMatchObject({
            kind: 'present',
            localRef: { kindId: 'error-issue' },
            snapshot: { title: 'TypeError', scopeLabel: 'Storefront production' },
        });
        if (result.kind !== 'present') return;
        expect(result.snapshot.facts.map((fact) => fact.id)).toEqual([
            'posthog/occurrences',
            'posthog/function',
            'posthog/top-frame',
            'posthog/severity',
        ]);
        expect(result.snapshot.facts[0]?.value).toMatchObject({ kind: 'number', value: 1842 });
        // Release is a valid fourth native candidate, but the protocol leaves only
        // three native slots beside detail-only severity. It is bounded projection,
        // not a reason to reject or hide the issue.
        expect(result.snapshot.projectionTruncated).toBe(true);
        expect(host.request.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'POST']);
    });

    it('reads an exact configured issue even when discovery returned no candidates', async () => {
        const host = context([crudIssueRead, queryIssueDetail]);
        host.listAccounts.mockResolvedValueOnce({ status: 'complete', accounts: [] });

        const discovered = await listPosthogInstances({ v: 1 }, host.value);
        expect(discovered).toEqual({ kind: 'complete', candidates: [], failures: [] });

        const result = await getPosthogSourceEntry({
            v: 1,
            instance: configuredInstance(),
            localRef: {
                kindId: 'error-issue',
                collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
                entryId: '00000000-0000-4000-8000-000000000001',
            },
        }, host.value);

        expect(result).toMatchObject({ kind: 'present', snapshot: { title: 'TypeError' } });
        expect(host.listAccounts).toHaveBeenCalledTimes(1);
        expect(host.request.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'POST']);
    });

    it('reads one bounded sampled page and pages it only through its own continuation', async () => {
        const host = context([queryIssueEventsPage, { ...queryIssueEventsPage, hasMore: false }]);
        const instance = configuredInstance();
        const localRef = {
            kindId: 'error-issue',
            collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
            entryId: '00000000-0000-4000-8000-000000000001',
        } as const;

        const first = await readPosthogSampledEvents({ v: 1, instance, localRef, limit: 3 }, host.value);
        expect(() => PosthogSampledEventsResultV1Schema.parse(first)).not.toThrow();
        expect(first.kind).toBe('sampled');
        if (first.kind !== 'sampled') return;
        expect(first.events).toHaveLength(3);
        expect(first.continuation).toBeDefined();
        // The continuation is invocation-local geometry only; it never carries a
        // credential, an account ref, or the configuration token.
        expect(first.continuation ?? '').not.toContain('Bearer');
        expect(first.continuation ?? '').not.toContain(instance.configuration.token);

        const second = await readPosthogSampledEvents(
            { v: 1, instance, localRef, limit: 3, continuation: first.continuation },
            host.value,
        );
        expect(second.kind).toBe('sampled');
        if (second.kind !== 'sampled') return;
        expect(second.continuation).toBeUndefined();
        // The provider's own `hasMore: false` ended it, so there is no gap to state.
        expect(second.incomplete).toBeUndefined();

        const bodies = host.request.mock.calls.map(([callInput]) => JSON.parse(
            new TextDecoder().decode((callInput as Readonly<{ body: Uint8Array }>).body),
        ) as Readonly<{ dateRange: unknown; offset: number }>);
        expect(bodies).toHaveLength(2);
        // The second page reuses the first page's frozen window. Resolving the relative
        // detail window again would move it, and the offset would then address rows the
        // first page was never measured against.
        expect(bodies[1]?.dateRange).toEqual(bodies[0]?.dateRange);
        expect(bodies[1]?.offset).toBe(3);
    });

    it('refuses a sampled read for an entry outside the invoked instance scope', async () => {
        const host = context([queryIssueEventsPage]);
        const instance = configuredInstance();

        const result = await readPosthogSampledEvents({
            v: 1,
            instance,
            localRef: {
                kindId: 'error-issue',
                collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-00000000dead',
                entryId: '00000000-0000-4000-8000-000000000001',
            },
            limit: 3,
        }, host.value);

        expect(result.kind).toBe('unavailable');
        if (result.kind !== 'unavailable') return;
        expect(result.failure.class).toBe('unsupportedContract');
        // The refusal happens before the request boundary; no credential was materialized.
        expect(host.request).not.toHaveBeenCalled();
        expect(host.materializeListedAccount).not.toHaveBeenCalled();
    });

    it('rereads only the confirmed occurrence and publishes only projected code variables', async () => {
        const localRef = {
            kindId: 'error-issue',
            collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
            entryId: '00000000-0000-4000-8000-000000000001',
        } as const;
        const selected = {
            ...queryIssueEventsPage.results[1],
            distinct_id: 'must-not-cross-the-action',
            properties: {
                sibling_must_not_cross_the_action: 'secret-adjacent',
                $exception_list: [{
                    type: 'TypeError',
                    sibling_must_not_cross_the_action: 'exception',
                    stacktrace: { frames: [{
                        function: 'renderSummary',
                        source: 'app/checkout/summary.tsx',
                        line: 128,
                        sibling_must_not_cross_the_action: 'frame',
                        code_variables: { token: 'captured-secret' },
                    }] },
                }],
            },
        };
        const host = context([{
            ...queryIssueEventsPage,
            results: [selected],
            limit: 1,
            offset: 1,
            hasMore: false,
            nextOffset: null,
        }]);

        const result = await readPosthogCodeVariablesForIssue({
            v: 1,
            instance: configuredInstance(),
            localRef,
            selectedUuid: selected.uuid,
            selectedOffset: 1,
            frozenRequest: {
                v: 1,
                issueId: localRef.entryId,
                from: '2026-07-16T00:00:00.000Z',
                to: '2026-08-15T00:00:00.000Z',
                filterTestAccounts: false,
                onlyAppFrames: false,
                include: ['exception', 'stacktrace', 'navigation', 'correlation'],
                limit: 3,
                offset: 0,
            },
        }, host.value);

        expect(() => PosthogCodeVariablesResultV1Schema.parse(result)).not.toThrow();
        expect(result.kind).toBe('revealed');
        if (result.kind !== 'revealed') return;
        expect(JSON.parse(result.variablesText)).toEqual([{
            frame: {
                function: 'renderSummary',
                source: 'app/checkout/summary.tsx',
                line: 128,
            },
            variables: { token: 'captured-secret' },
        }]);
        expect(result.variablesText).not.toContain('must-not-cross-the-action');
        expect(host.materializeListedAccount).toHaveBeenCalledWith(
            expect.objectContaining({ purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }),
            { signal: expect.any(AbortSignal) },
        );
        expect(host.request).toHaveBeenCalledTimes(1);
        const request = host.request.mock.calls[0]?.[0] as Readonly<{ body: Uint8Array }>;
        expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
            issueId: localRef.entryId,
            dateRange: {
                date_from: '2026-07-16T00:00:00.000Z',
                date_to: '2026-08-15T00:00:00.000Z',
            },
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['code_variables'],
            limit: 1,
            offset: 1,
        });
    });

    it('refuses reveal geometry that was not minted by the sampled-query owner', async () => {
        const host = context([]);
        const localRef = {
            kindId: 'error-issue',
            collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
            entryId: '00000000-0000-4000-8000-000000000001',
        } as const;

        const result = await readPosthogCodeVariablesForIssue({
            v: 1,
            instance: configuredInstance(),
            localRef,
            selectedUuid: '00000000-0000-4000-8000-0000000000f1',
            selectedOffset: 0,
            frozenRequest: {
                v: 1,
                issueId: localRef.entryId,
                from: '2026-07-16T00:00:00.000Z',
                to: '2026-08-15T00:00:00.000Z',
                filterTestAccounts: false,
                onlyAppFrames: false,
                include: ['correlation', 'navigation', 'stacktrace', 'exception'],
                limit: 3,
                offset: 0,
            },
        }, host.value);

        expect(result).toEqual({
            kind: 'unavailable',
            failure: {
                class: 'unsupportedContract',
                code: POSTHOG_FAILURE_CODES.requestInvalid,
            },
        });
        expect(host.materializeListedAccount).not.toHaveBeenCalled();
        expect(host.request).not.toHaveBeenCalled();
    });

    it('reports a continuation it did not mint as unavailable instead of guessing a page', async () => {
        const host = context([queryIssueEventsPage]);
        const instance = configuredInstance();

        const result = await readPosthogSampledEvents({
            v: 1,
            instance,
            localRef: {
                kindId: 'error-issue',
                collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
                entryId: '00000000-0000-4000-8000-000000000001',
            },
            limit: 3,
            continuation: 'not-a-continuation',
        }, host.value);

        expect(result.kind).toBe('unavailable');
        if (result.kind !== 'unavailable') return;
        expect(result.failure.class).toBe('unsupportedContract');
        expect(host.request).not.toHaveBeenCalled();
    });

});

describe('the PostHog provider-failure projection', () => {
    it('keeps a permanently rejected request out of the transient class', () => {
        // 400, 409, 410 and 422 all land here: PostHog's published contract declares no
        // meaning for them, so repeating the identical request cannot make it succeed.
        // `transient` says the opposite, and it is the class `resolveForDispatch` reports
        // to its caller as `retryable: true`.
        expect(toTriageSourceFailure({ kind: 'unexpectedStatus', status: 409 })).toEqual({
            class: 'unknown',
            code: POSTHOG_FAILURE_CODES.unexpectedStatus,
        });
    });

    it('names four distinct causes with four distinct codes', () => {
        // One `response-unreadable` code covered a readable 500, a timeout with no body
        // at all, an unexpected status and a genuinely unparseable body — true for one
        // of the four. A reader keying on `code` could not tell them apart.
        const projected = [
            toTriageSourceFailure({ kind: 'server', status: 503 }),
            toTriageSourceFailure({ kind: 'timeout' }),
            toTriageSourceFailure({ kind: 'unexpectedStatus', status: 409 }),
            toTriageSourceFailure({ kind: 'malformedResponse', at: 'schema' }),
        ];
        expect(new Set(projected.map((failure) => failure.code)).size).toBe(4);
        // A busy server and a bodyless deadline do clear on their own; they stay transient.
        expect(projected[0]).toMatchObject({ class: 'transient' });
        expect(projected[1]).toMatchObject({ class: 'transient' });
        expect(projected[3]).toMatchObject({ class: 'unsupportedContract' });
    });

    it('carries the same classification through an authoritative get', async () => {
        const host = context([{}], [409]);
        const result = await getPosthogSourceEntry({
            v: 1,
            instance: configuredInstance(),
            localRef: {
                kindId: 'error-issue',
                collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
                entryId: '00000000-0000-4000-8000-000000000001',
            },
        }, host.value);

        expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
        expect(result.kind).toBe('unresolved');
        if (result.kind !== 'unresolved') return;
        expect(result.failure).toEqual({
            class: 'unknown',
            code: POSTHOG_FAILURE_CODES.unexpectedStatus,
        });
    });
});

/**
 * A reader with no connected PostHog account has configured nothing. The host
 * declines to list an unbound purpose; propagating that decline made the Settings
 * page report a PostHog this source never contacted.
 */
describe('PostHog listInstances with no connected account', () => {
    function unboundContext(binding: unknown) {
        const listAccounts = vi.fn(async () => {
            throw Object.assign(new Error('resource not selected'), {
                code: 'plugin_host_access_resource_not_selected',
            });
        });
        const getBinding = vi.fn(async () => binding);
        const request = vi.fn(async () => {
            throw new Error('listInstances must reach no provider with nothing connected');
        });
        return {
            value: {
                signal: new AbortController().signal,
                services: {
                    connectedAccounts: { listAccounts, getBinding },
                    http: { request },
                },
            } as unknown as PluginInvocationContext,
            getBinding,
            request,
        };
    }

    it('reports an unbound purpose as a complete empty candidate set', async () => {
        const host = unboundContext(null);

        const result = await listPosthogInstances({ v: 1 }, host.value);

        expect(result).toEqual({ kind: 'complete', candidates: [], failures: [] });
        expect(host.getBinding).toHaveBeenCalledWith(
            POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            { signal: expect.anything() },
        );
        expect(host.request).not.toHaveBeenCalled();
    });

    it('still propagates a refused listing while the purpose is bound', async () => {
        const host = unboundContext({ purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE });

        await expect(listPosthogInstances({ v: 1 }, host.value)).rejects.toMatchObject({
            code: 'plugin_host_access_resource_not_selected',
        });
    });
});

/**
 * The three boundaries every invoked operation crosses before it can answer:
 * the exact provider retry evidence, the account materialization signal, and the
 * shared authorization admission rule.
 */
describe('PostHog invocation boundaries', () => {
    const LOCAL_REF = {
        kindId: 'error-issue',
        collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
        entryId: '00000000-0000-4000-8000-000000000001',
    } as const;

    it('carries the provider retry deadline through an authoritative get', async () => {
        // An HTTP-date `Retry-After` is an absolute instant, so the deadline the
        // aggregate receives is exactly the one the provider named rather than a
        // value derived from when this test happened to run.
        const retryAt = 'Wed, 21 Oct 2099 07:28:00 GMT';
        const host = context([{ detail: 'slow down' }], [429], {
            responseHeaders: [{ 'retry-after': retryAt }],
        });

        const result = await getPosthogSourceEntry({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
        }, host.value);

        expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
        expect(result.kind).toBe('unresolved');
        if (result.kind !== 'unresolved') return;
        // `scan` already publishes this evidence. A `get` that dropped it made the
        // aggregate retry a read the provider had explicitly deferred.
        expect(result.failure).toEqual({
            class: 'rateLimit',
            code: POSTHOG_FAILURE_CODES.throttled,
            retryNotBeforeMs: Date.parse(retryAt),
        });
    });

    it('aborts account materialization when the mounted invocation deadline elapses', async () => {
        let observed: AbortSignal | undefined;
        const host = context([], [], {
            materialize: async (_request, materializeOptions) => {
                observed = materializeOptions.signal;
                return await new Promise(() => {
                    // A host materialization that never settles: only the signal the
                    // source hands it can end this call.
                });
            },
        });

        const read = createPosthogSampledEventsReader(5);
        const result = await read({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
            limit: 3,
        }, host.value);

        expect(result).toEqual({
            kind: 'unavailable',
            failure: { class: 'transient', code: POSTHOG_FAILURE_CODES.timedOut },
        });
        // The caller's aggregate signal never aborts here, so a materialization
        // handed that signal keeps running against the account after this source has
        // already given up on it.
        expect(observed).toBeDefined();
        expect(observed).not.toBe(host.value.signal);
        expect(observed?.aborted).toBe(true);
    });

    it('keeps the code-variable reread inside the same positive mounted deadline', async () => {
        let observed: AbortSignal | undefined;
        const host = context([], [], {
            materialize: async (_request, materializeOptions) => {
                observed = materializeOptions.signal;
                return await new Promise(() => {
                    // The reveal owns no extra retry/timer path; its mounted invocation
                    // aborts this canonical account boundary when the deadline expires.
                });
            },
        });

        const read = createPosthogCodeVariablesReader(5);
        const result = await read({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
            selectedUuid: '00000000-0000-4000-8000-0000000000f1',
            selectedOffset: 0,
            frozenRequest: {
                v: 1,
                issueId: LOCAL_REF.entryId,
                from: '2026-07-16T00:00:00.000Z',
                to: '2026-08-15T00:00:00.000Z',
                filterTestAccounts: false,
                onlyAppFrames: false,
                include: ['exception', 'stacktrace', 'navigation', 'correlation'],
                limit: 3,
                offset: 0,
            },
        }, host.value);

        expect(result).toEqual({
            kind: 'unavailable',
            failure: { class: 'transient', code: POSTHOG_FAILURE_CODES.timedOut },
        });
        expect(observed).toBeDefined();
        expect(observed).not.toBe(host.value.signal);
        expect(observed?.aborted).toBe(true);
    });

    it('does not restart a mounted get deadline after CRUD succeeds just before it', async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const signals: AbortSignal[] = [];
        let requestCount = 0;
        const host = context([], [], {
            request: async (_input, options) => {
                signals.push(options.signal);
                requestCount += 1;
                if (requestCount === 1) {
                    return await new Promise((resolve) => {
                        setTimeout(() => resolve({
                            status: 200,
                            finalUrl: 'https://eu.posthog.com/api/projects/4821/error_tracking/issues/00000000-0000-4000-8000-000000000001/',
                            headers: { 'content-type': 'application/json' },
                            body: new TextEncoder().encode(JSON.stringify(crudIssueRead)),
                        }), 4);
                    });
                }
                return await new Promise(() => {
                    // The query enrichment ignores cancellation. The owning invocation
                    // must nevertheless settle at its original five-millisecond limit.
                });
            },
            signal: caller.signal,
        });
        const read = createPosthogSourceEntryReader(5);
        let settled = false;
        const pending = read({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
        }, host.value).then((result) => {
            settled = true;
            return result;
        });

        try {
            await vi.advanceTimersByTimeAsync(4);
            expect(signals).toHaveLength(2);
            expect(signals[1]).toBe(signals[0]);

            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            await expect(pending).resolves.toMatchObject({ kind: 'present' });
            expect(signals[0]?.aborted).toBe(true);
        } finally {
            caller.abort();
            await pending;
            vi.useRealTimers();
        }
    });

    it('applies one source invocation deadline to settings browsing and mounted live get', async () => {
        const neverMaterializes = () => context([], [], {
            materialize: async () => await new Promise(() => undefined),
        });
        const instance = configuredInstance();

        const directoryHost = neverMaterializes();
        await expect(createPosthogConfigurationDirectoryReader(5)({
            v: 1,
            kind: 'organizations',
            binding: instance.binding,
            page: { kind: 'initial' },
        }, directoryHost.value)).resolves.toEqual({
            kind: 'unavailable',
            failure: { class: 'transient', code: POSTHOG_FAILURE_CODES.timedOut },
        });

        const getHost = neverMaterializes();
        const get = await createPosthogSourceEntryReader(5)({
            v: 1,
            instance,
            localRef: LOCAL_REF,
        }, getHost.value);
        expect(get).toEqual({
            kind: 'unresolved',
            localRef: LOCAL_REF,
            failure: { class: 'transient', code: POSTHOG_FAILURE_CODES.timedOut },
        });
    });

    it('inherits the caller signal for mounted and aggregate reads when no real deadline is supplied', async () => {
        const instance = configuredInstance();
        const input = { v: 1, instance, localRef: LOCAL_REF };
        const observedSignals: AbortSignal[] = [];
        // A refused materialization settles the read immediately; the only fact
        // under test is which signal this source handed the account boundary.
        const materialize: MaterializeStub = async (_request, materializeOptions) => {
            observedSignals.push(materializeOptions.signal ?? new AbortController().signal);
            return { kind: 'oauthToken' as const, token: 'not-a-token' };
        };
        // The diagnostic provenance names `ui` in both cases; only the
        // host-stamped dispatch surface differs.
        const pluginCaller = {
            kind: 'plugin' as const,
            pluginId: POSTHOG_PLUGIN_ID,
            contribution: {
                id: POSTHOG_ACTION_IDS.get,
                qualifiedId: `${POSTHOG_PLUGIN_ID}:${POSTHOG_ACTION_IDS.get}`,
            },
            materialization: {
                machineId: 'machine-under-test',
                materializationId: 'materialization-under-test',
                pluginId: POSTHOG_PLUGIN_ID,
            },
            originSurface: 'ui' as const,
        };

        // The host stamps a mounted detail-body read `ui` and attributes it to
        // this plugin. With no external duration, that read inherits the host's
        // cancellation signal without arming a source-owned timer.
        const mounted = context([], [], {
            materialize,
            surface: 'ui',
            caller: pluginCaller,
        });
        const mountedResult = await getPosthogSourceEntry(input, mounted.value);
        expect(mountedResult.kind).toBe('unresolved');
        expect(observedSignals).toHaveLength(1);
        expect(observedSignals[0]).toBe(mounted.value.signal);

        observedSignals.length = 0;
        // A plugin-surface dispatch is the aggregate's own call even when its
        // diagnostic provenance names `ui`: originSurface is caller data, never
        // inherited authority, so the aggregate's deadline passes through
        // unchanged in the same way and no second timer is armed over it.
        const aggregate = context([], [], {
            materialize,
            surface: 'plugin',
            caller: pluginCaller,
        });
        const aggregateResult = await getPosthogSourceEntry(input, aggregate.value);
        expect(aggregateResult.kind).toBe('unresolved');
        expect(observedSignals).toHaveLength(1);
        expect(observedSignals[0]).toBe(aggregate.value.signal);
    });

    it('admits the materialized account through the shared authorization owner', async () => {
        const cancelled = context([], [], {
            materialize: async () => {
                throw Object.assign(new Error('withdrawn'), { name: 'AbortError' });
            },
        });

        const result = await getPosthogSourceEntry({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
        }, cancelled.value);

        expect(result.kind).toBe('unresolved');
        if (result.kind !== 'unresolved') return;
        // A withdrawn materialization is a cancellation, not a refused account. The
        // shared owner is what tells those apart; a local `catch` reported every one
        // of them as an authentication failure the reader was asked to fix.
        expect(result.failure).toEqual({
            class: 'transient',
            code: POSTHOG_FAILURE_CODES.cancelled,
        });
        expect(cancelled.request).not.toHaveBeenCalled();
    });

    it('refuses a materialization that carries no usable authorization', async () => {
        const wrongKind = context([], [], {
            materialize: async () => ({ kind: 'oauthToken' as const, token: 'nope' }),
        });

        const result = await getPosthogSourceEntry({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
        }, wrongKind.value);

        expect(result.kind).toBe('unresolved');
        if (result.kind !== 'unresolved') return;
        expect(result.failure).toEqual({
            class: 'authentication',
            code: POSTHOG_FAILURE_CODES.unauthorized,
        });
        expect(wrongKind.request).not.toHaveBeenCalled();
    });
});


/**
 * What one Activity page publishes about its own coverage.
 *
 * The provider advertises a `next` this source will not follow more often than the
 * happy path suggests — a URL naming another route, one that will not parse, one that
 * repeats the page just read. Every one of them used to leave the published page with
 * no continuation, which the panel reducer reads as the end of the walk. A reader was
 * shown "12 activity record(s) read." under a list PostHog had more of, and nothing on
 * screen said so.
 */
describe('PostHog issue activity coverage', () => {
    const LOCAL_REF = {
        kindId: 'error-issue',
        collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
        entryId: '00000000-0000-4000-8000-000000000001',
    } as const;

    async function readActivity(page: unknown) {
        const host = context([page]);
        const read = createPosthogIssueActivityReader(5_000);
        const result = await read({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
            limit: 50,
        }, host.value);
        expect(() => PosthogIssueActivityResultV1Schema.parse(result)).not.toThrow();
        return result;
    }

    it('carries a verified next page as a continuation and claims no incompleteness', async () => {
        const result = await readActivity(issueActivityPage);

        expect(result.kind).toBe('activity');
        if (result.kind !== 'activity') return;
        expect(result.continuation).toBeDefined();
        expect(result.incomplete).toBeUndefined();
    });

    it('states that the walk stopped short when the provider named a next it will not follow', async () => {
        const result = await readActivity({
            ...issueActivityPage,
            // The provider's own `next` for the page just read: a real response shape,
            // and one this source must not request again.
            next: 'https://eu.posthog.com/api/projects/4821/error_tracking/issues/'
                + '00000000-0000-4000-8000-000000000001/activity/?limit=50&page=1',
        });

        expect(result.kind).toBe('activity');
        if (result.kind !== 'activity') return;
        // No continuation, because there is no position this source trusts...
        expect(result.continuation).toBeUndefined();
        // ...but the absence of a continuation is not exhaustion, and the page says so.
        expect(result.incomplete).toBe(POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1);
    });

    it('claims exhaustion only when the provider stated no next at all', async () => {
        const result = await readActivity({ ...issueActivityPage, next: null });

        expect(result.kind).toBe('activity');
        if (result.kind !== 'activity') return;
        expect(result.continuation).toBeUndefined();
        expect(result.incomplete).toBeUndefined();
        // The unreadable third fixture row is still charged to the page budget, so a
        // reader is never told a page covered fewer rows than it consumed.
        expect(result.omittedRowCount).toBe(1);
    });

    it('fits provider-valid Activity rows at the canonical Action envelope', async () => {
        const normal = issueActivityPage.results[0];
        const largeSource = issueActivityPage.results[1];
        if (normal === undefined || largeSource === undefined) {
            throw new Error('recorded Activity fixture must contain two valid rows');
        }
        const oversized = {
            ...largeSource,
            activity: 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES),
        };
        const result = await readActivity({
            ...issueActivityPage,
            results: [normal, oversized],
            next: null,
            total_count: 2,
        });

        expect(result.kind).toBe('activity');
        if (result.kind !== 'activity') return;
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
        expect(result.records.map((record) => record.id)).toEqual([normal.id]);
        expect(result.omittedRowCount).toBe(1);
    });
});

/**
 * The sampled plane's half of the same coverage contract.
 *
 * `query/issue_events` is offset-paged rather than page-numbered, so the deviation looks
 * different — `hasMore: true` beside an offset that does not move — and the consequence
 * is identical: no continuation, no Load more, and a panel that reads the missing
 * affordance as the end of what PostHog offered.
 */
describe('PostHog sampled occurrence coverage', () => {
    const LOCAL_REF = {
        kindId: 'error-issue',
        collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
        entryId: '00000000-0000-4000-8000-000000000001',
    } as const;

    async function readSample(page: unknown) {
        const host = context([page]);
        const result = await readPosthogSampledEvents({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
            limit: 3,
        }, host.value);
        expect(() => PosthogSampledEventsResultV1Schema.parse(result)).not.toThrow();
        return result;
    }

    it('states the gap when the provider claims more rows at an offset that will not move', async () => {
        const result = await readSample({ ...queryIssueEventsPage, hasMore: true, nextOffset: 0 });

        expect(result.kind).toBe('sampled');
        if (result.kind !== 'sampled') return;
        expect(result.continuation).toBeUndefined();
        expect(result.incomplete).toBe(POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1);
    });

    it('claims the sample finished only on the provider\u2019s own end of it', async () => {
        const result = await readSample({ ...queryIssueEventsPage, hasMore: false, nextOffset: null });

        expect(result.kind).toBe('sampled');
        if (result.kind !== 'sampled') return;
        expect(result.continuation).toBeUndefined();
        expect(result.incomplete).toBeUndefined();
    });

    it('publishes the full explicit query that produced a sampled page for later evidence reread', async () => {
        const result = await readSample({ ...queryIssueEventsPage, hasMore: false, nextOffset: null });

        expect(result.kind).toBe('sampled');
        if (result.kind !== 'sampled') return;
        expect(result.frozenRequest).toMatchObject({
            v: 1,
            issueId: LOCAL_REF.entryId,
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['exception', 'stacktrace', 'navigation', 'correlation'],
            limit: 3,
            offset: 0,
        });
    });

    it('fits a complete sampled result through the canonical Action envelope and states omitted rows', async () => {
        const normal = queryIssueEventsPage.results[0];
        const largeSource = queryIssueEventsPage.results[1];
        if (normal === undefined || largeSource === undefined) {
            throw new Error('recorded sampled-event fixture must contain two valid rows');
        }
        const oversized = {
            ...largeSource,
            properties: {
                ...largeSource.properties,
                $exception_list: [{
                    type: 'TypeError',
                    value: 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES),
                    stacktrace: { frames: [] },
                }],
            },
        };
        const host = context([{
            results: [normal, oversized],
            hasMore: false,
            limit: 2,
            offset: 0,
            nextOffset: null,
        }]);

        const result = await readPosthogSampledEvents({
            v: 1,
            instance: configuredInstance(),
            localRef: LOCAL_REF,
            limit: 2,
        }, host.value);

        expect(result.kind).toBe('sampled');
        if (result.kind !== 'sampled') return;
        expect(PosthogSampledEventsResultV1Schema.safeParse(result).success).toBe(true);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
        expect(result.events.map((event) => event.uuid)).toEqual([normal.uuid]);
        expect(result.omittedRowCount).toBe(1);
    });
});
