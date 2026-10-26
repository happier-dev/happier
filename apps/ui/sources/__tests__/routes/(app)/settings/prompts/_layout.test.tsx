import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock();
    // Model the navigator's screenLayout boundary around a selected route.
    return {
        ...mock.module,
        Stack: Object.assign((props: {
            children?: React.ReactNode;
            screenLayout?: (props: { children: React.ReactNode; options: Record<string, unknown> }) => React.ReactNode;
        }) => {
            const content = React.createElement('PromptRouteContent');
            return React.createElement('PromptNavigator', null, props.children,
                props.screenLayout ? props.screenLayout({ children: content, options: {} }) : content);
        }, { Screen: mock.module.Stack.Screen }),
    };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const originalReadiness = {
    isDataReady: storage.getState().isDataReady,
    artifactsLoaded: storage.getState().artifactsLoaded,
};

beforeEach(() => storage.setState({ isDataReady: true, artifactsLoaded: false }));
afterEach(async () => {
    await act(async () => { storage.setState(originalReadiness); });
});

describe('PromptsLayoutRoute', () => {
    it('keeps navigation mounted while gating prompt content on artifact hydration', async () => {
        const { default: PromptsLayoutRoute } = await import('@/app/(app)/settings/prompts/_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findAllByType('PromptNavigator' as never)).toHaveLength(1);
        expect(screen.findByTestId('prompts.artifacts.loading')).toBeTruthy();
        expect(screen.findAllByType('PromptRouteContent' as never)).toHaveLength(0);
    });

    it('mounts the selected prompt route after artifact heads are ready', async () => {
        await act(async () => { storage.setState({ artifactsLoaded: true }); });
        const { default: PromptsLayoutRoute } = await import('@/app/(app)/settings/prompts/_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findAllByType('PromptRouteContent' as never)).toHaveLength(1);
    });
});
