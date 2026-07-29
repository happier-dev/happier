import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import * as storeHooks from '@/sync/store/hooks';
import { UsageAnalyticsDashboard } from './UsageAnalyticsDashboard';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import type { UsageDataPoint } from '@/sync/api/account/apiUsage';
import { DropdownMenu, type DropdownMenuProps } from '@/components/ui/forms/dropdown/DropdownMenu';

const setClipboardStringSafeMock = vi.hoisted(() => vi.fn(async () => true));
const modalAlertMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: setClipboardStringSafeMock,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: modalAlertMock },
    }).module;
});

function getNodeTextContent(node: unknown): string {
    if (node == null) {
        return '';
    }
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    if (Array.isArray(node)) {
        return node.map((child) => getNodeTextContent(child)).join('');
    }
    if (typeof node === 'object' && 'props' in node && node.props && typeof node.props === 'object' && 'children' in node.props) {
        return getNodeTextContent((node.props as { children?: unknown }).children);
    }
    return '';
}

function findUsageFilterDropdown(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testID: string,
): { props: DropdownMenuProps } {
    const dropdown = screen
        .findAllByType(DropdownMenu as never)
        .find((node) => node.props?.itemTrigger?.itemProps?.testID === testID);

    if (!dropdown) {
        throw new Error(`Expected DropdownMenu with trigger testID "${testID}"`);
    }

    return dropdown as unknown as { props: DropdownMenuProps };
}

const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 3,
        tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
        cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [
        {
            bucketStartMs: 1_700_000_000_000,
            bucketEndMs: 1_700_086_400_000,
            eventCount: 1,
            tokens: { input: 50, output: 10, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 },
            cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
        },
        {
            bucketStartMs: 1_700_086_400_000,
            bucketEndMs: 1_700_172_800_000,
            eventCount: 2,
            tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 5, cacheWrite: 0, total: 70 },
            cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
        },
    ],
    breakdowns: {
        agent: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        model: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2, tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 }, cost: { reportedUsd: 11, estimatedUsd: 7, currency: 'USD' } }],
        session: [{ key: 'session-a', label: 'Session A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD' } }],
        project: [{ key: 'project-a', label: 'Project A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD' } }],
        workspace: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        backendMode: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        source: [{ key: 'claude_sdk', label: 'Claude SDK', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
    },
    insights: {
        activeDays: 2,
        longestStreakDays: 2,
        sessionsUsed: 2,
        messagesUsed: 12,
        modelsTried: 2,
        favoriteModel: { key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
        favoriteModelChangeCount: 3,
        busiestMonth: { key: '2024-04', label: 'Apr 2024' },
        busiestDay: { key: '2024-04-25', label: 'Thu' },
        busiestHour: { key: '13', label: '1 PM' },
    },
    activity: {
        calendarDays: [
            { date: '2024-04-24', eventCount: 1 },
            { date: '2024-04-25', eventCount: 2 },
        ],
        weekdayHourBuckets: [
            { weekday: 4, hour: 13, eventCount: 2 },
            { weekday: 5, hour: 14, eventCount: 1 },
        ],
    },
    leaders: {
        agents: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3 }],
        models: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2 }],
        sessions: [{ key: 'session-a', label: 'Session A', eventCount: 2 }],
        projects: [{ key: 'project-a', label: 'Project A', eventCount: 2 }],
        workspaces: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3 }],
        engines: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3 }],
    },
    modelTimeline: [
        {
            bucketStartMs: 1_700_000_000_000,
            bucketEndMs: 1_700_086_400_000,
            leaders: [
                {
                    key: 'claude-3.7-sonnet',
                    label: 'Claude 3.7 Sonnet',
                    eventCount: 2,
                    tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 },
                    cost: { reportedUsd: 11, estimatedUsd: 7, currency: 'USD' },
                },
            ],
        },
    ],
    engineTimeline: [
        {
            bucketStartMs: 1_700_000_000_000,
            bucketEndMs: 1_700_086_400_000,
            leaders: [
                {
                    key: 'claude:remote',
                    label: 'Claude Remote',
                    eventCount: 3,
                    tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
                    cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' },
                },
            ],
        },
    ],
    messageStats: {
        sessionCount: 2,
        messageCount: 12,
    },
    costPresentation: {
        mode: 'reported',
        effectiveUsd: 12,
        currency: 'USD',
        source: 'provider_reported',
    },
};

