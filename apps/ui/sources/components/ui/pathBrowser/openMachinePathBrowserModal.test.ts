import type { IModal } from '@/modal';
import { describe, expect, it, vi } from 'vitest';

const showModalMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));
const browserModuleGate = vi.hoisted(() => ({
    block: false,
    release: null as (() => void) | null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: showModalMock,
        },
    }).module;
});

vi.mock('./MachinePathBrowserModal', async () => {
    if (browserModuleGate.block) {
        await new Promise<void>((resolve) => {
            browserModuleGate.release = resolve;
        });
    }
    return { MachinePathBrowserModal: () => null };
});

describe('openMachinePathBrowserModal', () => {
    it('can show the modal shell without loading the path browser implementation first', async () => {
        await import('./openMachinePathBrowserModal');
        vi.resetModules();
        browserModuleGate.block = true;
        const openerImport = import('./openMachinePathBrowserModal');
        let openerLoaded = false;
        void openerImport.then(() => {
            openerLoaded = true;
        });

        try {
            await vi.waitFor(() => {
                expect(openerLoaded).toBe(true);
            }, { timeout: 1000 });
        } finally {
            browserModuleGate.release?.();
        }

        expect(openerLoaded).toBe(true);
    });

    it('opens the path browser with shared modal-card chrome so contained native modals own the sizing frame', async () => {
        const { openMachinePathBrowserModal } = await import('./openMachinePathBrowserModal');

        const promise = openMachinePathBrowserModal({
            machineId: 'machine-1',
            serverId: 'server-1',
            title: 'Pick a working directory',
        });

        expect(showModalMock).toHaveBeenCalledTimes(1);
        const firstCall = showModalMock.mock.calls[0];
        if (!firstCall) {
            throw new Error('Expected Modal.show to be called');
        }
        const config = firstCall[0] as {
            chrome?: unknown;
            component?: unknown;
            props?: Record<string, unknown>;
            onRequestClose?: () => void;
        };

        expect(config.chrome).toEqual(expect.objectContaining({
            kind: 'card',
            dimensions: expect.objectContaining({ maxHeightRatio: 0.92 }),
        }));
        expect(config.component).toBeTypeOf('function');
        expect(config.props).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            title: 'Pick a working directory',
            selectionMode: 'directory',
        }));

        config.onRequestClose?.();
        await expect(promise).resolves.toBeNull();
    });
});
