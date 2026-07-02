import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'scripts', 'statusline_forwarder.cjs');

const samplePayload = {
  session_id: 'sess-1',
  transcript_path: '/tmp/transcript.jsonl',
  model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
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
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
      });
    });
    child.stdin.end(params.stdin);
  });
}

function encodeOriginalCommand(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64');
}

describe('statusline_forwarder.cjs exit-code contract (QA-B F7 port)', () => {
  let chainDir: string;
  let secretPath: string;

  beforeEach(async () => {
    chainDir = await mkdtemp(join(tmpdir(), 'happier-statusline-chain-'));
    secretPath = join(chainDir, 'secret');
    await writeFile(secretPath, 'secret-abc');
    await chmod(secretPath, 0o600);
  });

  async function writeChainScript(name: string, source: string): Promise<string> {
    const chainScriptPath = join(chainDir, name);
    await writeFile(chainScriptPath, source);
    return `"${process.execPath}" "${chainScriptPath}"`;
  }

  it('exits 0 and passes chain output through when the chained command exits non-zero WITH output', async () => {
    // A failing user statusline must never make Claude Code flag the statusLine command as a
    // setup issue (non-zero exit ⇒ Claude disables it, silently killing the statusline truth
    // feed). Output still passes through byte-for-byte.
    const chainCommand = await writeChainScript('chain-fail-with-output.cjs', [
      "let d='';",
      "process.stdin.on('data',(c)=>{d+=c;});",
      "process.stdin.on('end',()=>{",
      "  const p=JSON.parse(d);",
      "  process.stdout.write('CHAIN:'+(p.model&&p.model.display_name)+'\\n');",
      '  process.exit(7);',
      '});',
    ].join('\n'));
    const capture = await startCaptureServer();
    try {
      const result = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath, '--original-b64', encodeOriginalCommand(chainCommand)],
        stdin: JSON.stringify(samplePayload),
      });

      expect(result.stdout).toContain('CHAIN:Haiku 4.5');
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

  it('exits 0 and degrades to the minimal model line when the chained command fails with NO output', async () => {
    // Live root cause (remote-dev QA-B 2026-06-12): a user statusline ending in a falsy
    // `[ -n "$x" ] && ...` exits 1 with no output; propagating that blanked AND disabled the
    // status bar. Degrade to the model line instead of a blank broken bar.
    const chainCommand = await writeChainScript(
      'chain-fail-no-output.cjs',
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(1));",
    );
    const capture = await startCaptureServer();
    try {
      const result = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath, '--original-b64', encodeOriginalCommand(chainCommand)],
        stdin: JSON.stringify(samplePayload),
      });

      expect(result.stdout.trim()).toBe('Haiku 4.5');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    } finally {
      await capture.stop();
    }
  });

  it('keeps a successful chain byte-preserved with exit 0', async () => {
    const chainCommand = await writeChainScript('chain-ok.cjs', [
      "process.stdin.resume(); process.stdin.on('end', () => {",
      "  process.stdout.write('OK-LINE\\n');",
      '  process.exit(0);',
      '});',
    ].join('\n'));
    const capture = await startCaptureServer();
    try {
      const result = await runForwarder({
        args: [String(capture.port), '--secret-file', secretPath, '--original-b64', encodeOriginalCommand(chainCommand)],
        stdin: JSON.stringify(samplePayload),
      });

      expect(result.stdout).toContain('OK-LINE');
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    } finally {
      await capture.stop();
    }
  });
});
