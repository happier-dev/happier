import { describe, expect, it } from 'vitest';

import crudIssueRead from '../__fixtures__/crudIssueRead.json' with { type: 'json' };
import organizationProjectsPage from '../__fixtures__/organizationProjectsPage.json' with { type: 'json' };
import organizationsPage from '../__fixtures__/organizationsPage.json' with { type: 'json' };
import queryIssueDetail from '../__fixtures__/queryIssueDetail.json' with { type: 'json' };
import queryIssueEventsPage from '../__fixtures__/queryIssueEventsPage.json' with { type: 'json' };
import queryIssuesPage1 from '../__fixtures__/queryIssuesPage1.json' with { type: 'json' };
import tolerantPage from '../__fixtures__/queryIssuesTolerantPage.json' with { type: 'json' };
import {
    parsePosthogDirectoryPage,
    parsePosthogEnvironmentRow,
    parsePosthogOrganizationRow,
} from './directory.js';
import {
    POSTHOG_ISSUE_EVENTS_INCLUDE,
    POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
    parsePosthogIssueEventsEnvelope,
} from './events.js';
import {
    parsePosthogIssueCrudRead,
    parsePosthogIssueQueryDetail,
    parsePosthogIssueRow,
    parsePosthogQueryEnvelope,
} from './issues.js';

describe('parsePosthogQueryEnvelope', () => {
    it('reads the recorded paging geometry, including an absent nextOffset', () => {
        expect(parsePosthogQueryEnvelope(queryIssuesPage1)).toMatchObject({
            hasMore: true,
            limit: 3,
            offset: 0,
            nextOffset: 3,
        });
        const { nextOffset: _dropped, ...withoutNextOffset } = queryIssuesPage1 as Record<string, unknown>;
        expect(parsePosthogQueryEnvelope(withoutNextOffset)).toMatchObject({ hasMore: true });
        expect(parsePosthogQueryEnvelope(withoutNextOffset)).not.toHaveProperty('nextOffset');
    });

    it('rejects an envelope whose paging geometry cannot be interpreted', () => {
        expect(parsePosthogQueryEnvelope({ results: [], limit: 3, offset: 0 })).toBeNull();
        expect(parsePosthogQueryEnvelope({ hasMore: false, limit: 3, offset: 0 })).toBeNull();
        expect(parsePosthogQueryEnvelope({ results: [], hasMore: false, limit: -1, offset: 0 }))
            .toBeNull();
        expect(parsePosthogQueryEnvelope({
            results: [], hasMore: true, limit: 3, offset: 0, nextOffset: 'soon',
        })).toBeNull();
        expect(parsePosthogQueryEnvelope(null)).toBeNull();
        expect(parsePosthogQueryEnvelope([])).toBeNull();
    });
});

describe('parsePosthogIssueRow', () => {
    it('reads a recorded row and lowercases its identity', () => {
        const row = parsePosthogIssueRow((queryIssuesPage1.results as readonly unknown[])[0]);

        expect(row).toEqual({
            id: '00000000-0000-4000-8000-000000000001',
            name: 'TypeError',
            description: "Cannot read properties of undefined (reading 'id')",
            nativeStatus: 'active',
            firstSeenMs: Date.parse('2026-07-30T09:14:02.113000Z'),
            lastSeenMs: Date.parse('2026-08-14T06:41:55.902000Z'),
            library: 'posthog-js',
            source: 'app/checkout/summary.tsx',
            assignee: { id: 41, type: 'user' },
            aggregations: { occurrences: 1842, users: 311, sessions: 402 },
        });
    });

    it('retains an unrecognized status verbatim, because the provider declares a bare string', () => {
        const rows = tolerantPage.results as readonly unknown[];
        expect(parsePosthogIssueRow(rows[4])?.nativeStatus).toBe('custom_future_state');
    });

    it('rejects only rows whose identity or state is unreadable', () => {
        const rows = tolerantPage.results as readonly unknown[];

        expect(parsePosthogIssueRow(rows[0])).not.toBeNull();
        expect(parsePosthogIssueRow(rows[1])).toBeNull();
        expect(parsePosthogIssueRow(rows[2])).toBeNull();
        expect(parsePosthogIssueRow(rows[3])).toBeNull();
        expect(parsePosthogIssueRow(rows[4])).not.toBeNull();
    });

    it('omits an unparseable timestamp rather than fabricating one', () => {
        const rows = tolerantPage.results as readonly unknown[];
        const row = parsePosthogIssueRow(rows[4]);

        expect(row).not.toBeNull();
        expect(row).not.toHaveProperty('firstSeenMs');
        expect(row?.lastSeenMs).toBe(Date.parse('2026-08-14T11:00:00.000000Z'));
    });

    it('accepts a string assignee id as well as a numeric one', () => {
        const rows = queryIssuesPage1.results as readonly unknown[];

        expect(parsePosthogIssueRow(rows[2])?.assignee)
            .toEqual({ id: '00000000-0000-4000-8000-0000000000aa', type: 'role' });
    });
});

