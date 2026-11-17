import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readPiProviderFailureDiagnostic } from './providerFailureDiagnostic';

// Only the HTTP gateway is fake: the installed Pi CLI produces the RPC failure.
it.each([
  { status: 401, code: 'invalid_api_key', retryable: false },
  { status: 429, code: 'rate_limit_error', retryable: true },
  { status: 503, code: 'overloaded_error', retryable: true },
])('retains gateway $status/$code at the Session issue boundary', async ({ status, code, retryable }) => {
  const { classifyPrimarySessionRuntimeIssue } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
  const root = mkdtempSync(join(tmpdir(), 'pi-gateway-cause-'));
  const gateway = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
    response.end(JSON.stringify({ error: { type: code, code, message: 'Synthetic gateway refusal' } }));
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('Missing gateway address');
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
    writeFileSync(join(root, 'provider.mjs'), `export default pi => pi.registerProvider('fixture', {
      baseUrl:'http://127.0.0.1:${address.port}', apiKey:'synthetic', api:'anthropic-messages',
      models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],
        cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:8192}]});`);
    child = spawn(process.execPath, [resolve('../../../node_modules/pi-coding-agent-0821/dist/cli.js'),
      '--mode', 'rpc', '--no-session', '--no-skills', '--no-extensions', '--extension', join(root, 'provider.mjs'),
      '--provider', 'fixture', '--model', 'fixture'], {
      cwd: root, env: { HOME: root, USERPROFILE: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const frames: Record<string, unknown>[] = [];
    createInterface({ input: child.stdout! }).on('line', line => { frames.push(JSON.parse(line)); });
    child.stdin!.write(JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Reply briefly' }) + '\n');
    await expect.poll(() => frames.some(frame => frame.type === 'agent_end'), { timeout: 30_000 }).toBe(true);
    const diagnostic = frames.map(readPiProviderFailureDiagnostic).find(value => value !== null);
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.failureCause).toMatchObject({ httpStatus: status, providerErrorCode: code, retryable });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'pi', error: {
      code: diagnostic!.code, severity: 'error', message: diagnostic!.sanitizedPreview,
      details: { failureCause: diagnostic!.failureCause },
    } });
    expect(issue.failureCause).toMatchObject({ httpStatus: status, providerErrorCode: code, retryable });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    }
    gateway.closeAllConnections();
    await new Promise<void>(resolveClosed => gateway.close(() => resolveClosed()));
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
