import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';
import { createExternalFileDropBinding } from '@/components/ui/treeDragDrop/externalFileDropAdapter';

let disposeBinding: (() => void) | undefined;
afterEach(async () => { await act(async () => { disposeBinding?.(); disposeBinding = undefined; }); });

installRepositoryTreeCommonModuleMocks({
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

const { RepositoryTreeDropOverlay } = await import('./RepositoryTreeDropOverlay');

describe('RepositoryTreeDropOverlay', () => {
    it('hides and restores the outcome while the external file drag remains active', async () => {
        const binding = createExternalFileDropBinding(() => ({ enabled: true, onFilesDropped: () => {} }));
        disposeBinding = binding.mount();
        binding.handlers.onDragEnter({ dataTransfer: { types: ['Files'] }, clientX: 96, clientY: 128 });
        const screen = await renderScreen(<RepositoryTreeDropOverlay visible={false} destinationLabel="src" />);
        expect(screen.findAllByTestId('repository-tree-drop-overlay')).toHaveLength(0);
        await screen.update(<RepositoryTreeDropOverlay visible destinationLabel="src" />);
        expect(screen.findByTestId('repository-tree-drop-overlay')).not.toBeNull();
        await screen.update(<RepositoryTreeDropOverlay visible={false} destinationLabel="src" />);
        expect(screen.findAllByTestId('repository-tree-drop-overlay')).toHaveLength(0);
        await screen.unmount();
    });
});
