import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, renderSettingsView } from '@/dev/testkit';
import { SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import type { SettingsPageNode } from '@/components/settings/catalog/types';
import { buildUsageAnalyticsViewModel, type UsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const routerPushMock = vi.hoisted(() => vi.fn());
type UsageBannerHookState = {
    viewModel: UsageAnalyticsViewModel | null;
    isLoading: boolean;
    errorMessage: string | null;
};
const usageSummaryState = vi.hoisted<UsageBannerHookState>(() => ({
    viewModel: null,
    isLoading: false,
    errorMessage: null,
}));

const DAY = 86_400_000;

function bannerResponse(hasData: boolean): UsageAnalyticsQueryResponse {
    const now = Date.now();
    const isoDay = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10);
    if (!hasData) {
        return {
            v: 1,
            totals: { eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none', billingContext: 'api_usage' } },
            series: [],
            breakdowns: { model: [] },
            insights: { activeDays: 0, longestStreakDays: 0, sessionsUsed: 0, messagesUsed: 0, modelsTried: 0, favoriteModel: undefined, favoriteModelChangeCount: 0, busiestMonth: undefined, busiestDay: undefined, busiestHour: undefined },
            activity: { calendarDays: [], weekdayHourBuckets: [] },
            leaders: { models: [] },
            messageStats: { sessionCount: 0, messageCount: 0 },
        };
    }
    return {
        v: 1,
        totals: { eventCount: 5, tokens: { input: 900_000, output: 300_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 0, total: 2_400_000 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' } },
        series: [{ bucketStartMs: now - 5 * DAY, bucketEndMs: now - 5 * DAY + DAY, eventCount: 3, tokens: { input: 700_000, output: 240_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 0, total: 990_000 }, cost: { reportedUsd: 8, estimatedUsd: 5, currency: 'USD' } }],
        breakdowns: { model: [{ key: 'gpt-5', label: 'GPT-5', eventCount: 3, tokens: { input: 700_000, output: 240_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 0, total: 990_000 }, cost: { reportedUsd: 8, estimatedUsd: 5, currency: 'USD' } }] },
        insights: { activeDays: 8, longestStreakDays: 6, sessionsUsed: 3, messagesUsed: 5, modelsTried: 2, favoriteModel: { key: 'gpt-5', label: 'GPT-5' }, favoriteModelChangeCount: 1, busiestMonth: undefined, busiestDay: undefined, busiestHour: { key: '14', label: 'Fri · 2 PM' } },
        activity: { calendarDays: [{ date: isoDay(0), eventCount: 2 }, { date: isoDay(1), eventCount: 3 }], weekdayHourBuckets: [{ weekday: 5, hour: 14, eventCount: 5 }] },
        leaders: { models: [{ key: 'gpt-5', label: 'GPT-5', eventCount: 3 }] },
        messageStats: { sessionCount: 3, messageCount: 5 },
    };
}

function createViewModelFixture(hasData = true): UsageAnalyticsViewModel {
    return buildUsageAnalyticsViewModel(bannerResponse(hasData), { period: 'year', metric: 'tokens', focus: null, costMode: 'auto' });
}

function findCatalogNode(
    nodes: readonly SettingsPageNode[],
    id: string,
): SettingsPageNode | null {
    for (const node of nodes) {
        if (node.id === id) return node;
        const match = node.children ? findCatalogNode(node.children, id) : null;
        if (match) return match;
    }
    return null;
}

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'useProfiles') return false;
                if (key === 'sessionUseTmux') return false;
                return null;
            },
            useLocalSetting: () => null,
            useLocalSettingMutable: (key: string) => {
                if (key === 'devModeEnabled') return [true, vi.fn()] as const;
                return [null, vi.fn()] as const;
            },
            useEntitlement: () => false,
            useProfile: () => ({
                id: 'prof_1',
                firstName: '',
                connectedServices: [],
            }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: routerPushMock,
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriDesktopState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'usage.reporting',
}));