describe('parsePosthogIssueQueryDetail', () => {
    it('reads the query-plane-only fields the list row cannot carry', () => {
        const detail = parsePosthogIssueQueryDetail(queryIssueDetail);

        expect(detail?.function).toBe('renderSummary');
        expect(detail?.topInAppFrame)
            .toEqual({ function: 'renderSummary', source: 'app/checkout/summary.tsx', line: 128, column: 17, inApp: true });
        expect(detail?.latestRelease?.commitId)
            .toBe('0000000000000000000000000000000000000000');
        expect(detail?.impact).toEqual({ occurrences: 1842, users: 311, sessions: 402 });
    });

    it('never carries severity, which lives only on the CRUD plane', () => {
        expect(JSON.stringify(parsePosthogIssueQueryDetail(queryIssueDetail)))
            .not.toContain('severity');
    });
});

describe('parsePosthogIssueCrudRead', () => {
    it('reads the CRUD-plane-only fields', () => {
        expect(parsePosthogIssueCrudRead(crudIssueRead)).toEqual({
            id: '00000000-0000-4000-8000-000000000001',
            nativeStatus: 'active',
            severity: 'high',
            name: 'TypeError',
            description: "Cannot read properties of undefined (reading 'id')",
            firstSeenMs: Date.parse('2026-07-30T09:14:02.113000Z'),
            assignee: { id: 41, type: 'user' },
            externalIssueCount: 1,
            cohortName: 'Checkout regressions',
        });
    });

    it('accepts a null severity, which the provider allows, without inventing one', () => {
        expect(parsePosthogIssueCrudRead({ ...crudIssueRead, severity: null })?.severity).toBeNull();
        expect(parsePosthogIssueCrudRead({ ...crudIssueRead, severity: 'catastrophic' })?.severity)
            .toBeNull();
    });

    it('never carries last seen or aggregations, which live only on the query plane', () => {
        const serialized = JSON.stringify(parsePosthogIssueCrudRead(crudIssueRead));

        expect(serialized).not.toContain('lastSeen');
        expect(serialized).not.toContain('aggregations');
    });
});

