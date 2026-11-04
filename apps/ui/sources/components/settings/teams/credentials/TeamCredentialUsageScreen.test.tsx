import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialResourceFixture, teamGroupFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load real owners after HTTP installation, outside a timed per-case setup.
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');

vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const TEAM_GET_PATH = '/v1/teams/get';
const CREDENTIAL_GET_PATH = '/v1/teams/credential-resources/get';
const USAGE_QUERY_PATH = '/v1/teams/credential-resources/usage/query';
const GROUPS_LIST_PATH = '/v1/teams/groups/list';
const MEMBERS_LIST_PATH = '/v1/teams/members/list';

const NO_TOKENS = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const NO_COST = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };

function usageResult(overrides?: Readonly<{
    requestCount?: number;
    totalTokens?: number;
    costIncomplete?: boolean;
    estimatedUsd?: number;
    reportedUsd?: number;
    apiEquivalentUsd?: number;
    directRecordedUseOnly?: boolean;
    requestCountCoverage?: 'complete' | 'brokered_only';
    tokenCoverage?: 'complete' | 'partial' | 'unavailable';
    costCoverage?: 'complete' | 'partial' | 'unavailable';
    unobservedExternalRequestCount?: number;
    breakdown?: readonly { key: string; label?: string; requestCount: number; tokens: number }[];
    nextCursor?: string | null;
    series?: readonly { bucketStartMs: number; bucketEndMs: number; requestCount: number; tokens: number }[];
    limits?: readonly Record<string, unknown>[];
}>) {
    return {
        v: 1,
        totals: {
            eventCount: 3,
            requestCount: overrides?.requestCount ?? 12,
            tokens: { ...NO_TOKENS, total: overrides?.totalTokens ?? 4200 },
            cost: {
                ...NO_COST,
                estimatedUsd: overrides?.estimatedUsd ?? 0,
                reportedUsd: overrides?.reportedUsd ?? 0,
                ...(overrides?.apiEquivalentUsd === undefined ? {} : { apiEquivalentUsd: overrides.apiEquivalentUsd }),
            },
        },
        coverage: {
            requestAdmissionCount: overrides?.requestCount ?? 12,
            agentObservationCount: 3,
            externalTerminalObservationCount: 0,
            directRecordedUseOnly: overrides?.directRecordedUseOnly ?? false,
            requestCountCoverage: overrides?.requestCountCoverage
                ?? (overrides?.directRecordedUseOnly ? 'brokered_only' : 'complete'),
            tokenCoverage: overrides?.tokenCoverage ?? 'complete',
            costCoverage: overrides?.costCoverage
                ?? (overrides?.costIncomplete ? 'partial' : 'complete'),
            unobservedExternalRequestCount: overrides?.unobservedExternalRequestCount ?? 0,
        },
        series: (overrides?.series ?? []).map((entry) => ({
            bucketStartMs: entry.bucketStartMs,
            bucketEndMs: entry.bucketEndMs,
            totals: {
                eventCount: 1,
                requestCount: entry.requestCount,
                tokens: { ...NO_TOKENS, total: entry.tokens },
                cost: { ...NO_COST },
            },
        })),
        ...(overrides?.breakdown
            ? {
                breakdown: overrides.breakdown.map((entry) => ({
                    key: entry.key,
                    ...(entry.label === undefined ? {} : { label: entry.label }),
                    totals: {
                        eventCount: 1,
                        requestCount: entry.requestCount,
                        tokens: { ...NO_TOKENS, total: entry.tokens },
                        cost: { ...NO_COST },
                    },
                })),
            }
            : {}),
        nextCursor: overrides?.nextCursor ?? null,
        limits: overrides?.limits ?? [],
    };
}

async function renderUsage(serverId: string) {
    const { TeamCredentialUsageScreen } = await import('./TeamCredentialUsageScreen');
    return renderScreen(
        <TeamCredentialUsageScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
    );
}

async function addHome(options?: Readonly<{ deliveryMode?: 'brokered' | 'direct' | 'both' }>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
    });
    harness.answer(serverId, CREDENTIAL_GET_PATH, {
        body: teamCredentialResourceFixture({
            allMembersAllowedRoutes: options?.deliveryMode === 'both'
                ? ['brokered', 'direct'] : [options?.deliveryMode ?? 'brokered'],
        }),
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderUsage>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
});

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
});

