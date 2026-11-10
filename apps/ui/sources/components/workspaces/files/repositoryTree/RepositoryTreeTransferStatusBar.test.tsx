import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

installRepositoryTreeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
});

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
    it('keeps native handoff progress visible without offering ineffective app cancellation', async () => {
        const { RepositoryTreeTransferStatusBar } = await import('./RepositoryTreeTransferStatusBar');
        const screen = await renderScreen(<RepositoryTreeTransferStatusBar
            uploadState={{ status: 'idle' }}
            downloadState={{ status: 'downloading', name: 'recording.mp4', downloadedBytes: 4, totalBytes: 4, cancelable: false }}
            machineName="devbox"
            onCancelUploads={vi.fn()}
            onDismissUploadFailure={vi.fn()}
            onCancelDownload={vi.fn()}
        />);
        expect(screen.findByTestId('repository-tree-download-status')).not.toBeNull();
        expect(screen.findByTestId('repository-tree-download-cancel')).toBeNull();
    });

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
    ])('draws the active $label cancel control small and reaches the target by hit area', async ({
        cancelTestID,
        downloadState,
        onCancel,
        uploadState,
    }) => {
        const onCancelUploads = vi.fn();
        const onCancelDownload = vi.fn();
        const { RepositoryTreeTransferStatusBar } = await import('./RepositoryTreeTransferStatusBar');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <RepositoryTreeTransferStatusBar
                    uploadState={uploadState}
                    downloadState={downloadState}
                    machineName="devbox"
                    onCancelUploads={onCancelUploads}
                    onDismissUploadFailure={vi.fn()}
                    onCancelDownload={onCancelDownload}
                />
            </HappierUiPlatformProvider>,
        );

        const cancelControl = screen.findHostByTestId(cancelTestID);
        const frame = flattenStyle(cancelControl?.props.style);
        expect(cancelControl?.props.accessibilityRole).toBe('button');
        expect(cancelControl?.props.accessibilityLabel).toBe('common.cancel');
        expect(cancelControl?.props.disabled).not.toBe(true);
        // The control draws at the status bar's design size; the finger's 44 is hit slop around it.
        expect(frame.width).toBe(28);
        expect(frame.height).toBe(28);
        await act(async () => {
            cancelControl!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 28, height: 28 } } });
        });
        const slop = screen.findHostByTestId(cancelTestID)!.props.hitSlop as Record<'top' | 'bottom', number>;
        expect(28 + slop.top + slop.bottom).toBe(44);

        await act(async () => {
            screen.pressByTestId(cancelTestID);
        });
        expect(onCancel === 'uploads' ? onCancelUploads : onCancelDownload).toHaveBeenCalledTimes(1);
    });

    it('settles a failed upload on the surface with its reason in words, never the transport\'s text and never bare, until it is dismissed', async () => {
        const { RepositoryTreeTransferStatusBar } = await import('./RepositoryTreeTransferStatusBar');
        const onDismissUploadFailure = vi.fn();
        const render = async (uploadState: Parameters<typeof RepositoryTreeTransferStatusBar>[0]['uploadState']) => await renderScreen(
            <RepositoryTreeTransferStatusBar
                uploadState={uploadState}
                downloadState={{ status: 'idle' }}
                machineName="devbox"
                onCancelUploads={vi.fn()}
                onDismissUploadFailure={onDismissUploadFailure}
                onCancelDownload={vi.fn()}
            />,
        );
        const words = (screen: Awaited<ReturnType<typeof render>>) => JSON.stringify(screen.tree.toJSON());

        for (const [reason, key] of [
            ['unreachable', 'projects.checkouts.outOfReach'],
            ['declined', 'files.transfers.failureReasons.declined'],
            ['permission', 'errors.permissionDenied'],
            ['tooLarge', 'files.transfers.failureReasons.tooLarge'],
            ['unconfirmed', 'files.transfers.failureReasons.unconfirmed'],
            ['other', 'files.transfers.failureReasons.other'],
        ] as const) {
            const screen = await render({ status: 'error', error: 'Direct import request failed with status 409', reason });
            expect(words(screen), reason).toContain('files.transfers.uploadFailed');
            expect(words(screen), reason).toContain(key);
            expect(words(screen), reason).not.toContain('409');
        }
        const other = await render({ status: 'error', error: 'signal is aborted without reason', reason: 'other' });
        expect(words(other)).not.toContain('signal is aborted');
        await act(async () => { other.pressByTestId('repository-tree-upload-failure-dismiss'); });
        expect(onDismissUploadFailure).toHaveBeenCalledTimes(1);
        expect((await render({ status: 'canceled' })).findByTestId('repository-tree-upload-failure')).toBeNull();
    });
});
