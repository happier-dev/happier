import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

installRepositoryTreeCommonModuleMocks({
    typography: () => vi.importActual('@/constants/Typography'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default ?? null,
            },
        });
    },
});

describe('RepositoryTreeDropOverlay', () => {
    it('shows the exact upload destination while a file target is active', async () => {
        const { RepositoryTreeDropOverlay } = await import('./RepositoryTreeDropOverlay');
        const screen = await renderScreen(<RepositoryTreeDropOverlay visible destinationLabel="src" />);

        expect(screen.findAll(node => node.children.includes('src')).length).toBeGreaterThan(0);
    });

    it('retires the outcome when no file target is active', async () => {
        const { RepositoryTreeDropOverlay } = await import('./RepositoryTreeDropOverlay');
        const screen = await renderScreen(<RepositoryTreeDropOverlay visible={false} destinationLabel="src" />);
        expect(screen.findAllByTestId('repository-tree-drop-overlay')).toHaveLength(0);
    });
});