describe('parsePosthogIssueEventsEnvelope', () => {
    it('reads sampled events and never keeps a nested raw properties bag on the envelope', () => {
        const envelope = parsePosthogIssueEventsEnvelope(queryIssueEventsPage);

        expect(envelope?.rawEvents).toHaveLength(3);
        expect(envelope?.hasMore).toBe(true);
        expect(envelope?.nextOffset).toBe(3);
        expect(envelope?.skippedRowCount).toBe(0);
    });

    it('declares the exact include set and page ceiling the provider publishes', () => {
        expect(POSTHOG_ISSUE_EVENTS_MAX_LIMIT).toBe(20);
        expect([...POSTHOG_ISSUE_EVENTS_INCLUDE])
            .toEqual(['exception', 'stacktrace', 'navigation', 'correlation']);
        // The provider default omits `stacktrace` and adds `environment`; neither
        // `environment`, `release`, `diagnostics`, nor `code_variables` is requested.
        expect([...POSTHOG_ISSUE_EVENTS_INCLUDE]).not.toContain('environment');
        expect([...POSTHOG_ISSUE_EVENTS_INCLUDE]).not.toContain('code_variables');
        expect([...POSTHOG_ISSUE_EVENTS_INCLUDE]).not.toContain('release');
        expect([...POSTHOG_ISSUE_EVENTS_INCLUDE]).not.toContain('diagnostics');
    });

    it('skips an unreadable sampled row while keeping the rest of the page', () => {
        const envelope = parsePosthogIssueEventsEnvelope({
            ...queryIssueEventsPage,
            results: [...(queryIssueEventsPage.results as readonly unknown[]), { timestamp: 'x' }],
        });

        expect(envelope?.rawEvents).toHaveLength(3);
        expect(envelope?.skippedRowCount).toBe(1);
    });
});

describe('parsePosthogDirectoryPage', () => {
    it('reads organizations and preserves the absolute next URL for the caller to validate', () => {
        const page = parsePosthogDirectoryPage(organizationsPage, parsePosthogOrganizationRow);

        expect(page?.rows).toEqual([{
            organizationUuid: '00000000-0000-4000-8000-0000000000b1',
            name: 'Example Storefront',
            slug: 'example-storefront',
        }]);
        expect(page?.count).toBe(2);
        expect(page?.next).toBe('https://eu.posthog.com/api/organizations/?limit=1&offset=1');
        expect(page?.skippedRowCount).toBe(0);
    });

    it('keeps Team route id, Team UUID and parent project id distinct', () => {
        const page = parsePosthogDirectoryPage(organizationProjectsPage, parsePosthogEnvironmentRow);

        expect(page?.rows).toEqual([
            {
                teamRouteId: 4821,
                teamUuid: '00000000-0000-4000-8000-0000000000d1',
                organizationUuid: '00000000-0000-4000-8000-0000000000b1',
                parentProjectId: 4820,
                displayName: 'Storefront production',
            },
            {
                teamRouteId: 4822,
                teamUuid: '00000000-0000-4000-8000-0000000000d2',
                organizationUuid: '00000000-0000-4000-8000-0000000000b1',
                parentProjectId: 4820,
                displayName: 'Storefront staging',
            },
        ]);
        // Two environments of one parent project keep distinct routes and identities.
        expect(page?.rows[0]?.parentProjectId).toBe(page?.rows[1]?.parentProjectId);
        expect(page?.rows[0]?.teamRouteId).not.toBe(page?.rows[1]?.teamRouteId);
        expect(page?.rows[0]?.teamUuid).not.toBe(page?.rows[1]?.teamUuid);
    });

    it('never carries the public ingest project token out of the parser', () => {
        const page = parsePosthogDirectoryPage(organizationProjectsPage, parsePosthogEnvironmentRow);

        expect(JSON.stringify(page)).not.toContain('api_token');
        expect(JSON.stringify(page)).not.toContain('phc_');
    });

    it('reports an unreadable environment row as partial discovery, keeping valid rows', () => {
        const page = parsePosthogDirectoryPage({
            ...organizationProjectsPage,
            results: [
                ...(organizationProjectsPage.results as readonly unknown[]),
                { id: 4823, uuid: 'not-a-uuid', organization: 'x', project_id: 4820, name: 'Broken' },
            ],
        }, parsePosthogEnvironmentRow);

        expect(page?.rows).toHaveLength(2);
        expect(page?.skippedRowCount).toBe(1);
    });

    it('rejects an envelope with no results array at all', () => {
        expect(parsePosthogDirectoryPage({ count: 1 }, parsePosthogOrganizationRow)).toBeNull();
    });
});
