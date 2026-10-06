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
});
