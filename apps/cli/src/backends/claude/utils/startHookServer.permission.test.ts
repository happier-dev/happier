import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

import { startHookServer } from './startHookServer';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import { ClaudeLocalPermissionBridge } from '../localPermissions/localPermissionBridge';
import { PUBLIC_RPC_HANDLER_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

async function postSessionHook(params: {
  port: number;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${params.port}/hook/session-start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.body),
  });
  return { status: res.status, text: await res.text() };
}

async function postPermissionHook(params: {
  port: number;
  secret?: string;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${params.port}/hook/permission-request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.secret ? { 'x-happier-hook-secret': params.secret } : {}),
    },
    body: JSON.stringify(params.body),
  });
  return { status: res.status, text: await res.text() };
}

async function runPermissionForwarder(params: {
  port: number;
  hookEventName: string;
  secret: string;
  body: unknown;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), 'scripts', 'permission_hook_forwarder.cjs');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      scriptPath,
      String(params.port),
      params.hookEventName,
      params.secret,
    ], {
      cwd: join(process.cwd()),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(JSON.stringify(params.body));
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!address || typeof address === 'string') {
    throw new Error('failed to reserve port');
  }
  return address.port;
}

describe('startHookServer (session hook)', () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
    }
  });

  it('binds an explicitly requested port', async () => {
    const requestedPort = await reservePort();
    const server = await startHookServer({
      requestedPort,
      onSessionHook: () => {},
    });
    servers.push(server);

    expect(server.port).toBe(requestedPort);
  });

  it('fails cleanly when the requested port is already occupied', async () => {
    const blocker = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()));
      throw new Error('failed to allocate occupied port');
    }

    try {
      await expect(startHookServer({
        requestedPort: address.port,
        onSessionHook: () => {},
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()));
    }
  });

  it('routes PostToolUse session hooks through the generic session hook endpoint', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
    });
    servers.push(server);

    const res = await postSessionHook({
      port: server.port,
      body: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess_1',
        tool_use_id: 'toolu_1',
      },
    });

    expect(res).toEqual({ status: 200, text: 'ok' });
    expect(onSessionHook).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'toolu_1',
    }));
  });

  it('rejects oversized hook bodies with 413 instead of buffering them in memory', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({ onSessionHook });
    servers.push(server);

    const oversized = 'x'.repeat(11 * 1024 * 1024);
    const res = await fetch(`http://127.0.0.1:${server.port}/hook/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess_big', payload: oversized }),
    }).then(
      async (response) => ({ status: response.status, text: await response.text() }),
      // The server may also abort the socket mid-stream, which fetch reports as a network error.
      () => ({ status: 413, text: 'aborted' }),
    );

    expect(res.status).toBe(413);
    expect(onSessionHook).not.toHaveBeenCalled();

    // The server stays healthy for well-formed requests afterwards.
    const ok = await postSessionHook({ port: server.port, body: { session_id: 'sess_after', hook_event_name: 'PostToolUse' } });
    expect(ok).toEqual({ status: 200, text: 'ok' });
  });
});

describe('startHookServer (permission hook)', () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
    }
  });

  it('withdraws an interactive question when its HTTP hook times out and rejects a late answer', async () => {
    const { session, client } = createPermissionHandlerSessionStub('question-http-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 20 });
    bridge.activate();
    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook: (data, options) => bridge.handlePermissionHook(data, options),
      permissionRequestTimeoutMs: 20,
    });
    servers.push(server);

    try {
      const response = await postPermissionHook({
        port: server.port,
        body: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'question-http-timeout',
          tool_input: {
            questions: [{
              question: 'Which color?',
              options: [{ label: 'Blue' }, { label: 'Green' }],
            }],
          },
        },
      });

      expect(response.status).toBe(408);
      await expect.poll(() => client.agentState.requests['question-http-timeout']).toBeUndefined();
      expect(client.agentState.completedRequests['question-http-timeout']).toMatchObject({ status: 'canceled' });
      const answer = client.rpcHandlerManager.getHandler('permission')?.({
        id: 'question-http-timeout',
        approved: true,
        answers: { 'Which color?': 'Blue' },
      });
      await expect(answer).rejects.toMatchObject({
        publicErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER,
      });
      expect(client.agentState.completedRequests['question-http-timeout']).toMatchObject({ status: 'canceled' });
    } finally {
      bridge.dispose();
    }
  });

  it('withdraws a pending permission when the native hook disconnects without a response timeout', async () => {
    const { session, client } = createPermissionHandlerSessionStub('permission-http-disconnect');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook: (data, options) => bridge.handlePermissionHook(data, options),
      permissionRequestTimeoutMs: null,
    });
    servers.push(server);
    const controller = new AbortController();

    try {
      const response = fetch(`http://127.0.0.1:${server.port}/hook/permission-request`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'permission-http-disconnect' }),
      });
      await expect.poll(() => client.agentState.requests['permission-http-disconnect']).toBeDefined();
      controller.abort();
      await expect(response).rejects.toMatchObject({ name: 'AbortError' });
      await expect.poll(() => client.agentState.requests['permission-http-disconnect']).toBeUndefined();
      expect(client.agentState.completedRequests['permission-http-disconnect']).toMatchObject({ status: 'canceled' });
    } finally {
      controller.abort();
      bridge.dispose();
    }
  });

  it('returns 403 when the secret header is missing or mismatched', async () => {
    const onPermissionHook = vi.fn(() => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest' as const,
        decision: { behavior: 'allow' as const },
      },
    }));

    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook,
      permissionHookSecret: 'secret-1',
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      body: { tool_use_id: 'toolu_1', tool_name: 'Bash' },
    });

    expect(res.status).toBe(403);
    expect(onPermissionHook).not.toHaveBeenCalled();
  });

  it('times out permission hook requests using permissionRequestTimeoutMs', async () => {
    const onPermissionHook = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: { behavior: 'allow' as const },
        },
      };
    });

    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook,
      permissionHookSecret: 'secret-2',
      permissionRequestTimeoutMs: 20,
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-2',
      body: { tool_use_id: 'toolu_2', tool_name: 'Bash' },
    });

    expect(res.status).toBe(408);
  });

  it('returns the onPermissionHook response when it completes before timeout', async () => {
    const onPermissionHook = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: { behavior: 'deny' as const },
        },
      };
    });

    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook,
      permissionHookSecret: 'secret-3',
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-3',
      body: { tool_use_id: 'toolu_3', tool_name: 'Write' },
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as any;
    expect(parsed.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(onPermissionHook).toHaveBeenCalledTimes(1);
  });

  it('forwards PreToolUse hook requests with the hook event name preserved', async () => {
    const onPermissionHook = vi.fn(() => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        updatedInput: {
          answers: { 'Remove the scratch files?': 'Keep for inspection' },
        },
      },
    }));

    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook,
      permissionHookSecret: 'secret-pre-tool-use',
    });
    servers.push(server);

    const result = await runPermissionForwarder({
      port: server.port,
      hookEventName: 'PreToolUse',
      secret: 'secret-pre-tool-use',
      body: {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [] },
        tool_use_id: 'toolu_ask_pre_forwarder_1',
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(onPermissionHook).toHaveBeenCalledWith(expect.objectContaining({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_ask_pre_forwarder_1',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          answers: { 'Remove the scratch files?': 'Keep for inspection' },
        },
      },
    });
  });
});
