import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { t } from '@/text';
import { resolveSessionViewHeaderProps } from './resolveSessionViewHeaderProps';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

describe('resolveSessionViewHeaderProps workspace sync on Android', () => {
    // DESIGN.md "Touch targets" + owner ruling 2026-10-25: the hit area reaches Android's 48dp where the
    // space allows and never grows the drawn square or the row gap. Header actions sit 6px apart, so a
    // finger's reach splits that gap with each neighbour instead of overlapping it.
    it('gives the conflict badge a 48dp Android height and splits the action gap with its neighbours', async () => {
        const session = createSessionFixture({ id: 'workspace-conflict-header-android' });
        const result = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/workspace-conflict-header-android/info',
            sessionRunsHref: '/session/workspace-conflict-header-android/runs',
            sessionAutomationsHref: '/session/workspace-conflict-header-android/automations',
            paneScopeId: 'pane-1',
            windowWidth: 390,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            workspaceSyncAttention: { conflictedLinkCount: 2, unknownLinkCount: 0 },
            onOpenWorkspaceSyncConflicts: () => {},
        });
        const row = result.rightElement as React.ReactElement<{ children?: React.ReactNode; style?: { gap?: number } }>;
        const rowGap = row.props.style?.gap ?? 0;
        const conflictButton = React.Children.toArray(
            row.props.children,
        ).find((child) => React.isValidElement<{ accessibilityLabel?: string }>(child)
            && child.props.accessibilityLabel === t('workspaceSync.attention.conflictedLinks', { count: 2 }));

        expect(conflictButton).toBeDefined();
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
            {conflictButton}
        </HappierUiPlatformProvider>);
        try {
            const control = screen.findAll(node => typeof node.type === 'string'
                && node.props.accessibilityLabel === t('workspaceSync.attention.conflictedLinks', { count: 2 })
                && typeof node.props.onPress === 'function').at(-1);
            if (!control) throw new Error('Missing mounted workspace conflict control');
            const hitArea = readHitArea(control);
            expect(hitArea.drawn).toEqual({ width: 32, height: 32 });
            expect(hitArea.height).toBe(48);
            // Every direct header action is this same owner, so the badge's neighbours reach as it does.
            expect(rowGap).toBeGreaterThan(0);
            expect(hitAreaOverlap(hitArea, hitArea, { axis: 'horizontal', gap: rowGap })).toBe(0);
            expect(hitArea.width).toBe(32 + rowGap);
            expect(hitArea.width).toBeGreaterThanOrEqual(24);
        } finally {
            await screen.unmount();
        }
    });

    it('announces unavailable and mixed link facts without counting them as conflicts', async () => {
        const session = createSessionFixture({ id: 'workspace-attention-header-android' });
        const base = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/workspace-attention-header-android/info',
            sessionRunsHref: '/session/workspace-attention-header-android/runs',
            sessionAutomationsHref: '/session/workspace-attention-header-android/automations',
            paneScopeId: 'pane-1',
            windowWidth: 390,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            onOpenWorkspaceSyncConflicts: () => {},
        } satisfies Parameters<typeof resolveSessionViewHeaderProps>[0];
        const labels = (attention: Readonly<{ conflictedLinkCount: number; unknownLinkCount: number }>) => {
            const result = resolveSessionViewHeaderProps({ ...base, workspaceSyncAttention: attention });
            return React.Children.toArray(
                (result.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
            ).filter((child) => React.isValidElement<{ accessibilityLabel?: string }>(child))
                .map((child) => child.props.accessibilityLabel)
                .filter((label): label is string => typeof label === 'string');
        };
        expect(labels({ conflictedLinkCount: 0, unknownLinkCount: 1 })).toContain(
            t('workspaceSync.attention.unavailableLinks', { count: 1 }),
        );
        expect(labels({ conflictedLinkCount: 1, unknownLinkCount: 1 })).toContain(
            `${t('workspaceSync.attention.conflictedLinks', { count: 1 })} · ${t('workspaceSync.attention.unavailableLinks', { count: 1 })}`,
        );
    });
});
