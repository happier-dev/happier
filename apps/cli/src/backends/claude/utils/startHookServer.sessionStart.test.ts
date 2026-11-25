import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startHookServer } from './startHookServer';

async function postSessionHook(params: {
  port: number;
  secret?: string;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${params.port}/hook/session-start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.secret ? { 'x-happier-hook-secret': params.secret } : {}),
    },
    body: JSON.stringify(params.body),
  });
  return { status: res.status, text: await res.text() };
}

async function runSessionForwarder(params: {
  port: number;
  hookEventName: string;
  secretFile?: string;
  body: unknown;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), 'scripts', 'session_hook_forwarder.cjs');
  const args = [scriptPath, String(params.port), params.hookEventName];
  if (params.secretFile) {
    args.push('--secret-file', params.secretFile);
  }
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(params.body));
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectPromise(new Error('waitUntil timed out'));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('startHookServer (/hook/session-start authentication, A5-MED-2)', () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
    }
  });

  it('rejects session hooks without the secret header when a secret is configured', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
      permissionHookSecret: 'hook-secret-1',
    });
    servers.push(server);

    const missing = await postSessionHook({
      port: server.port,
      body: { session_id: 'spoofed', hook_event_name: 'SessionStart', transcript_path: '/tmp/evil.jsonl' },
    });
    expect(missing.status).toBe(403);

    const wrong = await postSessionHook({
      port: server.port,
      secret: 'not-the-secret',
      body: { session_id: 'spoofed', hook_event_name: 'SessionStart' },
    });
    expect(wrong.status).toBe(403);

    expect(onSessionHook).not.toHaveBeenCalled();
  });

  it('accepts session hooks carrying the configured secret header', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
      permissionHookSecret: 'hook-secret-1',
    });
    servers.push(server);

    const ok = await postSessionHook({
      port: server.port,
      secret: 'hook-secret-1',
      body: { session_id: 'real-session', hook_event_name: 'SessionStart' },
    });
    expect(ok.status).toBe(200);
    expect(onSessionHook).toHaveBeenCalledWith('real-session', expect.objectContaining({ session_id: 'real-session' }));
  });

  it('keeps accepting unauthenticated session hooks when no secret is configured (back-compat)', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({ onSessionHook });
    servers.push(server);

    const ok = await postSessionHook({
      port: server.port,
      body: { session_id: 'legacy', hook_event_name: 'SessionStart' },
    });
    expect(ok.status).toBe(200);
    expect(onSessionHook).toHaveBeenCalledWith('legacy', expect.anything());
  });

  it('session forwarder reads --secret-file and authenticates against the server', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
      permissionHookSecret: 'forwarded-secret',
    });
    servers.push(server);

    const dir = mkdtempSync(join(tmpdir(), 'happier-session-hook-secret-'));
    const secretFile = join(dir, 'hook-secret');
    writeFileSync(secretFile, 'forwarded-secret\n', { mode: 0o600 });

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'SessionStart',
      secretFile,
      body: { session_id: 'via-forwarder' },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    await waitUntil(() => onSessionHook.mock.calls.length === 1);
    expect(onSessionHook).toHaveBeenCalledWith('via-forwarder', expect.objectContaining({
      hook_event_name: 'SessionStart',
    }));
  });

  it('returns attachment paths relative to the launch workspace to Claude after its cwd changes', async () => {
    const sessionWorkingDirectory = resolve('project with spaces');
    const server = await startHookServer({ onSessionHook: vi.fn(), sessionWorkingDirectory });
    servers.push(server);
    const path = '.happier/uploads/messages/message-1/12345678-image.png';
    const customPath = 'custom uploads/messages/message-1/1234abcd-diagram (2).pdf';
    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'UserPromptSubmit',
      body: {
        session_id: 'with-attachment',
        cwd: join(sessionWorkingDirectory, 'nested'),
        prompt: [
          'Please look at this.',
          '',
          'Attachments: open and analyze these files before answering.',
          '[attachments]',
          `- ${path} (image.png, image/png, 22 bytes)`,
          `- ${customPath} (diagram (2).pdf, application/pdf, 80 bytes)`,
          '- ../outside/messages/message-1/1234abcd-private.txt (private.txt, text/plain, 80 bytes)',
          '[/attachments]',
        ].join('\r\n'),
      },
    });

    expect(result.code).toBe(0);
    const { hookSpecificOutput } = JSON.parse(result.stdout);
    expect(hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(hookSpecificOutput.additionalContext).toContain(JSON.stringify(resolve(sessionWorkingDirectory, path)));
    expect(hookSpecificOutput.additionalContext).toContain(JSON.stringify(resolve(sessionWorkingDirectory, customPath)));
    expect(hookSpecificOutput.additionalContext).not.toContain('private.txt');
  });

  it('makes non-2xx hook delivery visible through a nonzero command exit', async () => {
    const server = await startHookServer({
      onSessionHook: vi.fn(),
      permissionHookSecret: 'expected-secret',
    });
    servers.push(server);

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'PostToolUse',
      body: { session_id: 'rejected-hook' },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('403');
    expect(result.stderr).not.toContain('expected-secret');
    expect(result.stderr).not.toContain('rejected-hook');
  });

  it('makes hook transport failure visible through a nonzero command exit', async () => {
    const server = await startHookServer({ onSessionHook: vi.fn() });
    const port = server.port;
    server.stop();

    const result = await runSessionForwarder({
      port,
      hookEventName: 'PostToolUse',
      body: { session_id: 'unreachable-hook' },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ECONNREFUSED');
    expect(result.stderr).not.toContain('unreachable-hook');
  });

  it('reports an unreadable secret file without revealing its path or hook payload', async () => {
    const server = await startHookServer({ onSessionHook: vi.fn(), permissionHookSecret: 'expected-secret' });
    servers.push(server);
    const secretFile = join(mkdtempSync(join(tmpdir(), 'happier-missing-hook-secret-')), 'private-secret');
    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'Stop',
      secretFile,
      body: { session_id: 'private-session' },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain('403');
    expect(result.stderr).not.toContain(secretFile);
    expect(result.stderr).not.toContain('expected-secret');
    expect(result.stderr).not.toContain('private-session');
  });
});
