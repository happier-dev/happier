import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { buildCodeBreadcrumbSegments, CodeBrowserBar } from './CodeBrowserBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({});
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
});