async function addRecipientHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-maya',
        teamsEnabled: true,
        credentialResourcesEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
    });
    harness.answer(serverId, CREDENTIAL_GET_PATH, {
        status: 404,
        body: { error: 'not_found_or_not_visible' },
    });
    harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
        body: TeamCredentialResourceDiscoveryPageV1Schema.parse({
            nextCursor: null,
            failures: [],
            resources: [{
                id: 'resource-1', teamId: 'team-1', displayName: 'Acme Provider', resourceRevision: 7,
                readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
                sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [],
                usageCapabilities: {
                    inferenceRequests: 'available', totalTokens: 'available', costUsd: 'unavailable',
                    limitCoverage: 'brokered_only',
                },
                usageLimit: {
                    metric: 'cost_usd', remaining: '0', resetsAtUtc: '2026-09-15T00:00:00.000Z',
                },
                sourcePresentation: {
                    kind: 'provider',
                    provider: {
                        identity: { pluginId: 'happier.provider.openrouter', localId: 'openrouter' },
                        definitionRevision: 1,
                    },
                },
            }],
        }),
    });
    return serverId;
}

describe('TeamCredentialUsageScreen', () => {
    it('names the Group or person each limit governs, says a Group allowance is shared, and lists the tightest first', async () => {
        const serverId = await addHome();
        harness.answer(serverId, GROUPS_LIST_PATH, {
            body: { items: [teamGroupFixture({ id: 'group-devs', name: 'Developers' })], nextCursor: null },
        });
        harness.answer(serverId, MEMBERS_LIST_PATH, {
            body: { items: [teamMembershipFixture({ id: 'membership-grace', accountId: 'account-grace' })], nextCursor: null },
        });
        const window = { recorded: '10', resetsAtUtc: '2026-10-01T00:00:00.000Z' };
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                limits: [
                    { id: 'limit-group', subjectKind: 'team_group', subjectId: 'group-devs', period: 'month', metric: 'inference_requests', maximum: '100', enabled: true, currentWindow: window },
                    { id: 'limit-member', subjectKind: 'team_member', subjectId: 'account-grace', period: 'month', metric: 'inference_requests', maximum: '12', enabled: true, currentWindow: window },
                    { id: 'limit-resource', subjectKind: 'resource', subjectId: '', period: 'month', metric: 'inference_requests', maximum: '1000', enabled: true, currentWindow: window },
                ],
            }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-limit:limit-group');
        // The declared row carries the projection; the painted host only carries its text.
        const declaredRow = (testID: string) => screen.findAllByTestId(testID)[0];
        await vi.waitFor(() => expect(String(declaredRow('team-credential-usage-limit:limit-group')?.props.title)).toContain('Developers'));

        const groupRow = declaredRow('team-credential-usage-limit:limit-group');
        expect(String(groupRow?.props.title)).not.toContain('teams.credentials.limits.subject.group');
        // The Group's remaining amount is one shared allowance, not a private per-member one.
        expect(String(groupRow?.props.subtitle)).toContain('teams.credentials.limits.groupShared');
        await vi.waitFor(() => expect(String(declaredRow('team-credential-usage-limit:limit-member')?.props.title)).toContain('Ada'));
        expect(String(declaredRow('team-credential-usage-limit:limit-member')?.props.subtitle))
            .not.toContain('teams.credentials.limits.groupShared');

        // Most restrictive first: 2 remaining, then 90, then 990.
        const order = collectRenderedTestIds(screen.tree.toJSON())
            .filter((testID) => testID.startsWith('team-credential-usage-limit:'));
        expect(order).toEqual([
            'team-credential-usage-limit:limit-member',
            'team-credential-usage-limit:limit-group',
            'team-credential-usage-limit:limit-resource',
        ]);
    });

    it('mounts the canonical time series instead of discarding the Home buckets', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                series: [
                    { bucketStartMs: Date.UTC(2026, 8, 1), bucketEndMs: Date.UTC(2026, 8, 2), requestCount: 2, tokens: 120 },
                    { bucketStartMs: Date.UTC(2026, 8, 2), bucketEndMs: Date.UTC(2026, 8, 3), requestCount: 1, tokens: 80 },
                ],
            }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-series');

        expect(screen.findAllHostsByTestId('usage-volume-point-trigger')).toHaveLength(2);
        expect(screen.findAllHostsByTestId('team-credential-usage-series-list-row')).toHaveLength(0);

        await screen.pressByTestIdAsync('team-credential-usage-series-list-toggle');

        expect(screen.findAllHostsByTestId('team-credential-usage-series-list-row')).toHaveLength(2);
    });

    it('reports an unpriced period as unavailable rather than as nothing spent', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ costIncomplete: true, estimatedUsd: 0 }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-cost');

        const text = screen.getTextContent();
        expect(text).toContain('teams.credentials.usage.costUnknown');
        // A missing price is not a free request, so no zero amount may appear.
        expect(text).not.toContain('$0.00');
        expect(text).toContain('teams.credentials.usage.costIncomplete');
    });

    it('offers the API-equivalent cost mode when the totals carry it and asks the Home for it', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ reportedUsd: 2, apiEquivalentUsd: 9 }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-cost-mode:api_equivalent');

        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult({ reportedUsd: 2, apiEquivalentUsd: 9 }) });
        screen.pressByTestId('team-credential-usage-cost-mode:api_equivalent');
        await vi.waitFor(() => {
            expect(harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input).toMatchObject({ costMode: 'api_equivalent' });
        });
        await vi.waitFor(() => {
            expect(screen.findAllByTestId('team-credential-usage-cost')[0]?.props.subtitle)
                .toBe('usage.board.page.factApiEquivalent');
        });
    });

    it('says whether a cost is reported or estimated and lets the reader ask for either', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ estimatedUsd: 3, reportedUsd: 2 }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-cost-mode:estimated');
        // A mixed automatic total names both of its components.
        expect(screen.findAllByTestId('team-credential-usage-cost')[0]?.props.subtitle)
            .toBe('usage.reported + usage.estimated');
        expect(harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input).toMatchObject({ costMode: 'auto' });

        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult({ estimatedUsd: 3, reportedUsd: 2 }) });
        screen.pressByTestId('team-credential-usage-cost-mode:estimated');
        await vi.waitFor(() => {
            expect(harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input).toMatchObject({ costMode: 'estimated' });
        });
        await vi.waitFor(() => {
            expect(screen.findAllByTestId('team-credential-usage-cost')[0]?.props.subtitle).toBe('usage.estimated');
        });
    });

    it('keeps a real zero a real zero when the Home priced the whole period', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ costIncomplete: false, estimatedUsd: 0 }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-cost');

        expect(screen.getTextContent()).toContain('$0.00');
        expect(screen.getTextContent()).toContain('teams.credentials.usage.recordedByHappier');
    });

    it('says direct use is missing from the totals when the audience receives material', async () => {
        const serverId = await addHome({ deliveryMode: 'both' });
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                directRecordedUseOnly: true,
                requestCountCoverage: 'brokered_only',
                tokenCoverage: 'partial',
                costCoverage: 'partial',
            }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-requests');

        // Happier records nothing that happens on a recipient's own machine, so
        // presenting these totals as complete would be a lie.
        expect(screen.getTextContent()).toContain('teams.credentials.usage.directIncomplete');
        expect(screen.getTextContent()).not.toContain('teams.credentials.usage.recordedByHappier');
    });

    it('keeps historical direct-use incompleteness visible after the resource becomes broker-only', async () => {
        const serverId = await addHome({ deliveryMode: 'brokered' });
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ directRecordedUseOnly: true }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-tokens');

        expect(screen.getTextContent()).toContain('teams.credentials.usage.directIncomplete');
        expect(screen.getTextContent()).not.toContain('teams.credentials.usage.recordedByHappier');
    });

    it('asks the Home for the chosen dimension and renders the slices it named', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-requests');

        expect(screen.findAllHostsByTestId('team-credential-usage-breakdown:member')).toHaveLength(0);
        await screen.pressByTestIdAsync('team-credential-usage-breakdown-trigger');
        await waitForTestId(screen, 'team-credential-usage-breakdown:member');
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                breakdown: [
                    { key: 'account-maya', label: 'Maya Chen', requestCount: 7, tokens: 900 },
                    { key: 'account-unnamed', requestCount: 2, tokens: 100 },
                    { key: 'account-ada', requestCount: 3, tokens: 200 },
                ],
            }),
        });
        screen.pressByTestId('team-credential-usage-breakdown:member');

        await waitForTestId(screen, 'team-credential-usage-slice:account-maya');
        const last = harness.requestsFor(USAGE_QUERY_PATH).at(-1);
        expect((last?.input as { breakdown?: string } | undefined)?.breakdown).toBe('member');
        expect(screen.getTextContent()).toContain('Maya Chen');
        expect(screen.findAllByTestId('team-credential-usage-slice:account-unnamed')[0]?.props.title).toBe('accountDisplay.unnamed');
        expect(screen.findAllByTestId('team-credential-usage-slice:account-unnamed')[0]?.props.subtitle).toContain('accountDisplay.shortId');
        expect(screen.findAllByTestId('team-credential-usage-slice:account-ada')[0]?.props.title).toBe('accountDisplay.yours');
        expect(screen.findAllByTestId('team-credential-usage-slice:account-ada')[0]?.props.subtitle).not.toContain('accountDisplay.shortId');
        expect(screen.getTextContent()).not.toContain('account-unnamed');
        expect(screen.getTextContent()).not.toContain('account-ada');
        expect(screen.findAllHostsByTestId('team-credential-usage-breakdown:member')).toHaveLength(0);

        await screen.pressByTestIdAsync('team-credential-usage-breakdown-trigger');
        await waitForTestId(screen, 'team-credential-usage-breakdown:model');
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ breakdown: [{ key: 'model-without-label', requestCount: 1, tokens: 100 }] }),
        });
        await screen.pressByTestIdAsync('team-credential-usage-breakdown:model');
        await waitForTestId(screen, 'team-credential-usage-slice:model-without-label');
        expect(screen.findAllByTestId('team-credential-usage-slice:model-without-label')[0]?.props.title).toBe('model-without-label');
    });

    it('loads every usage page without replacing already visible slices', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-requests');

        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                breakdown: [{ key: 'account-maya', label: 'Maya Chen', requestCount: 7, tokens: 900 }],
                nextCursor: 'usage-page-2',
            }),
        });
        await screen.pressByTestIdAsync('team-credential-usage-breakdown-trigger');
        await waitForTestId(screen, 'team-credential-usage-breakdown:member');
        await screen.pressByTestIdAsync('team-credential-usage-breakdown:member');
        await waitForTestId(screen, 'team-credential-usage-load-more');

        let releaseSecondPage!: () => void;
        const secondPageGate = new Promise<void>((resolve) => { releaseSecondPage = resolve; });
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                breakdown: [{ key: 'account-lin', label: 'Lin Park', requestCount: 4, tokens: 600 }],
                nextCursor: null,
            }),
            respondAfter: secondPageGate,
        });
        screen.pressByTestId('team-credential-usage-load-more');

        await vi.waitFor(() => {
            expect(harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input).toMatchObject({
                cursor: 'usage-page-2',
            });
        });
        expect(screen.getTextContent()).toContain('Maya Chen');
        releaseSecondPage();

        await waitForTestId(screen, 'team-credential-usage-slice:account-lin');
        expect(screen.getTextContent()).toContain('Maya Chen');
        expect((harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input as { cursor?: string }).cursor)
            .toBe('usage-page-2');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credential-usage-load-more');
    });

    it('keeps a partial page visible and retries its exact cursor after a failure', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-requests');
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                breakdown: [{ key: 'account-maya', label: 'Maya Chen', requestCount: 7, tokens: 900 }],
                nextCursor: 'usage-page-2',
            }),
        });
        await screen.pressByTestIdAsync('team-credential-usage-breakdown-trigger');
        await waitForTestId(screen, 'team-credential-usage-breakdown:member');
        await screen.pressByTestIdAsync('team-credential-usage-breakdown:member');
        await waitForTestId(screen, 'team-credential-usage-load-more');

        harness.answer(serverId, USAGE_QUERY_PATH, { status: 503, body: { error: 'unavailable' } });
        screen.pressByTestId('team-credential-usage-load-more');
        await waitForTestId(screen, 'team-credential-usage-load-more-retry');
        expect(screen.getTextContent()).toContain('Maya Chen');

        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                breakdown: [{ key: 'account-lin', label: 'Lin Park', requestCount: 4, tokens: 600 }],
                nextCursor: null,
            }),
        });
        screen.pressByTestId('team-credential-usage-load-more-retry');
        await waitForTestId(screen, 'team-credential-usage-slice:account-lin');
        expect((harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input as { cursor?: string }).cursor)
            .toBe('usage-page-2');
    });

    it('names a mixed resource’s request total as the brokered part it actually measured', async () => {
        const serverId = await addHome({ deliveryMode: 'both' });
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                directRecordedUseOnly: true,
                requestCountCoverage: 'brokered_only',
                tokenCoverage: 'partial',
                costCoverage: 'partial',
            }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-requests');

        // Requests come from broker admission, so a resource that also hands
        // out material has requests Happier never saw. Calling the total
        // "requests" would present a partial measurement as the whole.
        expect(screen.findAllByTestId('team-credential-usage-requests')[0]?.props.title)
            .toBe('teams.credentials.usage.recordedRequests');
    });

    it('omits the request metric entirely for a resource shared only as material', async () => {
        const serverId = await addHome({ deliveryMode: 'direct' });
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ requestCount: 0, directRecordedUseOnly: true }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-tokens');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credential-usage-requests');
        expect(screen.getTextContent()).toContain('teams.credentials.usage.requestIncomplete');
    });

    it('shows request-only external admission without rendering absent token or cost observations as zero', async () => {
        const serverId = await addHome({ deliveryMode: 'brokered' });
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                requestCount: 3,
                totalTokens: 0,
                requestCountCoverage: 'complete',
                tokenCoverage: 'unavailable',
                costCoverage: 'unavailable',
                unobservedExternalRequestCount: 3,
            }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-requests');

        expect(screen.findAllByTestId('team-credential-usage-requests')[0]?.props.detail).toContain('3');
        expect(screen.findAllByTestId('team-credential-usage-tokens')[0]?.props.detail).toBe('common.unavailable');
        expect(screen.findAllByTestId('team-credential-usage-cost')[0]?.props.detail)
            .toBe('teams.credentials.usage.costUnknown');
        expect(screen.getTextContent()).toContain('teams.credentials.usage.externalObservationsIncomplete');
    });

    it('does not offer a recipient the dimensions the Home withholds from them', async () => {
        const serverId = await addRecipientHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-breakdown-trigger');
        await screen.pressByTestIdAsync('team-credential-usage-breakdown-trigger');
        await waitForTestId(screen, 'team-credential-usage-breakdown:member');

        // The usage owner drops these two for an ordinary recipient, so an
        // offered control would answer with an empty list — which reads as
        // "nothing was used" rather than "not shown to you".
        const rendered = collectRenderedTestIds(screen.tree.toJSON());
        expect(rendered).not.toContain('team-credential-usage-breakdown:source_member');
        expect(rendered).not.toContain('team-credential-usage-breakdown:broker_machine');
        expect(rendered).toContain('team-credential-usage-breakdown:model');
        expect(screen.getTextContent()).toContain('teams.credentials.usage.breakdownRestricted');
        expect(screen.findAllByTestId('team-credential-usage-recipient-limit')[0]?.props.detail).toBe('0');
        expect(screen.getTextContent()).toContain('teams.credentials.limits.resetsUtc');
    });

    it('offers every dimension to the viewer who administers the resource', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-breakdown-trigger');
        await screen.pressByTestIdAsync('team-credential-usage-breakdown-trigger');
        await waitForTestId(screen, 'team-credential-usage-breakdown:source_member');

        expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-usage-breakdown:broker_machine');
        expect(screen.getTextContent()).not.toContain('teams.credentials.usage.breakdownRestricted');
    });

    it('reads the chosen metric in the chart and in its table alternative', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                series: [
                    { bucketStartMs: Date.UTC(2026, 8, 1), bucketEndMs: Date.UTC(2026, 8, 2), requestCount: 2, tokens: 120 },
                ],
            }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-series');
        await screen.pressByTestIdAsync('team-credential-usage-series-list-toggle');
        expect(screen.findAllByTestId('team-credential-usage-series-list-row')[0]?.props.detail)
            .toContain('usage.tokens');

        await screen.pressByTestIdAsync('team-credential-usage-metric:cost');

        // The chart and the list must show the same measurement; a chart-only
        // metric is not reachable without sight.
        expect(screen.findAllByTestId('team-credential-usage-series')
            .find((node) => Array.isArray(node.props.series))?.props.series).toMatchObject([
                { id: 'cost', points: [{ y: 0 }] },
            ]);
        expect(screen.findAllByTestId('team-credential-usage-series-list-row')[0]?.props.detail)
            .not.toContain('usage.tokens');
    });

    it('offers recorded requests in the chart and table only when that request metric is honest', async () => {
        const serverId = await addHome({ deliveryMode: 'brokered' });
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({
                series: [
                    { bucketStartMs: Date.UTC(2026, 8, 1), bucketEndMs: Date.UTC(2026, 8, 2), requestCount: 2, tokens: 120 },
                ],
            }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-series');
        await screen.pressByTestIdAsync('team-credential-usage-series-list-toggle');
        await screen.pressByTestIdAsync('team-credential-usage-metric:requests');

        expect(screen.findAllByTestId('team-credential-usage-series')
            .find((node) => Array.isArray(node.props.series))?.props.series).toMatchObject([
                { id: 'requests', points: [{ y: 2 }] },
            ]);
        expect(screen.findAllByTestId('team-credential-usage-series-list-row')[0]?.props.detail)
            .toContain('2');
    });

    it('refreshes through a current end time while preserving the previous snapshot', async () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(Date.UTC(2026, 8, 14, 10));
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult({ totalTokens: 4200 }) });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-refresh');
        const firstEndMs = (harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input as { endMs: number }).endMs;

        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        now.mockReturnValue(Date.UTC(2026, 8, 14, 11));
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ totalTokens: 8400 }),
            respondAfter: refreshGate,
        });
        screen.pressByTestId('team-credential-usage-refresh');

        await vi.waitFor(() => {
            const latest = harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input as { endMs: number } | undefined;
            expect(latest?.endMs).toBeGreaterThan(firstEndMs);
        });
        expect(screen.getTextContent()).toContain('4,200');
        expect(screen.findAllByTestId('team-credential-usage-export')[0]?.props.disabled).toBe(true);
        releaseRefresh();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('8,400'));
        now.mockRestore();
    });

    it('rereads through a current end time when the Home says this resource recorded usage, coalescing wakes while a read is in flight', async () => {
        const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');
        const deliver = (update: unknown, sourceServerId: string) => handleEphemeralSocketUpdate({
            update,
            sourceServerId,
            addActivityUpdate: () => {},
            addMachineActivityUpdate: () => {},
            getSessionEncryption: () => null,
            getSession: () => undefined,
            applyMessages: () => {},
        });
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(Date.UTC(2026, 8, 14, 10));
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult({ totalTokens: 4200 }) });

        const screen = await renderUsage(serverId);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('4,200'));
        const readsAfterMount = harness.requestsFor(USAGE_QUERY_PATH).length;
        const firstEndMs = (harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input as { endMs: number }).endMs;

        // Another resource, or the same resource id on another Home, is not this view.
        now.mockReturnValue(Date.UTC(2026, 8, 14, 11));
        await deliver({ type: 'team-credential-usage-changed', resourceId: 'resource-2' }, serverId);
        await deliver({ type: 'team-credential-usage-changed', resourceId: 'resource-1' }, 'another-home');
        expect(harness.requestsFor(USAGE_QUERY_PATH)).toHaveLength(readsAfterMount);

        let releaseRead!: () => void;
        harness.answer(serverId, USAGE_QUERY_PATH, {
            body: usageResult({ totalTokens: 8400 }),
            respondAfter: new Promise<void>((resolve) => { releaseRead = resolve; }),
        });
        await deliver({ type: 'team-credential-usage-changed', resourceId: 'resource-1' }, serverId);
        await vi.waitFor(() => expect(harness.requestsFor(USAGE_QUERY_PATH)).toHaveLength(readsAfterMount + 1));
        expect((harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input as { endMs: number }).endMs)
            .toBeGreaterThan(firstEndMs);
        expect(screen.getTextContent()).toContain('4,200');

        // Two more writes land while that read is in flight: one trailing read covers both.
        now.mockReturnValue(Date.UTC(2026, 8, 14, 12));
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult({ totalTokens: 9000 }) });
        await deliver({ type: 'team-credential-usage-changed', resourceId: 'resource-1' }, serverId);
        await deliver({ type: 'team-credential-usage-changed', resourceId: 'resource-1' }, serverId);
        expect(harness.requestsFor(USAGE_QUERY_PATH)).toHaveLength(readsAfterMount + 1);
        releaseRead();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('9,000'));
        expect(harness.requestsFor(USAGE_QUERY_PATH)).toHaveLength(readsAfterMount + 2);
        now.mockRestore();
    });

    it('does not offer the retained period as a file after the new period fails', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult({ totalTokens: 4200 }) });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-export');
        expect(screen.findAllByTestId('team-credential-usage-export')[0]?.props.disabled).toBeFalsy();

        harness.answer(serverId, USAGE_QUERY_PATH, { status: 503, body: { error: 'unavailable' } });
        screen.pressByTestId('team-credential-usage-period:today');
        await vi.waitFor(() => {
            expect(harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input).toMatchObject({ granularity: 'hour' });
        });

        // Settle on the FAILED state, not the loading window on the way to it:
        // the old gate covered `status === 'loading'` and would pass there.
        await waitForTestId(screen, 'team-credential-usage-retry');

        // The previous period's numbers deliberately stay on screen, but the
        // file would stamp the NEW period's dates on them, so it is withheld
        // until the query that produced these numbers is the one being asked.
        expect(screen.findAllByTestId('team-credential-usage-export')[0]?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('4,200');
    });

    it('asks the Home for the canonical period the reader selected', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-requests');

        screen.pressByTestId('team-credential-usage-period:today');
        await vi.waitFor(() => {
            expect(harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input).toMatchObject({ granularity: 'hour' });
        });
    });

    it('offers the visible period as a file once the Home has answered', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-export');

        expect(screen.findAllByTestId('team-credential-usage-export')[0]?.props.disabled).toBeFalsy();
    });

    it('reauthorizes the shown usage query through export before delivering the CSV', async () => {
        const serverId = await addHome();
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });
        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-export');
        const shownQuery = harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input;
        const reads = harness.requestsFor(USAGE_QUERY_PATH).length;
        const click = vi.fn();
        vi.stubGlobal('document', { createElement: () => ({ click, remove: vi.fn(), style: {} }), body: { appendChild: vi.fn() } });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-usage-export');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        screen.pressByTestId('team-credential-usage-export');
        await vi.waitFor(() => expect(harness.requestsFor(USAGE_QUERY_PATH)).toHaveLength(reads + 1));
        expect(harness.requestsFor(USAGE_QUERY_PATH).at(-1)?.input).toEqual(shownQuery);
        await vi.waitFor(() => expect(click).toHaveBeenCalled());

        harness.answer(serverId, USAGE_QUERY_PATH, { status: 403, body: { error: 'not_found_or_not_visible' } });
        click.mockClear();
        screen.pressByTestId('team-credential-usage-export');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('teams.credentials.usage.exportFailed'));
        expect(click).not.toHaveBeenCalled();
    });

    it('opens no usage read at all when this Home has shared credentials turned off', async () => {
        const serverId = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            accountId: 'account-ada',
            teamsEnabled: true,
            credentialResourcesEnabled: false,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-unavailable');

        expect(harness.requestsFor(USAGE_QUERY_PATH)).toHaveLength(0);
    });

    it('settles an initial resource-list failure and retries without pretending it is still loading', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIAL_GET_PATH, { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, USAGE_QUERY_PATH, { body: usageResult() });

        const screen = await renderUsage(serverId);
        await waitForTestId(screen, 'team-credential-usage-resource-retry');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credential-usage-loading');

        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ allMembersAllowedRoutes: ['brokered'] }),
        });
        screen.pressByTestId('team-credential-usage-resource-retry');

        await waitForTestId(screen, 'team-credential-usage-requests');
    });
});
