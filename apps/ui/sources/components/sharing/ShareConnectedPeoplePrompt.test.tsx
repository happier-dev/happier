import { SHARE_SHEET_HOST } from '@/components/sharing/shareSheetHost';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module);

const { ShareConnectedPeoplePrompt } = await import('@happier-dev/plugin-ui/components');

describe('ShareConnectedPeoplePrompt', () => {
    it('explains who appears in the people directory and leads to the Friends flow', async () => {
        const screen = await renderScreen(<ShareConnectedPeoplePrompt host={SHARE_SHEET_HOST} testID="share-directory-empty" />);
        expect(screen.getTextContent()).toContain('shareSheet.noConnectedPeople');
        await screen.pressByTestIdAsync('share-directory-empty-find-friends');
        expect(routerPush).toHaveBeenCalledWith('/friends');
        await screen.unmount();
    });
});
