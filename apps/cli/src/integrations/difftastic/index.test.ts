import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDifftasticHandler } from '@/rpc/handlers/difftastic';
import type { RpcHandler } from '@/api/rpc/types';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from './index';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    spawn: spawnMock,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        // Only the executable's OS presence is synthetic. Runtime-root and
        // asset resolution, including filesystem reads for unrelated imports, stay real.
        existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
            /(?:^|[\\/])difft(?:\.exe)?$/.test(String(path)) || actual.existsSync(path),
    };
});

describe('difftastic run', () => {
    it('runs each hosted Session difftastic RPC with its environment and directory', async () => {
        // Only the optional executable is substituted at the OS boundary; RPC,
        // filesystem authorization, workspace source and the spawned process stay real.
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        spawnMock.mockImplementation((_command, _args, options) => actual.spawn(process.execPath,
            ['-e', "process.stdout.write(JSON.stringify({value:process.env.HAPPIER_SCOPE_FIXTURE,color:process.env.FORCE_COLOR,cwd:process.cwd()}))"], options));
        const directories = await Promise.all(['first', 'second'].map(name => mkdtemp(join(tmpdir(), 'happier-difftastic-' + name + '-'))));
        try {
            await Promise.all(directories.map((cwd, index) => runAddedHostedSession({
                environment: { ...process.env, HAPPIER_SCOPE_FIXTURE: 'session-' + index },
                workingDirectory: cwd, end() {},
            }, async () => {
                let invoke: ((payload: unknown) => Promise<unknown>) | undefined;
                registerDifftasticHandler({ registerHandler<TRequest, TResponse>(_method: string, handler: RpcHandler<TRequest, TResponse>) {
                    invoke = payload => Promise.resolve(handler(payload as TRequest, { signal: new AbortController().signal }));
                } }, cwd);
                expect(await invoke!({ args: ['first.ts', 'second.ts'] })).toMatchObject({ success: true, exitCode: 0,
                    stdout: JSON.stringify({ value: 'session-' + index, color: '1', cwd: await realpath(cwd) }) });
            })));
        } finally { await Promise.all(directories.map(cwd => rm(cwd, { recursive: true, force: true }))); }
    });

    afterEach(() => {
        spawnMock.mockReset();
    });

    it('reports signal termination as an unsuccessful exit code', async () => {
        const child = Object.assign(new ChildProcess(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        });
        spawnMock.mockReturnValue(child);

        const resultPromise = run(['--version']);
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
        child.stdout.write('partial stdout');
        child.stderr.write('partial stderr');
        child.emit('close', null, 'SIGTERM');

        await expect(resultPromise).resolves.toEqual({
            exitCode: -1,
            stdout: 'partial stdout',
            stderr: 'partial stderr',
        });
    });

    it('releases the caller when the request is cancelled (teardown goes to the canonical process-tree owner)', async () => {
        const child = Object.assign(new ChildProcess(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        });
        spawnMock.mockReturnValue(child);
        const controller = new AbortController();

        const resultPromise = run(['a.ts', 'b.ts'], { signal: controller.signal });
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
        controller.abort();

        await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    });
});
