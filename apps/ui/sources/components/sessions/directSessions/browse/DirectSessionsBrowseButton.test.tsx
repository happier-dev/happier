import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const directSessionsFeature = vi.hoisted(() => ({ enabled: true }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

// The server feature decision is the gate this entry point reads; its evaluation is owned elsewhere.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => (
        featureId === 'sessions.direct'
            ? {
                state: directSessionsFeature.enabled ? 'enabled' : 'disabled',
                blockerCode: directSessionsFeature.enabled ? 'none' : 'feature_disabled',
                blockedBy: directSessionsFeature.enabled ? null : 'local_policy',
                diagnostics: [],
                evaluatedAt: 0,
                featureId: 'sessions.direct',
                scope: { scopeKind: 'main_selection' },
            }
            : null
    ),
}));

describe('DirectSessionsBrowseButton', () => {
    beforeEach(() => {
        routerPush.mockReset();
        directSessionsFeature.enabled = true;
    });

    it('opens provider-session browsing from a folder icon when direct sessions are enabled', async () => {
        const { DirectSessionsBrowseButton } = await import('./DirectSessionsBrowseButton');
        const screen = await renderScreen(
            <DirectSessionsBrowseButton testID="sidebar-direct-browse-button" buttonSize={32} iconSize={20} />,
        );

        const button = screen.findByTestId('sidebar-direct-browse-button');
        expect(button?.props.accessibilityRole).toBe('button');
        expect(button?.props.accessibilityLabel).toBe('directSessions.browseOpenExisting');
        expect(screen.root.findAll((node) => node.props?.name === 'folder-open').length).toBeGreaterThan(0);

        await React.act(async () => { button?.props.onHoverIn?.(); });
        const tooltips = screen.findAllByType(DeferredAnchoredTooltip);
        expect(tooltips).toHaveLength(1);
        expect(tooltips[0]!.props.label).toBe(button?.props.accessibilityLabel);
        await React.act(async () => { button?.props.onHoverOut?.(); });
        expect(screen.findAllByType(DeferredAnchoredTooltip)).toHaveLength(0);

        await screen.pressByTestIdAsync('sidebar-direct-browse-button');
        expect(routerPush).toHaveBeenCalledWith('/direct/browse');
    });

    it('renders nothing when direct sessions are disabled', async () => {
        directSessionsFeature.enabled = false;
        const { DirectSessionsBrowseButton } = await import('./DirectSessionsBrowseButton');
        const screen = await renderScreen(
            <DirectSessionsBrowseButton testID="sidebar-direct-browse-button" buttonSize={32} iconSize={20} />,
        );

        expect(screen.findAllHostsByTestId('sidebar-direct-browse-button')).toHaveLength(0);
    });
});
