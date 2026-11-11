import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { useProjectRouteHeaderOptions } from './useProjectRouteHeaderOptions';

const windowSize = vi.hoisted(() => ({ width: 1440, height: 900 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const getWindowDimensions = () => ({ ...windowSize, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({
        // Responsive presentation reads Dimensions directly; both OS APIs describe the same window.
        Dimensions: { get: getWindowDimensions },
        useWindowDimensions: getWindowDimensions,
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/hooks/server/useFeatureDecision', () => ({ useFeatureDecision: () => ({ state: 'enabled' }) }));

function Probe(props: { onOptions: (options: Readonly<Record<string, unknown>>) => void; onOpenBrowser?: () => void }) {
    const options = useProjectRouteHeaderOptions({
        workspaceRef: null, testIdPrefix: 'project-header', showWorktreesButton: true,
        onToggleWorktrees: () => {}, onOpenTerminal: () => {}, onOpenBrowser: props.onOpenBrowser ?? (() => {}),
    });
    props.onOptions(options);
    return null;
}

function PresentedProjectBar(props: { pageKind: string }) {
    // The bottom-chrome host's own publication, as it reports a presented detail bar.
    const { usePublishPresentedBottomChrome } = presentedBottomChromeModule;
    usePublishPresentedBottomChrome({ kind: 'detail', pageKind: props.pageKind });
    return null;
}

let presentedBottomChromeModule: typeof import('@/components/navigation/mobile/chrome/presentedBottomChrome');

describe('Project route header options', () => {
    it('where the Project cockpit bar is presented, leaves Browser and Terminal to the bar and keeps the worktrees toggle (owner 11-10)', async () => {
        presentedBottomChromeModule = await import('@/components/navigation/mobile/chrome/presentedBottomChrome');
        windowSize.width = 390;
        windowSize.height = 844;
        let seen: Readonly<Record<string, unknown>> | null = null;
        const screen = await renderScreen(<><PresentedProjectBar pageKind="project" />
            <Probe onOptions={(options) => { seen = options; }} /></>);
        try {
            const HeaderRight = seen!.headerRight as () => React.ReactNode;
            const bar = await renderScreen(<>{HeaderRight()}</>);
            try {
                expect(bar.findAllHostsByTestId('project-header-open-worktrees')).toHaveLength(1);
                expect(bar.findAllHostsByTestId('project-header-open-terminal')).toHaveLength(0);
                expect(bar.findAllHostsByTestId('project-header-open-browser')).toHaveLength(0);
            } finally {
                await bar.unmount();
            }
        } finally {
            await screen.unmount();
        }
    });

    it.each([
        ['phone', 390, 844, true],
        ['desktop', 1440, 900, false],
    ] as const)('on a %s publishes Back, branch and terminal only for the native bar', async (_label, width, height, published) => {
        windowSize.width = width;
        windowSize.height = height;
        let seen: Readonly<Record<string, unknown>> | null = null;
        const screen = await renderScreen(<Probe onOptions={(options) => { seen = options; }} />);
        try {
            // Desktop's Project header owns the checkout (branch) and Terminal in its own tab bar (DA R-12);
            // lending the phone bar's controls would draw a second Back/branch/terminal row beside a page title.
            expect(typeof seen!.headerLeft === 'function').toBe(published);
            expect(typeof seen!.headerRight === 'function').toBe(published);
        } finally {
            await screen.unmount();
        }
    });

    it('on a phone carries the browser launcher beside Terminal, since the File page has no strip to hold it (lab FV1p)', async () => {
        windowSize.width = 390;
        windowSize.height = 844;
        const onOpenBrowser = vi.fn();
        let seen: Readonly<Record<string, unknown>> | null = null;
        const screen = await renderScreen(<Probe onOptions={(options) => { seen = options; }} onOpenBrowser={onOpenBrowser} />);
        try {
            const HeaderRight = seen!.headerRight as () => React.ReactNode;
            const bar = await renderScreen(<>{HeaderRight()}</>);
            try {
                expect(bar.findAllHostsByTestId('project-header-open-terminal')).toHaveLength(1);
                await bar.pressByTestIdAsync('project-header-open-browser');
                expect(onOpenBrowser).toHaveBeenCalledTimes(1);
            } finally {
                await bar.unmount();
            }
        } finally {
            await screen.unmount();
        }
    });
});
