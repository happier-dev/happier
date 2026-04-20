import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    return {
        ...actual,
        exec: execMock,
        spawn: spawnMock,
    };
});

import { registerBashHandler } from './bash';

function createRegistrar() {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method: string, handler: (payload: unknown) => Promise<unknown>) {
                handlers.set(method, handler);
            },
        },
    };
}

function createSpawnProcess() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    return child;
}

describe('registerBashHandler', () => {
    beforeEach(() => {
        execMock.mockReset();
        spawnMock.mockReset();
    });

    it('runs argv payloads without going through the default shell', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const handler = handlers.get(RPC_METHODS.BASH);
        expect(handler).toBeDefined();

        const child = createSpawnProcess();
        spawnMock.mockReturnValueOnce(child);

        const resultPromise = handler!({
            argv: ['git', 'worktree', 'remove', '--force', '--', 'C:/repo/.dev/worktree/feature branch'],
            cwd: process.cwd(),
        });

        child.stdout.write('ok');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);

        await expect(resultPromise).resolves.toEqual({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        expect(spawnMock).toHaveBeenCalledWith(
            'git',
            ['worktree', 'remove', '--force', '--', 'C:/repo/.dev/worktree/feature branch'],
            expect.objectContaining({
                cwd: process.cwd(),
                windowsHide: true,
                shell: false,
            }),
        );
        expect(execMock).not.toHaveBeenCalled();
    });

    it('allows cwd outside the default directory under the os-user filesystem policy', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, '/work/default', { accessPolicy: { kind: 'osUser' } });
        const handler = handlers.get(RPC_METHODS.BASH);
        expect(handler).toBeDefined();

        execMock.mockImplementationOnce((_command, _options, callback) => {
            callback(null, 'ok', '');
        });

        await expect(handler!({ command: 'pwd', cwd: '/outside/project' })).resolves.toMatchObject({
            success: true,
        });
        expect(execMock).toHaveBeenCalledWith(
            'pwd',
            expect.objectContaining({ cwd: '/outside/project' }),
            expect.any(Function),
        );
    });
});
