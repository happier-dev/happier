import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ExecOutputStreamV1 } from '../exec/privateContract';

import { createPluginExecService } from '../exec/hostService';

async function firstExecutablePath(candidates: readonly string[]): Promise<string> {
    for (const candidate of candidates) {
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // try next
        }
    }
    throw new Error(`No executable found among ${candidates.join(', ')}`);
}

describe('createPluginExecService outputTee', () => {
    it('forwards post-spawn stdout and stderr chunks to the output tee while still buffering the result', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({ allowedExecutablePaths: [shellPath] });

        const teed: Array<Readonly<{ stream: ExecOutputStreamV1; text: string }>> = [];
        const result = await exec.run({
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'printf "hello-out"; printf "hello-err" 1>&2'],
        }, {
            outputTee: {
                onChunk: (stream, chunk) => {
                    teed.push({ stream, text: Buffer.from(chunk).toString('utf8') });
                },
            },
        });

        const teedStdout = teed.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join('');
        const teedStderr = teed.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text).join('');
        expect(teedStdout).toContain('hello-out');
        expect(teedStderr).toContain('hello-err');
        // The buffered result tails remain populated (tee is additive, not a replacement).
        expect(result.stdout).toContain('hello-out');
        expect(result.stderr).toContain('hello-err');
    });

    it('never lets a throwing tee break the process run', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({ allowedExecutablePaths: [shellPath] });

        const result = await exec.run({
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'printf "ok"'],
        }, {
            outputTee: {
                onChunk: () => {
                    throw new Error('tee sink failure');
                },
            },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('ok');
    });
});
