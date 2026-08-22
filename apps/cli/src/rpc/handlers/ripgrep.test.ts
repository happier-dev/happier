import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';

const runRipgrepMock = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/ripgrep/index', () => ({
    run: (...args: unknown[]) => runRipgrepMock(...args),
}));

import { registerRipgrepHandler } from './ripgrep';

describe('registerRipgrepHandler', () => {
    beforeEach(() => {
        runRipgrepMock.mockReset();
    });

    it('forwards the transport cancellation signal to the ripgrep process owner', async () => {
        const handlers = new Map<string, RpcHandler>();
        const registrar: RpcHandlerRegistrar = {
            registerHandler(method, handler) {
                handlers.set(method, handler);
            },
        };
        const controller = new AbortController();
        runRipgrepMock.mockResolvedValue({ exitCode: 0, stdout: 'src/index.ts\n', stderr: '' });

        registerRipgrepHandler(registrar, '/workspace');
        const handler = [...handlers.values()][0];
        expect(handler).toBeDefined();
        if (!handler) throw new Error('ripgrep handler was not registered');
        await expect(handler({ args: ['--files'] }, { signal: controller.signal })).resolves.toEqual({
            success: true,
            exitCode: 0,
            stdout: 'src/index.ts\n',
            stderr: '',
        });

        expect(runRipgrepMock).toHaveBeenCalledWith(
            ['--files'],
            { cwd: '/workspace', signal: controller.signal },
        );
    });
});
