import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import queryIssueEventsPage from '../api/__fixtures__/queryIssueEventsPage.json' with { type: 'json' };
import { POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../posthogContracts.js';
import type { PosthogFrozenIssueEventsRequestV1 } from '../source/detail/issueEventsContract.js';
import { encodePosthogConfiguration } from '../source/instance.js';
import type { PosthogProjectedIssueEvent } from '../ui/detail/issueEventProjection.js';

import { decodePosthogEvidenceCandidate } from './candidate.js';
import {
    createPosthogEvidenceCandidate,
    resolvePosthogEvidenceReference,
} from './reference.js';

const ACCOUNT = {
    service: { pluginId: 'happier.posthog', localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE },
    accountId: 'account-1',
} as const;

const ENTRY_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-0000000000f1';
const SECOND_EVENT_ID = '00000000-0000-4000-8000-0000000000f2';

function configuredInstance() {
    const encoded = encodePosthogConfiguration({
        v: 1,
        organizationUuid: '00000000-0000-4000-8000-0000000000a1',
        environments: [{
            teamPathId: 4821,
            teamUuid: '00000000-0000-4000-8000-0000000000d1',
            displayName: 'Storefront production',
        }],
        scanWindowPolicy: {
            kind: 'exact',
            from: '2026-07-01T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
        },
        detailWindowPolicy: {
            kind: 'exact',
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
        },
    });
    if (!encoded.ok) throw new Error('fixture configuration must encode');
    return {
        v: 1 as const,
        instance: {
            source: { pluginId: 'happier.posthog', localId: 'posthog-error-tracking' },
            sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
        },
        binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
        localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
        configuration: { v: 1 as const, token: encoded.token },
        locator: { v: 1 as const, displayLabel: 'PostHog production' },
    };
}

function selectedEvent(uuid = EVENT_ID): PosthogProjectedIssueEvent {
    return {
        uuid,
        timestampMs: 1_760_000_000_000,
        url: 'https://shop.example/checkout/summary',
        exceptions: [{
            type: 'TypeError',
            value: 'Cannot read properties of undefined (reading \'id\')',
            frames: [{
                function: 'renderSummary',
                source: 'app/checkout/summary.tsx',
                line: 128,
                column: 17,
                inApp: true,
            }],
        }],
    };
}

function sourceContext(response: unknown) {
    const materializeListedAccount = vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer secret' },
    }));
    const request = vi.fn(async () => ({
        status: 200,
        finalUrl: 'https://eu.posthog.com/api/projects/4821/error_tracking/query/issue_events/',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(response)),
    }));
    return {
        value: {
            signal: new AbortController().signal,
            services: {
                connectedAccounts: { materializeListedAccount },
                http: { request },
            },
        } as unknown as PluginInvocationContext,
        request,
    };
}

function disclosedCandidate(options: Readonly<{
    selected?: PosthogProjectedIssueEvent;
    selectedAbsoluteOffset?: number;
}> = {}) {
    const candidate = createPosthogEvidenceCandidate({
        instance: configuredInstance(),
        localRef: {
            kindId: 'error-issue',
            collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
            entryId: ENTRY_ID,
        },
        selected: options.selected ?? selectedEvent(),
        frozenRequest: {
            v: 1,
            issueId: ENTRY_ID,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['exception', 'stacktrace', 'navigation', 'correlation'],
            limit: 3,
            offset: 0,
        },
        // Every candidate names an absolute row position, even when this fixture uses
        // the first row; a later case proves a non-first row cannot replay page start.
        selectedAbsoluteOffset: options.selectedAbsoluteOffset ?? 0,
    });
    if (candidate === null) throw new Error('fixture evidence candidate must encode');
    return candidate;
}