vi.mock('@/components/settings/usage/useUsageBannerModel', () => ({
    useUsageBannerModel: () => usageSummaryState,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ discoverable: false, blockedBy: null }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        presentPaywall: vi.fn(async () => ({ success: true })),
        refreshProfile: vi.fn(async () => {}),
    },
}));

vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/utils/system/requestReview', () => ({
    canRequestReview: vi.fn(async () => false),
    requestReview: vi.fn(async () => {}),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => action(),
}));

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: (action: () => void) => action(),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (_cb: () => void) => {},
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('Item', props, props.children),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 'test-token', secret: 'test-secret' }, isAuthenticated: true }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', props),
}));


vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: (props: Record<string, unknown>) => React.createElement('MachineCliGlyphs', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown>) => React.createElement('Text', props),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'gemini'],
    DEFAULT_AGENT_ID: 'agent_default',
    getAgentCore: () => ({ uiConnectedService: { serviceId: 'anthropic', labelKey: 'agentInput.agent.claude', connectRoute: null } }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    resolveAgentIdFromConnectedServiceId: () => null,
}));

describe('SettingsView usage banner', () => {
    it('does not render the usage banner when there is no usage data', async () => {
        usageSummaryState.viewModel = createViewModelFixture(false);
        usageSummaryState.errorMessage = null;
        usageSummaryState.isLoading = false;
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(React.createElement(SettingsView));

        expect(screen.findAllByTestId('settings-usage-summary-strip')).toHaveLength(0);
        expect(screen.findAllByTestId('usage-banner-stat-lifetime')).toHaveLength(0);
    });

    it('shows a skeleton loading state instead of an empty state while loading', async () => {
        const { SettingsUsageSummaryStrip } = await import('@/components/settings/usage/SettingsUsageSummaryStrip');

        const screen = await renderScreen(
            <SettingsUsageSummaryStrip viewModel={null} isLoading />,
        );

        expect(screen.findByTestId('settings-usage-summary-loading')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('usage.noData');
    });

    it('does not render a legacy per-service shortcut beside the canonical Connected Accounts catalog', async () => {
        usageSummaryState.viewModel = null;
        usageSummaryState.errorMessage = null;
        usageSummaryState.isLoading = false;

        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(React.createElement(SettingsView));

        expect(screen.findGroup('settings.connectedAccounts')).toBeNull();
        expect(findCatalogNode(SETTINGS_PAGE_CATALOG, 'connectedServices')).toMatchObject({
            route: '/settings/connected-services',
        });
    });

    it('renders the usage banner above the account shortcuts and opens the usage page on press', async () => {
        usageSummaryState.viewModel = createViewModelFixture();
        usageSummaryState.errorMessage = null;
        usageSummaryState.isLoading = false;
        routerPushMock.mockReset();
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(React.createElement(SettingsView));

        const orderedTestIds = screen
            .findAll((node) => typeof node.props?.testID === 'string')
            .map((node) => String(node.props.testID))
            .filter((testID) => testID === 'settings-usage-summary-strip' || testID === 'settings-add-your-phone-shortcut');

        expect(orderedTestIds[0]).toBe('settings-usage-summary-strip');
        expect(orderedTestIds.indexOf('settings-add-your-phone-shortcut')).toBeGreaterThan(0);

        expect(screen.findByTestId('usage-banner-stat-lifetime')).toBeTruthy();
        expect(screen.findByTestId('usage-banner-heatmap')).toBeTruthy();
        expect(screen.findByTestId('usage-banner-most-used')).toBeTruthy();

        screen.pressByTestId('settings-usage-summary-open-stats');
        expect(routerPushMock).toHaveBeenNthCalledWith(1, {
            pathname: '/settings/usage',
            params: {
                period: 'year',
                metric: 'tokens',
            },
        });
    });

    it('keeps the banner group visible when the query fails', async () => {
        usageSummaryState.viewModel = null;
        usageSummaryState.errorMessage = 'Usage banner failed';
        usageSummaryState.isLoading = false;

        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(React.createElement(SettingsView));

        expect(screen.findByTestId('settings-usage-summary-strip')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Usage banner failed');
    });
});
