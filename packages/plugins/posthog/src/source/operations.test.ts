import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
// The published result schemas live on the protocol entry point; `testing/v1` publishes
// only the conformance helpers and the fixture builder.
import {
    MAX_TRIAGE_INSTANCE_DRAFTS_V1,
    MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
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
import { POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../posthogContracts.js';
import { PosthogSampledEventsResultV1Schema } from './detail/issueEventsContract.js';
import {
    POSTHOG_FAILURE_CODES,
    getPosthogSourceEntry,
    listPosthogInstances,
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

function context(responses: readonly unknown[], statuses: readonly number[] = []) {
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
    const materializeListedAccount = vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer secret' },
    }));
    const request = vi.fn(async (input: Readonly<{ url: string }>) => {
        const index = call++;
        const body = responses[index];
        return {
            status: statuses[index] ?? 200,
            finalUrl: input.url,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify(body)),
        };
    });
    return {
        value: {
            signal: new AbortController().signal,
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
            // The bound is the published draft ceiling, not a literal: a shrunk ceiling
            // must move the request this source makes, not silently fail this check.
            { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, limit: MAX_TRIAGE_INSTANCE_DRAFTS_V1 },
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
        }), { signal: host.value.signal });
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

    it('ends the walk truthfully when the next continuation cannot fit the protocol bound', async () => {
        // The target copies a token back verbatim, so the walk position this source
        // resumes from is the widest input it can be handed. The token below is exactly
        // at the published bound; advancing the offset by one digit puts the NEXT token
        // one byte over it, and the token is a member of a `policy: 'closed'` result — so
        // emitting it discards every row on this page and the reader sees no list.
        const encoder = new TextEncoder();
        const geometry = (offset: number, pad: number): string => JSON.stringify({
            v: 1,
            environmentIndex: 0,
            offset,
            from: `2026-07-01T00:00:00.000Z${'x'.repeat(pad)}`,
            to: null,
            nativeLimit: 3,
        });
        const pad = MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1
            - encoder.encode(geometry(9, 0)).byteLength;
        expect(encoder.encode(geometry(9, pad)).byteLength)
            .toBe(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
        expect(encoder.encode(geometry(12, pad)).byteLength)
            .toBeGreaterThan(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);

        const host = context([{ ...queryIssuesPage1, nextOffset: 12 }]);
        const result = await scanPosthogSource({
            v: 1,
            instance: configuredInstance(),
            page: { kind: 'continuation', continuation: { v: 1, token: geometry(9, pad) } },
        }, host.value);

        expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
        // The page's rows survive: an unresumable walk is a coverage fact, not a reason
        // to throw away entries the provider already answered with.
        expect(result.kind).toBe('complete');
        if (result.kind !== 'complete') return;
        expect(result.observations).toHaveLength(3);
        expect(result.evidence).toEqual({
            kind: 'partial',
            reason: POSTHOG_FAILURE_CODES.continuationUnmintable,
        });
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
