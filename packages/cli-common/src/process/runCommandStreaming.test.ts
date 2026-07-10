import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: spawnMock,
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function createSuccessfulChild(): EventEmitter & {
    stdout: EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
    stderr: EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
} {
    const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
        stderr: EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
    };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    return child;
}

describe('runCommandStreaming', () => {
    const tempDirs = new Set<string>();

    afterEach(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
        for (const dir of tempDirs) {
            rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.clear();
        spawnMock.mockReset();
        vi.resetModules();
    });

    it('wraps Windows .cmd shims with cmd.exe invocation options', async () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

        const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-run-streaming-win32-'));
        tempDirs.add(root);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });

        const extensionlessPath = join(binDir, 'runtime-tool');
        const cmdShimPath = join(binDir, 'runtime-tool.cmd');
        writeFileSync(extensionlessPath, '', 'utf8');
        writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

        spawnMock.mockImplementation(() => {
            const child = createSuccessfulChild();
            queueMicrotask(() => child.emit('close', 0, null));
            return child;
        });

        const { runCommandStreaming } = await import('./runCommandStreaming');
        await runCommandStreaming({
            cmd: extensionlessPath,
            args: ['--flag', 'value'],
            env: {
                PATH: binDir,
                PATHEXT: '.CMD;.EXE',
                ComSpec: 'C:\\Windows\\System32\\cmd.exe',
            },
        });

        expect(spawnMock).toHaveBeenCalledWith(
            'C:\\Windows\\System32\\cmd.exe',
            expect.arrayContaining(['/d', '/s', '/c']),
            expect.objectContaining({
                windowsHide: true,
                windowsVerbatimArguments: true,
            }),
        );
        const shellCommand = String(spawnMock.mock.calls[0]?.[1]?.[3] ?? '');
        expect(shellCommand.toLowerCase()).toContain(cmdShimPath.toLowerCase());
    });
});
