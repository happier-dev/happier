import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { createDaemonSpawnToolResolutionContext } from './spawnHooks';

class SplitOutputChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function writeSplitUtf8(stream: PassThrough, value: string, splitOffset: number): void {
  const bytes = Buffer.from(value, 'utf8');
  stream.write(bytes.subarray(0, splitOffset));
  stream.write(bytes.subarray(splitOffset));
}

describe('daemon spawn process output capture', () => {
  it('keeps split UTF-8 stream characters ordered and within the configured head caps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-spawn-split-utf8-'));
    try {
      const binDir = join(root, 'bin');
      const command = process.platform === 'win32' ? 'split-output.cmd' : 'split-output';
      const commandPath = join(binDir, command);
      await mkdir(binDir, { recursive: true });
      await writeFile(commandPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(commandPath, 0o755);
      }

      const child = new SplitOutputChild();
      spawnMock.mockReturnValueOnce(child);
      const context = createDaemonSpawnToolResolutionContext({
        processEnv: { PATH: binDir },
        signal: new AbortController().signal,
      });
      const stdout = 'stdout: 🙂 then tail';
      const stderr = 'stderr: 🙂 remains complete';
      const maxStdoutBytes = Buffer.byteLength('stdout: 🙂', 'utf8');
      const maxStderrBytes = Buffer.byteLength(stderr, 'utf8');
      const resultPromise = context.runSystemTool({
        toolId: command,
        lookupNames: [command],
        reason: 'unit-test split UTF-8 process output',
        maxStdoutBytes,
        maxStderrBytes,
      });

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      writeSplitUtf8(child.stdout, stdout, Buffer.byteLength('stdout: ', 'utf8') + 2);
      writeSplitUtf8(child.stderr, stderr, Buffer.byteLength('stderr: ', 'utf8') + 2);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);

      const result = await resultPromise;
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      if (!result.ok) return;
      expect(result.stdout).toBe('stdout: 🙂');
      expect(result.stderr).toBe(stderr);
      expect(result.stdout).not.toContain('\uFFFD');
      expect(result.stderr).not.toContain('\uFFFD');
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(maxStdoutBytes);
      expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(maxStderrBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
      spawnMock.mockReset();
    }
  });
});
