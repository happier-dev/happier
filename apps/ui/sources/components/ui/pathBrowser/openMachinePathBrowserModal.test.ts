import type { IModal } from '@/modal';
import { describe, expect, it, vi } from 'vitest';

const showModalMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));
const browserModuleGate = vi.hoisted(() => ({
    block: false,
    release: null as (() => void) | null,
    onRequested: null as (() => void) | null,
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
    browserModuleGate.onRequested?.();
    if (browserModuleGate.block) {
        await new Promise<void>((resolve) => {
            browserModuleGate.release = resolve;
        });
    }
    return { MachinePathBrowserModal: () => null };
});

// Observe the initial cold import during collection, as the other heavy UI owner suites do.
// The ordering assertion is independent of how long the shared spinner/store graph takes to load.
const openerLoad = await (async () => {
    browserModuleGate.block = true;
    const browserRequested = new Promise<'browser-requested'>((resolve) => {
        browserModuleGate.onRequested = () => resolve('browser-requested');
    });
    const loaded = import('./openMachinePathBrowserModal');
    const outcome = await Promise.race([loaded.then(() => 'opener-loaded' as const), browserRequested]);
    browserModuleGate.onRequested = null;
    browserModuleGate.block = false;
    browserModuleGate.release?.();
    return { outcome, module: await loaded };
})();

describe('openMachinePathBrowserModal', () => {
    it('can show the modal shell without loading the path browser implementation first', () => {
        expect(openerLoad.outcome).toBe('opener-loaded');
    });

    it('opens the path browser with shared modal-card chrome so contained native modals own the sizing frame', async () => {
        const { openMachinePathBrowserModal } = openerLoad.module;

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
