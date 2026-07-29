import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alertMock = vi.hoisted(() => vi.fn());

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: unknown[]) => alertMock(...args),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('useWorkspaceRepositoryTreeRowActions download cancellation', () => {
    it('does not present an error alert when the user canceled the download', async () => {
        alertMock.mockReset();
        const onRequestDownload = vi.fn(async () => ({
            ok: false as const,
            error: 'Download canceled',
            canceled: true as const,
        }));
        const { useWorkspaceRepositoryTreeRowActions } = await import('./useWorkspaceRepositoryTreeRowActions');
        const hook = await renderHook(() => useWorkspaceRepositoryTreeRowActions({
            workspaceScope: { serverId: 'server-a', machineId: 'machine-1', rootPath: '/repo' },
            writeActionsEnabled: true,
            expandedPaths: [],
            onExpandedPathsChange: () => {},
            onRequestDownload,
        }));

        await act(async () => {
            await hook.getCurrent().onSelectRowMenuItem(
                { path: 'large.bin', type: 'file' },
                'repository-tree-menuitem-download',
            );
        });

        expect(onRequestDownload).toHaveBeenCalledWith({ path: 'large.bin', asZip: false });
        expect(alertMock).not.toHaveBeenCalled();
    });
});
