import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Image } from 'expo-image';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () =>
    (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const { HomeMark } = await import('./HomeMark');

describe('HomeMark', () => {
    it('draws the Happier mark for Happier Cloud and a house for any other Home, with no letter', async () => {
        const cloud = await renderScreen(<HomeMark serverUrl="https://api.happier.dev" />);
        expect(cloud.findAllByType(Image)).toHaveLength(1);
        expect(cloud.findByType(Image).props.source).toBeTruthy();
        expect(cloud.root.findAll((node) => node.props?.name === 'house')).toHaveLength(0);
        expect(cloud.getTextContent().trim()).toBe('');
        await cloud.unmount();

        const own = await renderScreen(<HomeMark serverUrl="https://home.leeroy.dev" />);
        expect(own.root.findAll((node) => node.props?.name === 'house').length).toBeGreaterThan(0);
        expect(own.getTextContent().trim()).toBe('');
        await own.unmount();
    });

    it('draws a stack for a group of Homes', async () => {
        const group = await renderScreen(<HomeMark glyph="stack" />);
        expect(group.root.findAll((node) => node.props?.name === 'stack').length).toBeGreaterThan(0);
        await group.unmount();
    });
});
