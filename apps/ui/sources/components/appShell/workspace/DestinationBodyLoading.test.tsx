import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DestinationBodyLoading } from './DestinationBodyLoading';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

afterEach(() => { standardCleanup(); });

describe('DestinationBodyLoading', () => {
    it('holds any lazy destination with in-place rows under a header slot, never a page spinner', async () => {
        const screen = await renderScreen(<DestinationBodyLoading />);
        expect(screen.findAllHostsByTestId('workspace-destination-body-loading-loading-spinner')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('workspace-destination-body-loading-header')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('workspace-destination-body-loading-rows')).toHaveLength(1);
        expect(screen.findHostByTestId('workspace-destination-body-loading')?.props.accessibilityLabel).toBe('common.loading');
    });
});
