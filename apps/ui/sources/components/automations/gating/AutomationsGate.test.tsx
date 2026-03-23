import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


const useAutomationsSupportMock = vi.fn();

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => useAutomationsSupportMock(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            ActivityIndicator: 'ActivityIndicator',
                            View: 'View',
                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#999',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => {
        if (key === 'automations.gate.disabledTitle') return 'Automations are disabled';
        if (key === 'automations.gate.disabledBody') return 'Enable them from Settings, then turn on Experiments and Automations.';
        return key;
    },
    });
});

afterEach(() => {
    useAutomationsSupportMock.mockReset();
});

describe('AutomationsGate', () => {
    it('renders a loading state while automations support is unresolved', async () => {
        useAutomationsSupportMock.mockReturnValue({
            enabled: false,
            loading: true,
            discoverable: true,
            blockedBy: null,
            blockerCode: null,
        });

        const { AutomationsGate } = await import('./AutomationsGate');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AutomationsGate>
                    <TextStub>Allowed</TextStub>
                </AutomationsGate>)).tree;

        const json = JSON.stringify(tree.toJSON());
        expect(json).not.toContain('Allowed');
        expect(json).not.toContain('Automations are disabled');
        expect(json).toContain('ActivityIndicator');
    });

    it('renders children when automations are enabled', async () => {
        useAutomationsSupportMock.mockReturnValue({
            enabled: true,
            loading: false,
            discoverable: true,
            blockedBy: null,
            blockerCode: null,
        });

        const { AutomationsGate } = await import('./AutomationsGate');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AutomationsGate>
                    <TextStub>Allowed</TextStub>
                </AutomationsGate>)).tree;

        expect(JSON.stringify(tree.toJSON())).toContain('Allowed');
    });

    it('renders a disabled state when automations are unavailable', async () => {
        useAutomationsSupportMock.mockReturnValue({
            enabled: false,
            loading: false,
            discoverable: false,
            blockedBy: 'server',
            blockerCode: 'disabled_on_server',
        });

        const { AutomationsGate } = await import('./AutomationsGate');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AutomationsGate>
                    <TextStub>Allowed</TextStub>
                </AutomationsGate>)).tree;

        const json = JSON.stringify(tree.toJSON());
        expect(json).not.toContain('Allowed');
        expect(json).toContain('Automations are disabled');
    });
});

function TextStub(props: { children: string }) {
    return React.createElement('Text', props);
}
