import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { projectPath } from '@/projectPath';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

const server = String.raw`
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\n'); if (end < 0) return;
    const line = input.slice(0, end); input = input.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { tools: [{ name: 'selected_ready', inputSchema: { type: 'object' } }] } }) + '\n',
      () => { if (process.env.MCP_TEST_NORMAL_EXIT === '1') process.exit(0); });
  }
});
`;

async function fixture(normalExit: boolean) {
  // Keep bare-package resolution identical to the public launcher. Only these
  // test-owned temporary bytes are created; no checked-in source is overwritten.
  const parent = join(projectPath(), '.project/tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'mcp-launcher-signal-'));
  const source = join(projectPath(), 'src/mcp/launchers/stdioMcpServerLauncher.ts');
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ command: process.execPath, args: ['-e', server],
    env: { MCP_TEST_NORMAL_EXIT: normalExit ? '1' : '0' } }), { mode: 0o600 });
  const hook = resolveTsxImportHookPath();
  if (!hook) throw new Error('Missing canonical source loader');
  const child = spawn(process.execPath, ['--conditions=happier-source', '--import', hook, source], {
    cwd: projectPath(), env: { ...process.env, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
      HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: config }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let code: number | null | undefined;
  let signal: NodeJS.Signals | null | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; resolve(); });
  });
  const messages = new ReadBuffer();
  const useful = new Promise<boolean>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve(false));
    child.stdout.on('data', chunk => {
      messages.append(chunk);
      try {
        for (;;) {
          const message = messages.readMessage(); if (!message) return;
          if ('result' in message && message.id === 1) {
            const result = message.result;
            const tools = result && typeof result === 'object' ? Reflect.get(result, 'tools') : undefined;
            resolve(Boolean(Array.isArray(tools)
              && tools.some((tool: unknown) => Boolean(tool && typeof tool === 'object'
                && Reflect.get(tool, 'name') === 'selected_ready'))));
          }
        }
      } catch (error) { reject(error); }
    });
  });
  child.stdin.write(serializeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  return { child, useful, closed, outcome: () => ({ code, signal }),
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed; await rm(directory, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === 'win32')('public stdio launcher native signal settlement', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('preserves %s termination after useful selected child output', async signal => {
    const f = await fixture(false);
    try {
      expect(await f.useful).toBe(true);
      f.child.kill(signal);
      // Bounded assertion observation, not a new production shutdown deadline.
      // The old owner swallows its self-signal and fails this assertion.
      await vi.waitFor(() => expect(f.outcome()).toEqual({ code: null, signal }));
      await f.closed;
    } finally { await f.cleanup(); }
  });

  it('preserves ordinary owner success after useful selected child output', async () => {
    const f = await fixture(true);
    try {
      expect(await f.useful).toBe(true);
      await f.closed;
      expect(f.outcome()).toEqual({ code: 0, signal: null });
    } finally { await f.cleanup(); }
  });
});
