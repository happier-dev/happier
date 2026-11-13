import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

function resolveBunExecutable(): string | null {
  const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? '').trim();
  if (explicit) return explicit;
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
const runtimeIt = bunExecutable ? it : it.skip;

describe('loadUndici on Bun', () => {
  // Bun resolves a bare `undici` specifier to its own builtin even when the package is
  // installed. That builtin's Agent has no close/destroy and its fetch ignores the
  // dispatcher, so a socket-bound request silently goes to the URL's TCP host instead.
  runtimeIt('returns the declared Undici package: the dispatcher routes the request and closes', async () => {
    const tempDir = await createTempDir('happier-undici-bun-');
    try {
      const socketPath = process.platform === 'win32'
        ? `\\\\.\\pipe\\happier-undici-bun-${process.pid}-${Date.now()}`
        : join(tempDir, 's.sock');
      const ownerUrl = pathToFileURL(join(process.cwd(), 'src/utils/loadUndici.ts')).href;
      const fixturePath = join(tempDir, 'probe.ts');
      await writeFile(fixturePath, [
        "import { createServer } from 'node:http';",
        `const { loadUndici } = await import(${JSON.stringify(ownerUrl)});`,
        'const { Agent, fetch } = await loadUndici();',
        "const server = createServer((_request, response) => response.end('socket-ok'));",
        `await new Promise((resolve) => server.listen(${JSON.stringify(socketPath)}, resolve));`,
        'const result = {};',
        'try {',
        `  const dispatcher = new Agent({ connect: { socketPath: ${JSON.stringify(socketPath)} } });`,
        // Nothing listens on TCP port 2: only the dispatcher's socket can answer.
        "  const response = await fetch('http://127.0.0.1:2/probe', { dispatcher });",
        '  result.body = await response.text();',
        '  await dispatcher.close();',
        '  result.closed = true;',
        '} catch (error) {',
        '  result.error = error?.cause?.code ?? error?.code ?? String(error?.message ?? error);',
        '}',
        'server.close();',
        'console.log(JSON.stringify(result));',
        'process.exit(0);',
        '',
      ].join('\n'), 'utf8');

      const run = spawnSync(bunExecutable!, [fixturePath], { encoding: 'utf8', timeout: 60_000 });
      expect(run.status, run.stderr).toBe(0);
      const line = run.stdout.trim().split(/\r?\n/u).at(-1) ?? '';
      expect(JSON.parse(line)).toEqual({ body: 'socket-ok', closed: true });
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