describe('the PostHog selected-evidence Composer reference', () => {
    it('retains the entire frozen issue-events query, including its explicit privacy filters', () => {
        const exactFrozenQuery = {
            v: 1,
            issueId: ENTRY_ID,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-15T00:00:00.000Z',
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['exception', 'stacktrace', 'navigation', 'correlation'],
            limit: 3,
            offset: 0,
        } as unknown as PosthogFrozenIssueEventsRequestV1;
        const candidate = createPosthogEvidenceCandidate({
            instance: configuredInstance(),
            localRef: {
                kindId: 'error-issue',
                collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
                entryId: ENTRY_ID,
            },
            selected: selectedEvent(),
            frozenRequest: exactFrozenQuery,
            selectedAbsoluteOffset: 0,
        });

        expect(candidate).not.toBeNull();
        expect(decodePosthogEvidenceCandidate(candidate?.candidate.id ?? '')).toMatchObject({
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['exception', 'stacktrace', 'navigation', 'correlation'],
        });

        const alteredFilter = {
            ...exactFrozenQuery,
            include: ['exception', 'navigation'],
        } as unknown as PosthogFrozenIssueEventsRequestV1;
        expect(createPosthogEvidenceCandidate({
            instance: configuredInstance(),
            localRef: {
                kindId: 'error-issue',
                collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1',
                entryId: ENTRY_ID,
            },
            selected: selectedEvent(),
            frozenRequest: alteredFilter,
            selectedAbsoluteOffset: 0,
        })).toBeNull();
    });

    it('re-reads one exact selected occurrence through the configured account before publishing bounded evidence', async () => {
        const candidate = disclosedCandidate();
        const host = sourceContext({
            ...queryIssueEventsPage,
            results: [queryIssueEventsPage.results[0]],
            hasMore: false,
            limit: 1,
            offset: 0,
        });

        const resolved = await resolvePosthogEvidenceReference(candidate.candidate.id, host.value);

        expect(host.request).toHaveBeenCalledTimes(1);
        const request = host.request.mock.calls[0]?.[0] as Readonly<{ body: Uint8Array }>;
        expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
            issueId: ENTRY_ID,
            dateRange: {
                date_from: '2026-07-16T00:00:00.000Z',
                date_to: '2026-08-15T00:00:00.000Z',
            },
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['exception', 'stacktrace', 'navigation', 'correlation'],
            limit: 1,
            offset: 0,
        });
        expect(resolved.id).toBe(candidate.candidate.id);
        expect(resolved.context).toContain('TypeError');
        expect(resolved.context).toContain('renderSummary');
        // The resolver gets a provider-shaped properties bag, but selected evidence is
        // built only from the boundary projector’s allowlist after exact UUID equality.
        expect(resolved.context).not.toContain('person-distinct-id-must-not-survive');
        expect(resolved.context).not.toContain('buyer@example.invalid');
        expect(resolved.context).not.toContain('sentinel-must-not-survive');
        expect(resolved.context).not.toContain('00000000-0000-4000-8000-0000000000c1');
    });

    it('refuses a changed or multiply returned occurrence instead of publishing selection bytes', async () => {
        const candidate = disclosedCandidate();
        const host = sourceContext({
            ...queryIssueEventsPage,
            results: [
                queryIssueEventsPage.results[0],
                { ...queryIssueEventsPage.results[0], uuid: '00000000-0000-4000-8000-0000000000f2' },
            ],
            hasMore: false,
            limit: 1,
            offset: 0,
        });

        await expect(resolvePosthogEvidenceReference(candidate.candidate.id, host.value))
            .rejects.toMatchObject({ code: 'posthog/evidence-unavailable' });
        expect(host.request).toHaveBeenCalledTimes(1);
    });

    it('replays the selected row\'s absolute offset rather than the frozen page start', async () => {
        const candidate = disclosedCandidate({
            selected: selectedEvent(SECOND_EVENT_ID),
            selectedAbsoluteOffset: 1,
        });
        const host = sourceContext({
            ...queryIssueEventsPage,
            results: [{ ...queryIssueEventsPage.results[0], uuid: SECOND_EVENT_ID }],
            hasMore: false,
            limit: 1,
            offset: 1,
        });

        await expect(resolvePosthogEvidenceReference(candidate.candidate.id, host.value))
            .resolves.toMatchObject({ id: candidate.candidate.id });

        const request = host.request.mock.calls[0]?.[0] as Readonly<{ body: Uint8Array }>;
        expect(JSON.parse(new TextDecoder().decode(request.body))).toMatchObject({
            limit: 1,
            offset: 1,
        });
    });
});
