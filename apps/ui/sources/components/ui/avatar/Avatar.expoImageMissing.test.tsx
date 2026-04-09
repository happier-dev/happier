import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installAvatarCommonModuleMocks } from './avatarTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAvatarCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: createUseSettingMock({
                values: {
                    avatarStyle: 'gradient',
                    showFlavorIcons: false,
                },
            }),
        });
    },
});

vi.mock('expo-image', () => ({
    Image: undefined,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#ffffff',
                shadowLevels: {
                    2: '#000000',
                },
                textLink: '#2266ee',
            },
        },
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentAvatarOverlaySizes: () => ({ circleSize: 16, iconSize: 12 }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
    getAgentIconSvgXml: () => null,
}));

describe('Avatar (expo-image missing)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders the uploaded-image path without crashing when expo-image omits Image', async () => {
        const { Avatar } = await import('./Avatar');

        await expect(
            renderScreen(
                <Avatar
                    id="session-1"
                    imageUrl="https://example.com/avatar.png"
                    thumbhash="thumbhash"
                    size={48}
                />,
            ),
        ).resolves.toBeTruthy();
    });

    it('renders the generated gradient path without crashing when expo-image omits Image', async () => {
        const { Avatar } = await import('./Avatar');

        await expect(
            renderScreen(
                <Avatar
                    id="session-1"
                    size={48}
                />,
            ),
        ).resolves.toBeTruthy();
    });
});
