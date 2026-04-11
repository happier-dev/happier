import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, renderSettingsView } from '@/dev/testkit';
import type { UsageAnalyticsSummaryViewModel } from '@/sync/api/account/usageAnalytics';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const routerPushMock = vi.hoisted(() => vi.fn());
type UsageSummaryHookState = {
    summary: UsageAnalyticsSummaryViewModel | null;
    isLoading: boolean;
    errorMessage: string | null;
};
const usageSummaryState = vi.hoisted<UsageSummaryHookState>(() => ({
    summary: null,
    isLoading: false,
    errorMessage: null,
}));

function createSummaryFixture(): UsageAnalyticsSummaryViewModel {
    return {
        activeDays: 8,
        currentStreakDays: 5,
        totalTokens: 2_400_000,
        totalCost: 1_500,
        currency: 'USD',
        weekTokens: 2_400_000,
        weekCost: 1_500,
        topModel: { label: 'GPT-5', totalTokens: 1_300_000, totalCost: 800, dimension: 'model', key: 'gpt-5', reportCount: 9, firstSeenAt: 0, lastSeenAt: 0, contextWindowTokens: null, contextUsedTokens: null },
        topEngine: { label: 'OpenCode', totalTokens: 1_200_000, totalCost: 700, dimension: 'backendMode', key: 'opencode', reportCount: 7, firstSeenAt: 0, lastSeenAt: 0, contextWindowTokens: null, contextUsedTokens: null },
        busiestWindowLabel: 'Fri · 2 PM',
        recentActivity: [
            { timestamp: 1, active: true, tokens: 10, cost: 1 },
            { timestamp: 2, active: true, tokens: 20, cost: 2 },
            { timestamp: 3, active: false, tokens: 0, cost: 0 },
            { timestamp: 4, active: true, tokens: 40, cost: 4 },
            { timestamp: 5, active: true, tokens: 80, cost: 8 },
            { timestamp: 6, active: true, tokens: 160, cost: 16 },
            { timestamp: 7, active: true, tokens: 320, cost: 32 },
            { timestamp: 8, active: true, tokens: 640, cost: 64 },
            { timestamp: 9, active: true, tokens: 1280, cost: 128 },
            { timestamp: 10, active: true, tokens: 2560, cost: 256 },
            { timestamp: 11, active: true, tokens: 5120, cost: 512 },
            { timestamp: 12, active: true, tokens: 10240, cost: 1024 },
            { timestamp: 13, active: true, tokens: 20480, cost: 2048 },
            { timestamp: 14, active: true, tokens: 40960, cost: 4096 },
        ],
        hasData: true,
    };
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

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'usage.reporting',
}));

vi.mock('@/components/settings/usage/useUsageAnalyticsSummary', () => ({
    useUsageAnalyticsSummary: () => usageSummaryState,
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

vi.mock('@/components/ui/icons/DependabotIcon', () => ({
    DependabotIcon: (props: Record<string, unknown>) => React.createElement('DependabotIcon', props),
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

vi.mock('@/sync/api/account/apiVendorTokens', () => ({
    disconnectVendorToken: vi.fn(async () => {}),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'gemini'],
    DEFAULT_AGENT_ID: 'agent_default',
    getAgentCore: () => ({ connectedService: { name: 'Anthropic', connectRoute: null } }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    resolveAgentIdFromConnectedServiceId: () => null,
}));

describe('SettingsView usage summary strip', () => {
    it('does not render the usage summary strip when the summary has no data', async () => {
        usageSummaryState.summary = {
            ...createSummaryFixture(),
            activeDays: 0,
            currentStreakDays: 0,
            totalTokens: 0,
            totalCost: 0,
            weekTokens: 0,
            weekCost: 0,
            topModel: null,
            topEngine: null,
            busiestWindowLabel: null,
            recentActivity: [],
            hasData: false,
        };
        usageSummaryState.errorMessage = null;
        usageSummaryState.isLoading = false;
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(React.createElement(SettingsView));

        expect(screen.findAllByTestId('settings-usage-summary-strip')).toHaveLength(0);
        expect(screen.findAllByTestId('settings-usage-summary-streak-card')).toHaveLength(0);
    });

    it('shows a loading state instead of an empty state while the summary is still loading', async () => {
        usageSummaryState.summary = null;
        usageSummaryState.errorMessage = null;
        usageSummaryState.isLoading = true;
        const { SettingsUsageSummaryStrip } = await import('@/components/settings/usage/SettingsUsageSummaryStrip');

        const screen = await renderScreen(
            <SettingsUsageSummaryStrip
                summary={null}
                isLoading
            />,
        );

        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('usage.noData');
    });

    it('renders the usage summary strip above the account shortcuts', async () => {
        usageSummaryState.summary = createSummaryFixture();
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

        expect(screen.findByTestId('settings-usage-summary-streak-card')).toBeTruthy();
        expect(screen.findByTestId('settings-usage-summary-week-card')).toBeTruthy();
        expect(screen.findByTestId('settings-usage-summary-model-card')).toBeTruthy();
        expect(screen.findByTestId('settings-usage-summary-engine-card')).toBeTruthy();

        screen.pressByTestId('settings-usage-summary-streak-card');
        screen.pressByTestId('settings-usage-summary-week-card');
        screen.pressByTestId('settings-usage-summary-model-card');
        screen.pressByTestId('settings-usage-summary-engine-card');

        expect(routerPushMock).toHaveBeenNthCalledWith(1, {
            pathname: '/(app)/settings/usage',
            params: {
                period: 'year',
                metric: 'tokens',
            },
        });
        expect(routerPushMock).toHaveBeenNthCalledWith(2, {
            pathname: '/(app)/settings/usage',
            params: {
                period: '7days',
                metric: 'tokens',
            },
        });
        expect(routerPushMock).toHaveBeenNthCalledWith(3, {
            pathname: '/(app)/settings/usage',
            params: {
                period: '30days',
                metric: 'tokens',
                focusDimension: 'model',
                focusKey: 'gpt-5',
                focusLabel: 'GPT-5',
            },
        });
        expect(routerPushMock).toHaveBeenNthCalledWith(4, {
            pathname: '/(app)/settings/usage',
            params: {
                period: '30days',
                metric: 'tokens',
                focusDimension: 'backendMode',
                focusKey: 'opencode',
                focusLabel: 'OpenCode',
            },
        });
    });

    it('keeps the summary group visible when the summary query fails', async () => {
        usageSummaryState.summary = null;
        usageSummaryState.errorMessage = 'Usage summary failed';
        usageSummaryState.isLoading = false;

        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(React.createElement(SettingsView));

        expect(screen.findByTestId('settings-usage-summary-strip')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Usage summary failed');
    });
});
