import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/workspaces/transfers/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: () => ({
        downloadState: { status: 'idle' },
        startDownload: async () => ({ ok: true }),
    }),
}));

vi.mock('@/components/ui/buttons/IconButton', () => ({
    IconButton: (props: Record<string, unknown>) => React.createElement('IconButton', props),
}));

describe('WorkspaceFileDownloadButton native target', () => {
    const originalPlatform = Platform.OS;

    afterEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    });

    it.each([
        ['ios', 44],
        ['android', 48],
    ] as const)('declares the shared %s minimum interactive target', async (platform, expectedTarget) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const { WorkspaceFileDownloadButton } = await import('./WorkspaceFileDownloadButton');
        const screen = await renderScreen(
            <WorkspaceFileDownloadButton
                testID="workspace-file-download"
                workspaceScope={{ serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' }}
                path="notes.txt"
            />,
        );

        expect(resolveMinimumInteractiveTargetSize(Platform.OS)).toBe(expectedTarget);
        expect(screen.findByType('IconButton')?.props).toEqual(expect.objectContaining({
            minimumInteractiveTargetSize: expectedTarget,
            interactiveTargetGapPx: 20,
        }));
    });
});