describe('UsageAnalyticsDashboard', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('anchors the refresh indicator to the top controls without inserting a loading row below the actions', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const props = {
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            isRefreshing: true,
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        } satisfies React.ComponentProps<typeof UsageAnalyticsDashboard>;

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, props));
        // The refresh indicator is anchored to the top command-bar controls (D-R2-5),
        // never inserted as a loading row below the actions.
        const overlay = screen.findByTestId('usage-refresh-overlay');
        expect(overlay).toBeTruthy();
        if (!overlay) {
            throw new Error('Expected usage refresh overlay');
        }
        expect(screen.findAllByTestId('usage-refresh-inline-badge')).toHaveLength(0);
    });

    it('renders usage analytics controls and drilldown rows', async () => {
        vi.spyOn(storeHooks, 'useSessionListRenderablesById').mockReturnValue({
            'session-a': {
                id: 'session-a',
                metadata: {
                    summary: { text: 'Session Alpha' },
                },
            } as never,
        });
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '7days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });
        const onPeriodChange = vi.fn();
        const onMetricChange = vi.fn();
        const onFocusChange = vi.fn();
        const onCostModeChange = vi.fn();

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '7days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange,
            onMetricChange,
            onFocusChange,
            onCostModeChange,
        }));

        expect(screen.getTextContent()).toContain('$12');
        expect(screen.findByTestId('usage-filter-cost-mode')).toBeTruthy();
        expect(screen.findByTestId('usage-dashboard-surface')).toBeTruthy();
        expect(screen.findByTestId('usage-insights-section')).toBeTruthy();
        expect(screen.findByTestId('usage-activity-section')).toBeTruthy();
        expect(screen.findByTestId('usage-pivot-section')).toBeTruthy();
        expect(screen.findByTestId('usage-composition-strip')).toBeTruthy();
        // Export/share lives in the footer now (D-R2-2).
        expect(screen.findByTestId('usage-export-copy-summary')).toBeTruthy();
        expect(screen.findByTestId('usage-export-json')).toBeTruthy();
        // Period is a segmented command-bar control (D-R2-5); metric toggles at the chart (D-R2-4).
        expect(screen.findByTestId('usage-filter-period:7days')).toBeTruthy();
        expect(screen.findByTestId('usage-trend-metric:tokens')).toBeTruthy();
        expect(screen.findByTestId('usage-pivot-row-model-claude-3.7-sonnet')).toBeTruthy();

        const costModeDropdown = findUsageFilterDropdown(screen, 'usage-filter-cost-mode');

        screen.pressByTestId('usage-filter-period:year');
        screen.pressByTestId('usage-filter-period:today');
        screen.pressByTestId('usage-trend-metric:cost');
        costModeDropdown.props.onSelect('reported');
        screen.pressByTestId('usage-pivot-row-model-claude-3.7-sonnet');

        expect(onPeriodChange).toHaveBeenCalledWith('year');
        expect(onPeriodChange).toHaveBeenCalledWith('today');
        expect(onMetricChange).toHaveBeenCalledWith('cost');
        expect(onCostModeChange).toHaveBeenCalledWith('reported');
        expect(onFocusChange).toHaveBeenCalledWith(expect.objectContaining({
            dimension: 'model',
            key: 'claude-3.7-sonnet',
        }));
    });

    it('keeps the connected service quota section visible while quota snapshots are still loading', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            connectedServiceQuotaCards: [],
            connectedServiceQuotasRefreshing: true,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.findByTestId('usage-connected-services-quotas-section')).toBeTruthy();
        expect(screen.findByTestId('usage-connected-services-quotas-loading')).toBeTruthy();
    });

    it('hides misleading reported and estimated cost modes when the legacy fallback only exposes a synthesized total', async () => {
        const legacyUsage: UsageDataPoint[] = [
            {
                timestamp: 1_700_000_000,
                tokens: { total: 100, input: 80, output: 20 },
                cost: { total: 1.5, input: 1.0, output: 0.5 },
                reportCount: 1,
                providerId: 'anthropic',
                modelId: 'claude-3.7-sonnet',
                sessionId: 'session-a',
                projectKey: 'project-a',
                workspaceKey: 'workspace-a',
            },
        ];
        const viewModel = buildUsageAnalyticsViewModel(legacyUsage, {
            period: '7days',
            metric: 'cost',
            focus: null,
            costMode: 'auto',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '7days',
                metric: 'cost',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        const costModeDropdown = findUsageFilterDropdown(screen, 'usage-filter-cost-mode');

        expect(screen.findByTestId('usage-filter-cost-mode')).toBeTruthy();
        expect(costModeDropdown.props.items.map((item) => item.id)).toEqual(['auto']);
    });

    it('derives per-leader trends the "What" band consumes from the model timeline', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        // The model timeline now feeds the per-leader sparklines rather than a
        // standalone timeline band (DASHBOARD-VISION Band 5).
        expect(Object.keys(viewModel.leaderTrends.models).length).toBeGreaterThan(0);

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.findByTestId('usage-pivot-section')).toBeTruthy();
        expect(screen.findByTestId('usage-composition-strip')).toBeTruthy();
    });

    it('renders the footer with the Play recap entry and updated caption (recap deck removed from the page — D-R2-2)', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.findByTestId('usage-footer-section')).toBeTruthy();
        expect(screen.findByTestId('usage-recap-play')).toBeTruthy();
        // The ALL-CAPS recap-card deck no longer renders on the page surface.
        expect(screen.findByTestId('usage-recap-model-card')).toBeNull();
        expect(screen.findByTestId('usage-recap-streak-card')).toBeNull();
    });

    it('renders the hero stat row with capitalized Events label and day-unit streak (D-R2-6)', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        // Hero (section 1) carries the oversized total plus the compact stat row.
        // AnimatedNumber exposes the formatted value via accessibilityLabel in both
        // the animated (glyph cells) and minimal (plain text) render paths.
        expect(screen.findByTestId('usage-hero-total')?.props.accessibilityLabel).toBe('135');
        expect(getNodeTextContent(screen.findByTestId('usage-hero-stat-cost'))).toContain('$12');
        expect(getNodeTextContent(screen.findByTestId('usage-hero-stat-sessions'))).toContain('2');
        // Longest streak now carries the day unit (D-R2-6): "2d".
        expect(getNodeTextContent(screen.findByTestId('usage-hero-stat-streak'))).toContain('2d');
        // Events stat uses the capitalized label (D-R2-6).
        expect(getNodeTextContent(screen.findByTestId('usage-hero-stat-events'))).toContain('Events');
    });

    it('uses the selected period label in yearly streak subtitles instead of hardcoded last-30 copy', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: 'year',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: 'year',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.getTextContent()).toContain('Last year');
        expect(screen.getTextContent()).not.toContain('active days in the last 30');
    });

    // Recap-card label-resolution (opencode fallback / unknown-engine handling)
    // is covered at its owner in buildUsageRecapCardModels.test.ts now that the
    // recap deck renders only inside story mode (D-R2-2).

    it('exposes copy and JSON export actions for the filtered usage dashboard', async () => {
        setClipboardStringSafeMock.mockClear();
        modalAlertMock.mockClear();
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'cost',
            focus: null,
            costMode: 'reported',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '30days',
                metric: 'cost',
                focus: null,
                costMode: 'reported',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.findByTestId('usage-export-copy-summary')).toBeTruthy();
        expect(screen.findByTestId('usage-export-json')).toBeTruthy();

        await screen.pressByTestIdAsync('usage-export-copy-summary');

        expect(setClipboardStringSafeMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('usage-export-copy-summary-feedback')).toBeTruthy();
    });

    it('does not render legacy bucket fallback rows when only compatibility bucket data is present', async () => {
        const legacyUsage: UsageDataPoint[] = [
            {
                timestamp: 1_700_000_000,
                tokens: { total: 100, input: 80, output: 20 },
                cost: { total: 1.5, input: 1.0, output: 0.5 },
                reportCount: 1,
                providerId: 'anthropic',
                modelId: 'claude-3.7-sonnet',
                sessionId: 'session-a',
                projectKey: 'project-a',
                workspaceKey: 'workspace-a',
            },
        ];
        const viewModel = buildUsageAnalyticsViewModel(legacyUsage, {
            period: '7days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });
        const bucketOnlyViewModel = {
            ...viewModel,
            breakdowns: {
                agents: [],
                models: [],
                sessions: [],
                projects: [],
                workspaces: [],
                backendModes: [],
                sources: [],
                buckets: viewModel.breakdowns.buckets,
                weeks: [],
            },
        };

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel: bucketOnlyViewModel,
            filters: {
                period: '7days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.findAllByTestId('usage-breakdown-row-bucket-input')).toHaveLength(0);
        expect(screen.findAllByTestId('usage-breakdown-row-bucket-output')).toHaveLength(0);
    });

    it('shows the empty state when only unsupported source breakdowns are present', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '7days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });
        const sourceOnlyViewModel = {
            ...viewModel,
            trend: [],
            breakdowns: {
                agents: [],
                models: [],
                sessions: [],
                projects: [],
                workspaces: [],
                backendModes: [],
                sources: viewModel.breakdowns.sources,
                buckets: viewModel.breakdowns.buckets,
                weeks: [],
            },
        };

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel: sourceOnlyViewModel,
            filters: {
                period: '7days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        // Sources are now a first-class pivot dimension (E-1), so the What band
        // renders the pivot; the default (Models) lens is empty here, so the
        // source label never leaks until the Sources segment is selected.
        expect(screen.findByTestId('usage-dashboard-surface')).toBeTruthy();
        expect(screen.findByTestId('usage-pivot-section')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('Claude SDK');
    });

    it('formats overview cost using the response currency', async () => {
        const eurResponse: UsageAnalyticsQueryResponse = {
            ...response,
            totals: {
                ...response.totals,
                cost: {
                    ...response.totals.cost,
                    currency: 'EUR',
                },
            },
            series: response.series?.map((bucket) => ({
                ...bucket,
                cost: {
                    ...bucket.cost,
                    currency: 'EUR',
                },
            })),
            breakdowns: {
                ...response.breakdowns,
                agent: response.breakdowns?.agent?.map((entry) => ({
                    ...entry,
                    cost: {
                        ...entry.cost,
                        currency: 'EUR',
                    },
                })),
            },
            costPresentation: {
                mode: response.costPresentation?.mode ?? 'reported',
                effectiveUsd: response.costPresentation?.effectiveUsd ?? 12,
                currency: 'EUR',
                source: response.costPresentation?.source ?? 'provider_reported',
            },
        };
        const viewModel = buildUsageAnalyticsViewModel(eurResponse, {
            period: '7days',
            metric: 'cost',
            focus: null,
            costMode: 'reported',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '7days',
                metric: 'cost',
                focus: null,
                costMode: 'reported',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.getTextContent()).toContain('€');
    });
});
