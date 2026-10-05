import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';
import { createExternalFileDropBinding } from '@/components/ui/treeDragDrop/externalFileDropAdapter';

let disposeBinding: (() => void) | undefined;
afterEach(async () => { await act(async () => { disposeBinding?.(); disposeBinding = undefined; }); });

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
        const binding = createExternalFileDropBinding(() => ({ enabled: true, onFilesDropped: () => {} }));
        disposeBinding = binding.mount();
        binding.handlers.onDragEnter({ dataTransfer: { types: ['Files'] }, clientX: 96, clientY: 128 });
        const screen = await renderScreen(<RepositoryTreeDropOverlay visible destinationLabel="src" />);

        expect(screen.findAll(node => node.children.includes('src')).length).toBeGreaterThan(0);
    });

    it('retires the outcome when no file target is active', async () => {
        const { RepositoryTreeDropOverlay } = await import('./RepositoryTreeDropOverlay');
        const screen = await renderScreen(<RepositoryTreeDropOverlay visible={false} destinationLabel="src" />);
        expect(screen.findAllByTestId('repository-tree-drop-overlay')).toHaveLength(0);
    });
});
