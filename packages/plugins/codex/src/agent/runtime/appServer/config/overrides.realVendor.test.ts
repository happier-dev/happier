import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCodexAppServerConfigOverrides } from './overrides';

// Runs the installed Codex binary against the overrides Happier injects. The only simulated
// peers are a loopback Responses endpoint and two stdio MCP servers.
const realVendor = process.env.HAPPIER_MCP_REAL_VENDOR === '1';
const codexBin = process.env.HAPPIER_MCP_CODEX_BIN ?? 'codex';

const MCP_SERVER_SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : message.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`;
// Never answers initialize: the shape of a third-party server stuck connecting to its backend.
const HUNG_SERVER_SCRIPT = `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1 << 30);`;
const FAILING_SERVER_SCRIPT = 'process.exit(1);';

type Fixture = { dir: string; model: Server; codex?: ChildProcess };
const fixtures: Fixture[] = [];

afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
        fixture.codex?.kill('SIGKILL');
        fixture.model.close();
        await rm(fixture.dir, { recursive: true, force: true });
    }
});

async function runCodexFirstTurn(mcpServers: Parameters<typeof buildCodexAppServerConfigOverrides>[0], dir: string) {
    let onRequest!: () => void;
    const firstModelRequest = new Promise<void>(resolve => { onRequest = resolve; });
    const model = createServer((incoming, response) => {
        onRequest();
        incoming.resume();
        response.writeHead(500);
        response.end();
    });
    const fixture: Fixture = { dir, model };
    fixtures.push(fixture);
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('No loopback model address');

    const { processOverrides, mcpOverrides } = buildCodexAppServerConfigOverrides(mcpServers);
    const overrides = [
        'model="gpt-5"',
        'model_provider="fixture"',
        `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses"}`,
        ...processOverrides,
        ...mcpOverrides,
    ];
    const codex = spawn(codexBin, ['exec', '--skip-git-repo-check', ...overrides.flatMap(value => ['-c', value]), 'hi'], {
        cwd: dir,
        env: { ...process.env, CODEX_HOME: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    fixture.codex = codex;
    let output = '';
    codex.stdout?.on('data', chunk => { output += String(chunk); });
    codex.stderr?.on('data', chunk => { output += String(chunk); });
    const exited = once(codex, 'exit').then(([code]) => ({ kind: 'exited' as const, code: code as number | null }));
    const outcome = await Promise.race([firstModelRequest.then(() => ({ kind: 'model_request' as const })), exited]);
    return { outcome, output: () => output };
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe.skipIf(!realVendor)('Codex MCP startup with Happier overrides (real vendor)', () => {
    it('reaches the model while a hung third-party MCP server is still starting', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-codex-mcp-'));
        const pidFile = join(dir, 'hung.pid');
        await writeFile(join(dir, 'bridge.cjs'), MCP_SERVER_SCRIPT);
        await writeFile(join(dir, 'hung.cjs'), HUNG_SERVER_SCRIPT);

        const { outcome } = await runCodexFirstTurn({
            happier: { command: process.execPath, args: [join(dir, 'bridge.cjs')] },
            reports: { command: process.execPath, args: [join(dir, 'hung.cjs'), pidFile] },
        }, dir);

        expect(outcome.kind).toBe('model_request');
        // The first turn did not wait for the hung server to exhaust its startup budget.
        expect(isAlive(Number(await readFile(pidFile, 'utf8')))).toBe(true);
    }, 120_000);

    it('fails thread start with a named error when the Happier bridge cannot start', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-codex-mcp-'));
        await writeFile(join(dir, 'failing.cjs'), FAILING_SERVER_SCRIPT);

        const { outcome, output } = await runCodexFirstTurn({
            happier: { command: process.execPath, args: [join(dir, 'failing.cjs')] },
        }, dir);

        expect(outcome.kind).toBe('exited');
        expect(output()).toMatch(/required MCP servers failed to initialize: happier/);
    }, 120_000);
});
