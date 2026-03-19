import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const downloadSessionPathViaTransferMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('@/sync/domains/files/transfers/sessionPathTransferRpc', () => ({
    downloadSessionPathViaTransfer: (...args: unknown[]) => downloadSessionPathViaTransferMock(...args),
}));

vi.mock('@/sync/ops', () => ({
    sessionStatFile: vi.fn(),
}));

describe('useWorkspaceFileTransfers web download cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        downloadSessionPathViaTransferMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('delays blob URL revocation until after the download is triggered', async () => {
        const createObjectURL = vi.fn(() => 'blob:test-download');
        const revokeObjectURL = vi.fn();
        const click = vi.fn();
        const createElement = vi.fn(() => ({
            click,
            href: '',
            download: '',
            rel: '',
        }));

        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        vi.stubGlobal('document', { createElement });
        vi.stubGlobal('Blob', class Blob {
            constructor(_parts?: unknown[], _options?: Record<string, unknown>) {}
        });

        downloadSessionPathViaTransferMock.mockImplementation(async (params: {
            onInit?: (input: { name: string; sizeBytes: number }) => Promise<void> | void;
            writeBytes: (bytes: Uint8Array) => Promise<void>;
        }) => {
            await params.onInit?.({ name: 'report.txt', sizeBytes: 4 });
            await params.writeBytes(new Uint8Array([1, 2, 3, 4]));
            return { success: true, name: 'report.txt', sizeBytes: 4 };
        });

        const { useWorkspaceFileTransfers } = await import('./useWorkspaceFileTransfers');

        let api: ReturnType<typeof useWorkspaceFileTransfers> | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({ sessionId: 'session-1' });
            return null;
        }

        await act(async () => {
            renderer.create(<Test />);
        });

        if (!api) throw new Error('expected hook api');

        await act(async () => {
            await api!.startDownload({ path: 'report.txt', asZip: false });
        });

        expect(click).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).not.toHaveBeenCalled();

        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
    });
});
