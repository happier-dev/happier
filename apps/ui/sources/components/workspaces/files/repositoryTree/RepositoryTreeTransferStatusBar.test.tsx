import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

installRepositoryTreeCommonModuleMocks();

function flattenStyle(styleProp: unknown): Record<string, unknown> {
    const resolved = typeof styleProp === 'function'
        ? (styleProp as (state: Record<string, boolean>) => unknown)({
            pressed: false,
            hovered: false,
            focused: false,
            selected: false,
            highlighted: false,
            busy: false,
            disabled: false,
        })
        : styleProp;
    const entries = Array.isArray(resolved)
        ? (resolved as unknown[]).flat(Infinity)
        : [resolved];
    return Object.assign({}, ...entries.filter(Boolean) as object[]);
}

describe('RepositoryTreeTransferStatusBar', () => {
    it.each([
        {
            label: 'upload',
            cancelTestID: 'repository-tree-upload-cancel',
            uploadState: {
                status: 'preflighting' as const,
                totalFiles: 1,
                completedFiles: 0,
                uploadedBytes: 0,
                totalBytes: 0,
            },
            downloadState: { status: 'idle' as const },
            onCancel: 'uploads' as const,
        },
        {
            label: 'download',
            cancelTestID: 'repository-tree-download-cancel',
            uploadState: { status: 'idle' as const },
            downloadState: {
                status: 'downloading' as const,
                name: 'report.txt',
                downloadedBytes: 0,
                totalBytes: 4,
            },
            onCancel: 'download' as const,
        },
    ])('gives the active $label cancel control a real accessible target', async ({
        cancelTestID,
        downloadState,
        onCancel,
        uploadState,
    }) => {
        const onCancelUploads = vi.fn();
        const onCancelDownload = vi.fn();
        const { RepositoryTreeTransferStatusBar } = await import('./RepositoryTreeTransferStatusBar');
        const screen = await renderScreen(
            <RepositoryTreeTransferStatusBar
                uploadState={uploadState}
                downloadState={downloadState}
                onCancelUploads={onCancelUploads}
                onCancelDownload={onCancelDownload}
            />,
        );

        const cancelControl = screen.findByTestId(cancelTestID);
        const frame = flattenStyle(cancelControl?.props.style);
        expect(cancelControl?.props.accessibilityRole).toBe('button');
        expect(cancelControl?.props.accessibilityLabel).toBe('common.cancel');
        expect(cancelControl?.props.disabled).not.toBe(true);
        expect(cancelControl?.props.hitSlop).toBe(0);
        expect(frame.width).toBeGreaterThanOrEqual(44);
        expect(frame.height).toBeGreaterThanOrEqual(44);

        await act(async () => {
            screen.pressByTestId(cancelTestID);
        });
        expect(onCancel === 'uploads' ? onCancelUploads : onCancelDownload).toHaveBeenCalledTimes(1);
    });
});
