import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { setPreferredLanguageFromSettings } from '@/text/i18n';

let restorePopoverGlobals: (() => void) | null = null;

type AuthState = {
    credentials: { token: string } | null;
};

type UsageApiState = {
    getUsageForPeriod: ReturnType<typeof vi.fn>;
    calculateTotals: ReturnType<typeof vi.fn>;
};

const authState: AuthState = {
    credentials: null,
};

const localizationState = {
    locales: [{ languageTag: 'en-US' }],
};

const usageApiState: UsageApiState = {
    getUsageForPeriod: vi.fn(),
    calculateTotals: vi.fn(() => ({
        totalTokens: 0,
        totalCost: 0,
        tokensByModel: {},
        costByModel: {},
    })),
};

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Exercise the real settings/menu interaction through the canonical web SDK boundary.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-localization', () => ({
    getLocales: () => localizationState.locales,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: {
                    blue: 'usage-accent-blue',
                    orange: 'usage-accent-orange',
                },
                button: {
                    primary: {
                        background: 'usage-button-background',
                        tint: 'usage-button-tint',
                        disabled: 'usage-button-disabled',
                    },
                },
            },
        },
    });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/sync/api/account/apiUsage', () => ({
    getUsageForPeriod: (...args: unknown[]) => usageApiState.getUsageForPeriod(...args),
    calculateTotals: (...args: unknown[]) => usageApiState.calculateTotals(...args),
}));

function findPressableByText(
    screen: Parameters<typeof renderScreen>[0] extends never ? never : Awaited<ReturnType<typeof renderScreen>>,
    text: string,
) {
    return screen.findAll((node) => (
        typeof node.type === 'string' &&
        String(node.type) === 'Pressable' &&
        node.findAll((child) => typeof child.type === 'string' && String(child.type) === 'Text' && child.props?.children === text).length > 0
    ))[0];
}

function findTextNodeByContent(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    text: string,
) {
    return screen.findAll((node) => typeof node.type === 'string' && String(node.type) === 'Text' && node.props?.children === text)[0] ?? null;
}

describe('UsagePanel settings behavior', () => {
    beforeEach(() => {
        authState.credentials = null;
        localizationState.locales = [{ languageTag: 'en-US' }];
        usageApiState.getUsageForPeriod.mockReset();
        usageApiState.calculateTotals.mockReset();
        usageApiState.calculateTotals.mockReturnValue({
            totalTokens: 0,
            totalCost: 0,
            tokensByModel: {},
            costByModel: {},
        });
        getStorage().setState((state) => ({
            settings: {
                ...(state.settings ?? {}),
                preferredLanguage: null,
            },
        }));
        setPreferredLanguageFromSettings(null);
    });

    afterEach(() => {
        standardCleanup();
        restorePopoverGlobals?.();
        restorePopoverGlobals = null;
        vi.unstubAllGlobals();
        vi.useRealTimers();
        setPreferredLanguageFromSettings(null);
    });

    it('lets the Usage screen select both short and weekly provider rings', async () => {
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        // Serve the real feature resolver through its HTTP boundary, with quotas supported by the relay.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(createRootLayoutFeaturesResponse()), {
            status: 200, headers: { 'content-type': 'application/json' },
        })));
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        getStorage().setState((state) => ({ settings: {
            ...state.settings, experiments: true, featureToggles: { connectedServices: true, 'connectedServices.quotas': true },
            sessionProviderUsageGaugeWindowMode: 'most_constrained', sessionProviderUsageGaugeWindowModes: null,
        } }));
        const { default: UsageSettingsScreen } = await import('@/app/(app)/settings/usage');
        vi.useFakeTimers();
        restorePopoverGlobals = withPopoverWebGlobals();
        const screen = await renderScreen(<UsageSettingsScreen />);
        const pressWindow = async (id: string) => {
            act(() => screen.pressByTestId(id));
            await flushHookEffects({ runOnlyPendingTimers: true });
        };
        await pressWindow('settings-session-providerUsageGauge-window-trigger');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const checked = (id: string) => screen.findByTestId(`settings-session-providerUsageGauge-window:${id}`)
            ?.findAllByType(Icon).some((icon) => icon.props.name === 'check-square');
        expect(checked('automatic')).toBe(true);
        await pressWindow('settings-session-providerUsageGauge-window:session');
        await pressWindow('settings-session-providerUsageGauge-window:weekly');
        expect(checked('automatic')).toBe(false);
        expect(checked('session')).toBe(true);
        expect(checked('weekly')).toBe(true);
        await pressWindow('settings-session-providerUsageGauge-window:most_constrained');
        expect(checked('most_constrained')).toBe(true);
        expect(checked('session')).toBe(false);
        expect(checked('weekly')).toBe(false);
    });

    it('shows a translated unauthenticated error', async () => {
        getStorage().setState((state) => ({
            settings: {
                ...(state.settings ?? {}),
                preferredLanguage: 'es',
            },
        }));
        setPreferredLanguageFromSettings('es');

        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(<UsagePanel />);

        expect(screen.getTextContent()).toContain('Necesitas iniciar sesión para ver el uso.');
    });

    it('shows a translated generic load error when the request fails unexpectedly', async () => {
        setPreferredLanguageFromSettings('es');
        authState.credentials = { token: 'token-1' };
        usageApiState.getUsageForPeriod.mockRejectedValue(new Error('network down'));

        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(<UsagePanel />);
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('No se pudo cargar el uso.');
    });

    it('passes the device locale through to usage date formatting when no app language override is set', async () => {
        authState.credentials = { token: 'token-1' };
        localizationState.locales = [{ languageTag: 'fr-CH' }];
        usageApiState.getUsageForPeriod.mockResolvedValue({
            usage: [
                {
                    timestamp: Math.floor(new Date('2024-01-02T12:00:00Z').getTime() / 1000),
                    tokens: { codex: 2500 },
                    cost: { codex: 1.25 },
                    reportCount: 1,
                },
            ],
        });
        const { UsagePanel } = await import('./UsagePanel');
        const { UsageChart } = await import('./UsageChart');
        const screen = await renderScreen(<UsagePanel />);
        await flushHookEffects();

        expect(screen.root.findByType(UsageChart).props.locale).toBe('fr-CH');
    });

    it('uses theme token colors for the active period control', async () => {
        authState.credentials = { token: 'token-1' };
        usageApiState.getUsageForPeriod.mockResolvedValue({ usage: [] });

        const { UsagePanel } = await import('./UsagePanel');
        const screen = await renderScreen(<UsagePanel />);
        await flushHookEffects();

        const activePeriodButton = findPressableByText(screen, 'Last 7 days');
        const activePeriodText = findTextNodeByContent(screen, 'Last 7 days');

        expect(flattenTestStyle(activePeriodButton?.props?.style)).toMatchObject({
            backgroundColor: 'usage-accent-blue',
        });
        expect(flattenTestStyle(activePeriodText?.props?.style)).toMatchObject({
            color: 'usage-button-tint',
        });
    });
});
