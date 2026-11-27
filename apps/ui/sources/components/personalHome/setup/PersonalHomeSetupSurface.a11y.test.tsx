import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

import { PersonalHomeSetupSurface } from './PersonalHomeSetupSurface';

describe('PersonalHomeSetupSurface accessibility', () => {
    it('includes each existing-runtime consequence in the accessible action description', async () => {
        const screen = await renderScreen(
            <PersonalHomeSetupSurface
                snapshot={{
                    shouldGateShell: true,
                    homeReady: false,
                    daemonReady: false,
                    phase: 'blocked',
                    daemonState: 'not-started',
                    action: 'choose-existing-runtime',
                    detail: { message: 'An existing Home runtime was found.', retryable: false },
                }}
                onUseExisting={() => {}}
                onUseAnotherHome={() => {}}
            />,
        );

        expect(screen.findByTestId('personal-home-use-existing')?.props).toMatchObject({
            accessibilityLabel: t('personalHome.bootstrap.useExisting'),
            accessibilityHint: t('personalHome.bootstrap.useExistingDetail'),
        });
        expect(screen.findByTestId('personal-home-use-another')?.props).toMatchObject({
            accessibilityLabel: t('personalHome.bootstrap.useAnother'),
            accessibilityHint: t('personalHome.bootstrap.useAnotherDetail'),
        });
    });

    it('says a failure once, as an alert, with no competing polite status', async () => {
        const screen = await renderScreen(
            <PersonalHomeSetupSurface
                snapshot={{
                    shouldGateShell: true,
                    homeReady: false,
                    daemonReady: false,
                    phase: 'blocked',
                    daemonState: 'not-started',
                    action: 'retry',
                    detail: { message: 'Needs attention', retryable: true },
                }}
                onRetry={() => {}}
                onOpenDetails={() => {}}
            />,
        );
        // The failure is said once, as an alert; there is no second live sentence repeating it.
        const phase = screen.findByTestId('personal-home-bootstrap-phase');
        expect(phase?.props.accessibilityLiveRegion).toBe('assertive');
        expect(phase?.props.accessibilityRole).toBe('alert');
        expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'polite')).toHaveLength(0);
        expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'assertive')).toHaveLength(1);
        expect(screen.findByTestId('personal-home-bootstrap-retry')?.props.accessibilityRole).toBe('button');
        expect(screen.findByTestId('personal-home-bootstrap-details')?.props.accessibilityRole).toBe('button');
    });

    it('keeps the Loading planet\'s mark decorative while the concise status owns announcements', async () => {
        const screen = await renderScreen(
            <PersonalHomeSetupSurface
                snapshot={{
                    shouldGateShell: true,
                    homeReady: false,
                    daemonReady: false,
                    phase: 'ensuring-home',
                    daemonState: 'not-started',
                    action: 'none',
                }}
            />,
        );

        const mark = screen.findByTestId('personal-home-bootstrap-mark');
        expect(mark?.props.accessible).toBe(false);
        expect(mark?.props.accessibilityElementsHidden).toBe(true);
        expect(mark?.props.accessibilityLiveRegion).toBeUndefined();
        expect(screen.findByTestId('personal-home-bootstrap-phase')?.props.accessibilityLiveRegion).toBe('polite');
    });

    it('focuses the first recovery action once when setup becomes blocked', async () => {
        const retryFocus = vi.fn();
        const preparing = {
            shouldGateShell: true,
            homeReady: false,
            daemonReady: false,
            phase: 'ensuring-home' as const,
            daemonState: 'not-started' as const,
            action: 'none' as const,
        };
        const blocked = {
            ...preparing,
            phase: 'blocked' as const,
            action: 'retry' as const,
            detail: { message: 'Technical detail shown only in diagnostics', retryable: true },
        };
        const render = (snapshot: typeof preparing | typeof blocked) => (
            <PersonalHomeSetupSurface snapshot={snapshot} onRetry={() => {}} />
        );
        const screen = await renderScreen(render(preparing), {
            createNodeMock: (element) => (
                (element.props as Readonly<{ testID?: string }>).testID === 'personal-home-bootstrap-retry'
                    ? { focus: retryFocus }
                    : null
            ),
        });

        await act(async () => {
            screen.tree.update(render(blocked));
        });
        expect(retryFocus).toHaveBeenCalledTimes(1);

        await act(async () => {
            screen.tree.update(render(blocked));
        });
        expect(retryFocus).toHaveBeenCalledTimes(1);
    });
});
