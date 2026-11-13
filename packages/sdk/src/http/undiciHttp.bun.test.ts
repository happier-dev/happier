import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function resolveBunExecutable(): string | null {
  const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? '').trim();
  if (explicit) return explicit;
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
const runtimeIt = bunExecutable ? it : it.skip;

describe('Undici HTTP exchange on Bun', () => {
  // Bun maps a bare `undici` to its builtin, whose Agent has no destroy: the exchange
  // would answer requests and then fail to close.
  runtimeIt('requests through the declared Undici package and closes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-sdk-undici-bun-'));
    try {
      const ownerUrl = pathToFileURL(fileURLToPath(new URL('./undiciHttp.ts', import.meta.url))).href;
      const fixturePath = join(tempDir, 'probe.ts');
      await writeFile(fixturePath, [
        "import { createServer } from 'node:http';",
        `const { createHttpExchange } = await import(${JSON.stringify(ownerUrl)});`,
        "const server = createServer((_request, response) => response.end('exchange-ok'));",
        "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
        'const result = {};',
        'try {',
        '  const exchange = createHttpExchange();',
        '  const response = await exchange.request(new URL(`http://127.0.0.1:${server.address().port}/probe`), { method: "GET", headers: {} });',
        '  result.status = response.statusCode;',
        '  const chunks = [];',
        '  for await (const chunk of response.body) chunks.push(chunk);',
        '  result.body = Buffer.concat(chunks).toString("utf8");',
        '  await exchange.close();',
        '  result.closed = true;',
        '} catch (error) {',
        '  result.error = String(error?.message ?? error);',
        '}',
        'server.close();',
        'console.log(JSON.stringify(result));',
        'process.exit(0);',
        '',
      ].join('\n'), 'utf8');

      const run = spawnSync(bunExecutable!, [fixturePath], { encoding: 'utf8', timeout: 60_000 });
      expect(run.status, run.stderr).toBe(0);
      const line = run.stdout.trim().split(/\r?\n/u).at(-1) ?? '';
      expect(JSON.parse(line)).toEqual({ status: 200, body: 'exchange-ok', closed: true });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
