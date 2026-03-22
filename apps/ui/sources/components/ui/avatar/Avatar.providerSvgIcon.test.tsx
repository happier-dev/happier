import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                View: (props: any) => React.createElement('View', props, props.children),
            }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#ffffff',
                shadow: { color: '#000000' },
                text: '#111111',
                textLink: '#2266ee',
            },
        },
    });
});

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('Image', props, props.children),
}));

vi.mock('react-native-svg', () => ({
    SvgXml: (props: any) => React.createElement('SvgXml', props),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: createUseSettingMock({
            values: {
                avatarStyle: 'gradient',
                showFlavorIcons: true,
            },
        }),
    });
});

vi.mock('./AvatarGradient', () => ({
    AvatarGradient: (props: any) => React.createElement('AvatarGradient', props),
}));

vi.mock('./AvatarSkia', () => ({
    AvatarSkia: (props: any) => React.createElement('AvatarSkia', props),
}));

vi.mock('./AvatarBrutalist', () => ({
    AvatarBrutalist: (props: any) => React.createElement('AvatarBrutalist', props),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => 'qwen',
    getAgentAvatarOverlaySizes: () => ({ circleSize: 16, iconSize: 12 }),
    getAgentIconSource: () => 1,
    getAgentIconTintColor: () => undefined,
    getAgentIconSvgXml: () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
}));

describe('Avatar provider svg icons', () => {
    it('renders an SvgXml overlay for svg-backed provider logos', async () => {
        const { Avatar } = await import('./Avatar');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Avatar id="session-1" flavor="qwen" size={48} />)).tree;

        expect(tree.findAllByType('SvgXml' as any).length).toBe(1);
    });
});
