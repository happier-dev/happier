import { describe, expect, it, vi } from 'vitest';

import {
    resolveStackDebugDirectPeerStartServer,
} from './resolveStackDebugDirectPeerStartServer';

describe('resolveStackDebugDirectPeerStartServer', () => {
    it('does not load the stack-debug composition for an ordinary daemon', async () => {
        const loadModule = vi.fn();

        await expect(resolveStackDebugDirectPeerStartServer({
            env: {},
            loadModule,
        })).resolves.toBeUndefined();
        expect(loadModule).not.toHaveBeenCalled();
    });

    it('loads the explicit stack-debug composition as the only positive consumer', async () => {
        const startStackDebugDirectPeerTransferServer = vi.fn();
        const loadModule = vi.fn(async () => ({
            startStackDebugDirectPeerTransferServer,
        }));

        await expect(resolveStackDebugDirectPeerStartServer({
            env: {
                HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT: '1',
            },
            loadModule,
        })).resolves.toBe(startStackDebugDirectPeerTransferServer);
        expect(loadModule).toHaveBeenCalledTimes(1);
    });
});
