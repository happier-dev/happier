import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';

function resolveBunExecutable(): string | null {
  const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? '').trim();
  if (explicit) return explicit;

  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, ['bun'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
const runtimeIt = bunExecutable ? it : it.skip;

describe('JSON envelope Bun stdout boundary', () => {
  runtimeIt('emits an exact parseable envelope larger than the pipe buffer before exit', async () => {
    const tempDir = await createTempDir('happier-json-envelope-bun-');
    try {
      const fixturePath = join(tempDir, 'large-json-envelope.ts');
      const ownerUrl = pathToFileURL(join(process.cwd(), 'src/cli/output/jsonEnvelope.ts')).href;
      const payloadBytes = 512 * 1024;
      await writeFile(fixturePath, [
        `import { printJsonEnvelope } from ${JSON.stringify(ownerUrl)};`,
        `await printJsonEnvelope({ ok: true, kind: 'large_output_probe', data: { payload: 'x'.repeat(${payloadBytes}) } });`,
        'process.exit(process.exitCode ?? 0);',
        '',
      ].join('\n'), 'utf8');

      const child = spawnTestProcess(bunExecutable!, [fixturePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout!.pause();
      child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // Force the child past a normal pipe's capacity before allowing the
      // consumer to drain it. An exit that does not await stdout loses bytes.
      await new Promise((resolve) => setTimeout(resolve, 100));
      child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stdout!.resume();

      const exit = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const expected = `${JSON.stringify({
        v: 1,
        ok: true,
        kind: 'large_output_probe',
        data: { payload: 'x'.repeat(payloadBytes) },
      })}\n`;

      expect(exit, stderr).toEqual({ code: 0, signal: null });
      expect(stdout.byteLength).toBe(Buffer.byteLength(expected));
      expect(stdout.toString('utf8')).toBe(expected);
      expect(JSON.parse(stdout.toString('utf8'))).toMatchObject({
        v: 1,
        ok: true,
        kind: 'large_output_probe',
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
