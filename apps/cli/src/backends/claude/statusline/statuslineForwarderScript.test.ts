import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'scripts', 'statusline_forwarder.cjs');

const samplePayload = {
  session_id: 'sess-1',
  transcript_path: '/tmp/transcript.jsonl',
  model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
  context_window: { context_window_size: 200000 },
};

type CapturedRequest = Readonly<{
  url: string | undefined;
  secret: string | string[] | undefined;
  body: string;
}>;

async function startCaptureServer(): Promise<{
  port: number;
  requests: CapturedRequest[];
  stop: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      requests.push({
        url: req.url,
        secret: req.headers['x-happier-hook-secret'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    port: address.port,
    requests,
    stop: () => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    }),
  };
}

async function runForwarder(params: {
  args: readonly string[];
  stdin: string;
}): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const startedAt = Date.now();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...params.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.stdin.end(params.stdin);
  });
}

function encodeOriginalCommand(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64');
}

describe('statusline_forwarder.cjs', () => {
  let chainDir: string;
  let chainCommand: string;

  beforeEach(async () => {
    chainDir = await mkdtemp(join(tmpdir(), 'happier-statusline-chain-'));
    const chainScriptPath = join(chainDir, 'chain.cjs');
    await writeFile(
      chainScriptPath,
      [
        "let d='';",
        "process.stdin.on('data',(c)=>{d+=c;});",
        "process.stdin.on('end',()=>{",
        '  try {',
        '    const p=JSON.parse(d);',
        "    process.stdout.write('CHAIN:'+(p.model&&p.model.display_name)+'\\n');",
        '  } catch {',
        "    process.stdout.write('CHAIN:parse-error\\n');",
        '  }',
        '  process.exit(7);',
        '});',
      ].join('\n'),
    );
    chainCommand = `"${process.execPath}" "${chainScriptPath}"`;
  });

  afterEach(async () => {
    await rm(chainDir, { recursive: true, force: true });
  });

  async function writeSecretFile(secret: string): Promise<string> {
    const secretPath = join(chainDir, `secret-${Math.random().toString(36).slice(2)}.txt`);
    await writeFile(secretPath, secret, { mode: 0o600 });
    return secretPath;
  }

  it('POSTs the payload with the secret header and exec-chains the original command on the same stdin', async () => {
    const capture = await startCaptureServer();
    try {
      const secretPath = await writeSecretFile('secret-abc');
      const args = [String(capture.port), '--secret-file', secretPath, encodeOriginalCommand(chainCommand)];
      expect(args.join(' ')).not.toContain('secret-abc');
      const result = await runForwarder({
        args,
        stdin: JSON.stringify(samplePayload),
      });

      expect(result.stdout).toContain('CHAIN:Haiku 4.5');
      // QA-B F7 (live 2026-06-12): a non-zero chained exit must NOT pass through — Claude Code
      // flags the statusLine command as a setup issue and stops invoking it, killing the
      // runtime-control statusline truth feed (Lane Y). Chain output still passes byte-through.
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(capture.requests).toHaveLength(1);
      expect(capture.requests[0]!.url).toBe('/hook/statusline');
      expect(capture.requests[0]!.secret).toBe('secret-abc');
      expect(JSON.parse(capture.requests[0]!.body)).toEqual(samplePayload);
    } finally {
      await capture.stop();
    }
  });

  it('fails open when the hook server is down: original statusline still renders with its exit code', async () => {
    // Grab a port with no listener.
    const capture = await startCaptureServer();
    const deadPort = capture.port;
    await capture.stop();
    const secretPath = await writeSecretFile('secret-abc');

    const result = await runForwarder({
      args: [String(deadPort), '--secret-file', secretPath, encodeOriginalCommand(chainCommand)],
      stdin: JSON.stringify(samplePayload),
    });

    expect(result.stdout).toContain('CHAIN:Haiku 4.5');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('renders the minimal fallback line and exits 0 when the chained command fails with NO output (QA-B F7)', async () => {
    // Live root cause 2026-06-12: a user statusline script ending in `[ -n "$x" ] && ...` exits 1
    // with no output when the condition is false; passing that through made Claude Code disable
    // the statusline entirely (⚠ 1 setup issue), silencing the unified-terminal truth feed.
    const failingScriptPath = join(chainDir, 'failing.cjs');
    await writeFile(failingScriptPath, "process.stdin.resume(); process.stdin.on('end', () => process.exit(1));");
    const capture = await startCaptureServer();
    try {
      const secretPath = await writeSecretFile('secret-abc');
      const result = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath, encodeOriginalCommand(`"${process.execPath}" "${failingScriptPath}"`)],
        stdin: JSON.stringify(samplePayload),
      });

      expect(result.stdout.trim()).toBe('Haiku 4.5');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(capture.requests).toHaveLength(1);
    } finally {
      await capture.stop();
    }
  });

  it('does not hang on a server that accepts but never responds', async () => {
    const server = createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    try {
      const secretPath = await writeSecretFile('secret-abc');
      const result = await runForwarder({
        args: [String(address.port), '--secret-file', secretPath, encodeOriginalCommand(chainCommand)],
        stdin: JSON.stringify(samplePayload),
      });

      expect(result.stdout).toContain('CHAIN:Haiku 4.5');
      expect(result.code).toBe(0);
      expect(result.elapsedMs).toBeLessThan(5_000);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    }
  });

  it('prints a minimal model line when no original statusline command is configured', async () => {
    const capture = await startCaptureServer();
    try {
      const secretPath = await writeSecretFile('secret-abc');
      const result = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath],
        stdin: JSON.stringify(samplePayload),
      });

      expect(result.stdout.trim()).toBe('Haiku 4.5');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(capture.requests).toHaveLength(1);
    } finally {
      await capture.stop();
    }
  });

  it('falls back to the model id, then a generic label, when display data is missing', async () => {
    const capture = await startCaptureServer();
    try {
      const secretPath = await writeSecretFile('secret-abc');
      const idOnly = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath],
        stdin: JSON.stringify({ model: { id: 'claude-haiku-4-5' } }),
      });
      const noModel = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath],
        stdin: 'not json at all',
      });

      expect(idOnly.stdout.trim()).toBe('claude-haiku-4-5');
      expect(idOnly.code).toBe(0);
      expect(noModel.stdout.trim()).toBe('Claude');
      expect(noModel.code).toBe(0);
      expect(noModel.stderr).toBe('');
    } finally {
      await capture.stop();
    }
  });

  it('fails open on an unusable port argument: the original statusline still renders', async () => {
    const secretPath = await writeSecretFile('secret-abc');
    const result = await runForwarder({
      args: ['not-a-port', '--secret-file', secretPath, encodeOriginalCommand(chainCommand)],
      stdin: JSON.stringify(samplePayload),
    });

    expect(result.stdout).toContain('CHAIN:Haiku 4.5');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('fails open when the original command itself is broken: minimal line, exit 0, no stderr noise', async () => {
    const capture = await startCaptureServer();
    try {
      const secretPath = await writeSecretFile('secret-abc');
      const result = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath, 'not-valid-base64!!!'],
        stdin: JSON.stringify(samplePayload),
      });

      // Undecodable original → treated as absent → fallback line.
      expect(result.stdout.trim()).toBe('Haiku 4.5');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    } finally {
      await capture.stop();
    }
  });
});

describe('statusline forwarder background command', () => {
  it('hides the chained shell while preserving its output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-statusline-console-'));
    try {
      const optionsPath = join(directory, 'spawn-options.json');
      const preload = join(directory, 'capture-spawn.cjs');
      const original = join(directory, 'original.cjs');
      // Observe the genuine OS adapter inside the published CommonJS script.
      writeFileSync(preload, `const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = (...args) => {
  require('node:fs').writeFileSync(${JSON.stringify(optionsPath)}, JSON.stringify(args[1]));
  return spawn(...args);
};`);
      writeFileSync(original, 'process.stdout.write("original status");');
      const command = `"${process.execPath}" "${original}"`;
      const output = execFileSync(process.execPath, [
        '--require', preload,
        scriptPath,
        '0', 'test-secret', Buffer.from(command).toString('base64'),
      ], { input: '{}', encoding: 'utf8', windowsHide: true });
      expect(output).toBe('original status');
      expect(JSON.parse(readFileSync(optionsPath, 'utf8'))).toMatchObject({
        shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
