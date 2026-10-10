import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { useDeviceType } from '@/utils/platform/responsive';

import { buildCodeBreadcrumbSegments, CodeBrowserBar } from './CodeBrowserBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => dimensions,
        Dimensions: { get: () => dimensions },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const scope = { serverId: 'server-a', machineId: 'm1', rootPath: '/repo' };

describe('Code breadcrumb (plan 13 §2: Back/up updates the route)', () => {
    it('names every ancestor of a location from the project root', () => {
        expect(buildCodeBreadcrumbSegments('happier', 'apps/ui/sources').map((segment) => segment.path))
            .toEqual(['', 'apps', 'apps/ui', 'apps/ui/sources']);
        expect(buildCodeBreadcrumbSegments('happier', '')).toEqual([{ path: '', label: 'happier' }]);
    });

    it('goes back to an ancestor folder page, and the current place is not a link', async () => {
        const onNavigateFolder = vi.fn();
        const screen = await renderScreen(
            <CodeBrowserBar
                testID="bar"
                scope={scope}
                rootLabel="happier"
                path="apps/ui/SettingsModal.tsx"
                onNavigateFolder={onNavigateFolder}
                onOpenFile={() => {}}
                goToFile={false}
            />,
        );
        await screen.pressByTestIdAsync('bar-crumb-1');
        expect(onNavigateFolder).toHaveBeenLastCalledWith('apps');
        await screen.pressByTestIdAsync('bar-crumb-0');
        expect(onNavigateFolder).toHaveBeenLastCalledWith('');
        expect(screen.findByTestId('bar-crumb-3')).toBeFalsy();
        expect(screen.findByTestId('bar-current')).toBeTruthy();
    });

    it('omits only the duplicate project label on phones, preserving nested up navigation', async () => {
        const onNavigateFolder = vi.fn();
        function PhoneBar({ path }: { path: string }) {
            return <CodeBrowserBar testID="phone-bar" scope={scope} rootLabel="happier" path={path}
                compact={useDeviceType() === 'phone'} onNavigateFolder={onNavigateFolder}
                onOpenFile={() => {}} goToFile={false} />;
        }
        const screen = await renderScreen(<PhoneBar path="" />);
        expect(screen.findByTestId('phone-bar-current')).toBeNull();
        await screen.update(<PhoneBar path="apps/ui/SettingsModal.tsx" />);
        expect(screen.findByTestId('phone-bar-current')).toBeTruthy();
        await screen.pressByTestIdAsync('phone-bar-crumb-2');
        expect(onNavigateFolder).toHaveBeenLastCalledWith('apps/ui');
        await screen.pressByTestIdAsync('phone-bar-crumb-0');
        expect(onNavigateFolder).toHaveBeenLastCalledWith('');
    });
});
