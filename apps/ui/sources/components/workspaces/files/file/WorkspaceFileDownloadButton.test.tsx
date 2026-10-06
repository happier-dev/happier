import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import type { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';
import { IconButton } from '@/components/ui/buttons/IconButton';

const alert = vi.hoisted(() => vi.fn());
const nativeActions = vi.hoisted(() => ({
    saveFile: vi.fn(async (_input: unknown) => ({ canceled: false })),
    openFile: vi.fn(async (_input: unknown) => ({ canceled: false })),
    shareFile: vi.fn(async (_input: unknown) => ({ canceled: false })),
}));
const fileSystem = vi.hoisted(() => ({ current: null as ReturnType<typeof createExpoFileSystemFileMock> | null }));

vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    fileSystem.current = createExpoFileSystemFileMock();
    return fileSystem.current.module;
});
vi.mock('expo-modules-core', async (importOriginal) => {
    const original = await importOriginal<typeof import('expo-modules-core')>();
    return {
        ...original,
        requireOptionalNativeModule: (name: string) => name === 'HappierFileActions'
            ? nativeActions : original.requireOptionalNativeModule(name),
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert } }).module;
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

const scope = { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' };

describe('WorkspaceFileDownloadButton', () => {
    const originalPlatform = Platform.OS;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>> | null = null;

    beforeEach(() => {
        // Native menu commits wait for the OS frame boundary; deliver it within act.
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            queueMicrotask(() => callback(0));
            return 0;
        });
        vi.clearAllMocks();
        for (const method of Object.values(nativeActions)) method.mockResolvedValue({ canceled: false });
    });

    afterEach(async () => {
        await act(async () => { await harness?.reset(); });
        harness = null;
        vi.unstubAllGlobals();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    });

    it.each([
        ['ios', 44],
        ['android', 48],
    ] as const)('uses the shared %s minimum interactive target', async (platform, expectedTarget) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const { WorkspaceFileDownloadButton } = await import('./WorkspaceFileDownloadButton');
        const screen = await renderScreen(
            <WorkspaceFileDownloadButton testID="workspace-file-download" workspaceScope={scope} path="notes.txt" />,
        );

        expect(screen.findByType(IconButton).props).toEqual(expect.objectContaining({
            minimumInteractiveTargetSize: expectedTarget,
            interactiveTargetGapPx: 20,
        }));
    });

    it('opens the Android save, open, and share action menu from the download button', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const { WorkspaceFileDownloadButton } = await import('./WorkspaceFileDownloadButton');
        const screen = await renderScreen(
            <WorkspaceFileDownloadButton testID="workspace-file-download" workspaceScope={scope} path="notes.txt" />,
        );

        await screen.pressByTestIdAsync('workspace-file-download');

        for (const action of ['save', 'open', 'share']) {
            expect(screen.findHostByTestId(`workspace-file-download-action-${action}`)).not.toBeNull();
        }
        expect(screen.findByType(IconButton).props).toEqual(expect.objectContaining({ expanded: true, hasPopup: 'menu' }));
    });

    it.each([
        ['save', 'saveFile'],
        ['open', 'openFile'],
        ['share', 'shareFile'],
    ] as const)('performs the selected Android %s action after downloading the file', async (action, method) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'notes.txt' });
        const { WorkspaceFileDownloadButton } = await import('./WorkspaceFileDownloadButton');
        const screen = await renderScreen(
            <WorkspaceFileDownloadButton testID="workspace-file-download" workspaceScope={harness.scope} path="notes.txt" />,
        );

        await screen.pressByTestIdAsync('workspace-file-download');
        await act(async () => {
            screen.pressByTestId(`workspace-file-download-action-${action}`);
            await vi.waitFor(() => expect(nativeActions[method]).toHaveBeenCalled());
        });
        expect(nativeActions[method]).toHaveBeenCalledWith(expect.stringMatching(/^file:/), 'notes.txt');
        for (const other of Object.keys(nativeActions) as (keyof typeof nativeActions)[]) {
            if (other !== method) expect(nativeActions[other]).not.toHaveBeenCalled();
        }
    });

    it.each(['canceled', 'failed'] as const)('distinguishes a %s native action from a successful download', async (outcome) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'notes.txt' });
        if (outcome === 'canceled') nativeActions.saveFile.mockResolvedValueOnce({ canceled: true });
        else nativeActions.saveFile.mockRejectedValueOnce(new Error('OS file action failed'));
        const { WorkspaceFileDownloadButton } = await import('./WorkspaceFileDownloadButton');
        const screen = await renderScreen(
            <WorkspaceFileDownloadButton testID="workspace-file-download" workspaceScope={harness.scope} path="notes.txt" />,
        );

        await screen.pressByTestIdAsync('workspace-file-download');
        await act(async () => {
            screen.pressByTestId('workspace-file-download-action-save');
            await vi.waitFor(() => expect(nativeActions.saveFile).toHaveBeenCalled());
        });
        await vi.waitFor(() => expect(screen.findByType(IconButton).props.disabled).toBe(false));
        if (outcome === 'canceled') expect(alert).not.toHaveBeenCalled();
        else expect(alert).toHaveBeenCalledWith('common.error', 'OS file action failed');
    });

    it('keeps the Android download button disabled while the native action is pending', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'notes.txt' });
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        nativeActions.saveFile.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return { canceled: false };
        });
        const { WorkspaceFileDownloadButton } = await import('./WorkspaceFileDownloadButton');
        const screen = await renderScreen(
            <WorkspaceFileDownloadButton testID="workspace-file-download" workspaceScope={harness.scope} path="notes.txt" />,
        );
        await screen.pressByTestIdAsync('workspace-file-download');
        await act(async () => {
            screen.pressByTestId('workspace-file-download-action-save');
            await entered.promise;
        });

        expect(screen.findByType(IconButton).props.disabled).toBe(true);
        expect([...fileSystem.current!.files.values()]).toContainEqual([1, 2, 3]);
        await act(async () => { release.resolve(); });
        await vi.waitFor(() => expect(screen.findByType(IconButton).props.disabled).toBe(false));
    });

    it('disables download when the workspace is unavailable', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const { WorkspaceFileDownloadButton } = await import('./WorkspaceFileDownloadButton');
        const screen = await renderScreen(
            <WorkspaceFileDownloadButton testID="workspace-file-download" workspaceScope={null} path="notes.txt" />,
        );

        expect(screen.findByType(IconButton).props.disabled).toBe(true);
    });
});
