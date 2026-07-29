import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { SESSION_PROVIDER_HOOK_EVENT_ID_V1 } from '@happier-dev/protocol';
import { buildDefaultPermissionHookResponse } from '@happier-dev/plugins-claude/agent';

import {
  QUALIFIED_EXTERNAL_SESSION_HOOK_PATH,
  startSessionHookServer,
} from './server';

const { loggerDebugMock } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: loggerDebugMock,
  },
}));

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

async function postQualifiedExternalSessionHook(params: {
  port: number;
  secret: string;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(
    `http://127.0.0.1:${params.port}${QUALIFIED_EXTERNAL_SESSION_HOOK_PATH}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-happier-hook-secret': params.secret,
      },
      body: JSON.stringify(params.body),
    },
  );
  return { status: res.status, text: await res.text() };
}

async function openIncompletePost(params: {
  port: number;
  path: string;
  body: unknown;
}): Promise<{
  response: Promise<string>;
  writeRest(): void;
  close(): void;
}> {
  const body = JSON.stringify(params.body);
  const firstChunk = body.slice(0, 1);
  const remainingChunk = body.slice(1);
  let socket: Socket | null = null;
  let responseText = '';
  let resolveResponse: (response: string) => void;
  const response = new Promise<string>((resolveResponsePromise) => {
    resolveResponse = resolveResponsePromise;
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket = connect(params.port, '127.0.0.1', () => {
      socket?.write([
        `POST ${params.path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        firstChunk,
      ].join('\r\n'));
      resolveOpen();
    });
    socket.on('data', (chunk) => {
      responseText += chunk.toString('utf8');
      if (responseText.includes('\r\n\r\n')) {
        resolveResponse(responseText);
      }
    });
    socket.on('error', rejectOpen);
  });

  return {
    response,
    writeRest() {
      socket?.write(remainingChunk);
    },
    close() {
      socket?.destroy();
    },
  };
}

async function waitForLateHookProcessingWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function runPermissionForwarder(params: {
  port: number;
  hookEventName: string;
  secretFile: string;
  body: unknown;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), 'scripts', 'permission_hook_forwarder.cjs');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      scriptPath,
      String(params.port),
      params.hookEventName,
      '--secret-file',
      params.secretFile,
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

async function runSessionForwarder(params: {
  port: number;
  hookEventName: string;
  secretFile: string;
  body: unknown;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), 'scripts', 'session_hook_forwarder.cjs');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      scriptPath,
      String(params.port),
      params.hookEventName,
      '--secret-file',
      params.secretFile,
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
    child.stdin.on('error', () => {
      // A bounded forwarder may close stdin before a deliberately oversized fixture finishes.
    });
    child.stdin.end(JSON.stringify(params.body));
  });
}

describe('startSessionHookServer', () => {
  const servers: Array<{ stop: () => void }> = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    loggerDebugMock.mockClear();
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
    }
    return Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createSecretFile(secret: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-hook-secret-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'secret.txt');
    await writeFile(filePath, secret, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  }

  it('can reclaim an exact persisted port after the previous hook server closes', async () => {
    const first = await startSessionHookServer({});
    servers.push(first);
    const persistedPort = first.port;
    first.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await startSessionHookServer({
      requestedPort: persistedPort,
    } as Parameters<typeof startSessionHookServer>[0] & { requestedPort: number });
    servers.push(second);

    expect(second.port).toBe(persistedPort);
  });

  it('classifies oversized qualified hook bodies only by the host-owned sentinel identity', async () => {
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    const onQualifiedExternalSessionHook = vi.fn()
      .mockRejectedValueOnce(new Error('hook request body exceeded maximum size'))
      .mockRejectedValueOnce(hostile.proxy);
    const server = await startSessionHookServer({
      onQualifiedExternalSessionHook,
    });
    servers.push(server);
    const createBody = () => {
      const now = Date.now();
      return {
        eventId: 'SessionStart',
        observedAtMs: now,
        forwardingStartedAtMs: now,
        nativePayload: {},
      };
    };

    const sameMessage = await postQualifiedExternalSessionHook({
      port: server.port,
      secret: 'qualified-hook-token',
      body: createBody(),
    });
    const hostileRejection = await postQualifiedExternalSessionHook({
      port: server.port,
      secret: 'qualified-hook-token',
      body: createBody(),
    });

    expect(sameMessage).toEqual({ status: 400, text: 'invalid request' });
    expect(hostileRejection).toEqual({ status: 400, text: 'invalid request' });
    expect(loggerDebugMock).toHaveBeenLastCalledWith(
      '[sessionHookServer] Qualified External Session hook request failed',
    );
  });

  it('publishes canonical provider-hook events for provider session hooks', async () => {
    const publishHostEvent = vi.fn<(
      name: string,
      payload?: unknown,
    ) => Promise<void>>(async () => {});
    const onSessionHook = vi.fn();
    const server = await startSessionHookServer({
      session: {
        providerId: 'claude',
        sessionId: 'happier-session-1',
      },
      onSessionHook,
      publishHostEvent,
      requestReadTimeoutMs: 20,
    });
    servers.push(server);

    const res = await postSessionHook({
      port: server.port,
      body: {
        hook_event_name: 'SessionStart',
        session_id: 'provider-session-1',
        transcript_path: '/tmp/claude.jsonl',
      },
    });

    expect(res).toEqual({ status: 200, text: 'ok' });
    expect(onSessionHook).toHaveBeenCalledWith(
      'provider-session-1',
      expect.objectContaining({ hook_event_name: 'SessionStart' }),
    );
    expect(publishHostEvent).toHaveBeenCalledWith(
      SESSION_PROVIDER_HOOK_EVENT_ID_V1,
      {
        providerId: 'claude',
        sessionId: 'happier-session-1',
        providerSessionId: 'provider-session-1',
        eventName: 'SessionStart',
        providerPayload: {
          hook_event_name: 'SessionStart',
          session_id: 'provider-session-1',
          transcript_path: '/tmp/claude.jsonl',
        },
      },
    );
  });

  it('publishes provider-hook events when the legacy session callback fails', async () => {
    const privateTranscript = 'private provider transcript that must not enter hook logs';
    const publishHostEvent = vi.fn<(
      name: string,
      payload?: unknown,
    ) => Promise<void>>(async () => {});
    const server = await startSessionHookServer({
      session: {
        providerId: 'claude',
        sessionId: 'happier-session-legacy-failure',
      },
      onSessionHook: () => {
        throw {
          toJSON: () => ({ privateTranscript }),
          toString: () => privateTranscript,
        };
      },
      publishHostEvent,
    });
    servers.push(server);

    const res = await postSessionHook({
      port: server.port,
      body: {
        hook_event_name: 'SessionStart',
        session_id: 'provider-session-legacy-failure',
      },
    });

    expect(res).toEqual({ status: 200, text: 'ok' });
    expect(publishHostEvent).toHaveBeenCalledWith(
      SESSION_PROVIDER_HOOK_EVENT_ID_V1,
      expect.objectContaining({
        providerId: 'claude',
        sessionId: 'happier-session-legacy-failure',
        providerSessionId: 'provider-session-legacy-failure',
      }),
    );
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[sessionHookServer] Session hook callback failed after event publication',
    );
  });

  it('does not retain provider-supplied session hook fields in debug logs', async () => {
    const privatePayloadText = 'private-session-hook-payload-claim45';
    const rawTranscriptPath = join(tmpdir(), 'happier-secret-home', 'claude-session.jsonl');
    const rawCwd = join(tmpdir(), 'happier-secret-home');
    const server = await startSessionHookServer({
      session: {
        providerId: 'claude',
        sessionId: 'happier-session-redaction',
      },
      onSessionHook: vi.fn(),
      requestReadTimeoutMs: 20,
    });
    servers.push(server);
    loggerDebugMock.mockClear();

    const res = await postSessionHook({
      port: server.port,
      body: {
        hook_event_name: 'SessionStart',
        session_id: privatePayloadText,
        transcript_path: rawTranscriptPath,
        cwd: rawCwd,
        source: privatePayloadText,
      },
    });

    expect(res).toEqual({ status: 200, text: 'ok' });
    const serializedLogs = JSON.stringify(loggerDebugMock.mock.calls);
    expect(serializedLogs).not.toContain(privatePayloadText);
    expect(serializedLogs).not.toContain(rawTranscriptPath);
    expect(serializedLogs).not.toContain(rawCwd);
    expect(serializedLogs).toContain('[redacted-path]');
  });

  it('does not retain provider-supplied permission hook fields in debug logs', async () => {
    const privatePayloadText = 'private-permission-hook-payload-claim45';
    const rawTranscriptPath = join(tmpdir(), 'happier-secret-home', 'claude-permission.jsonl');
    const rawCwd = join(tmpdir(), 'happier-secret-home');
    const server = await startSessionHookServer({
      session: {
        providerId: 'claude',
        sessionId: 'happier-session-permission-redaction',
      },
      onPermissionHook: vi.fn(() => ({ continue: true, suppressOutput: true })),
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
      requestReadTimeoutMs: 20,
    });
    servers.push(server);
    loggerDebugMock.mockClear();

    const res = await postPermissionHook({
      port: server.port,
      body: {
        hook_event_name: 'PermissionRequest',
        session_id: privatePayloadText,
        transcript_path: rawTranscriptPath,
        cwd: rawCwd,
        permission_mode: privatePayloadText,
        tool_name: privatePayloadText,
        tool_use_id: privatePayloadText,
      },
    });

    expect(res.status).toBe(200);
    const serializedLogs = JSON.stringify(loggerDebugMock.mock.calls);
    expect(serializedLogs).not.toContain(privatePayloadText);
    expect(serializedLogs).not.toContain(rawTranscriptPath);
    expect(serializedLogs).not.toContain(rawCwd);
    expect(serializedLogs).toContain('[redacted-path]');
  });

  it('returns 403 when the session hook secret header is missing or mismatched', async () => {
    const onSessionHook = vi.fn();
    const options = {
      onSessionHook,
      sessionHookSecret: 'session-secret-1',
    } as Parameters<typeof startSessionHookServer>[0] & { sessionHookSecret: string };
    const server = await startSessionHookServer(options);
    servers.push(server);

    const missingSecret = await postSessionHook({
      port: server.port,
      body: { hook_event_name: 'SessionStart', session_id: 'provider-session-1' },
    });
    const wrongSecret = await postSessionHook({
      port: server.port,
      secret: 'wrong-secret',
      body: { hook_event_name: 'SessionStart', session_id: 'provider-session-1' },
    });

    expect(missingSecret.status).toBe(403);
    expect(wrongSecret.status).toBe(403);
    expect(onSessionHook).not.toHaveBeenCalled();
  });

  it('does not publish session hooks when the body completes after the read timeout', async () => {
    const onSessionHook = vi.fn();
    const publishHostEvent = vi.fn<(
      name: string,
      payload?: unknown,
    ) => Promise<void>>(async () => {});
    const server = await startSessionHookServer({
      session: {
        providerId: 'claude',
        sessionId: 'happy-timeout-session',
      },
      onSessionHook,
      publishHostEvent,
      requestReadTimeoutMs: 20,
    });
    servers.push(server);
    const request = await openIncompletePost({
      port: server.port,
      path: '/hook/session-start',
      body: {
        hook_event_name: 'SessionStart',
        session_id: 'provider-session-late-body',
      },
    });

    try {
      await expect(request.response).resolves.toContain('408');
      request.writeRest();
      await waitForLateHookProcessingWindow();

      expect(onSessionHook).not.toHaveBeenCalled();
      expect(publishHostEvent).not.toHaveBeenCalled();
    } finally {
      request.close();
    }
  });

  it('routes PostToolUse session hooks through the generic session hook endpoint', async () => {
    const onSessionHook = vi.fn();
    const server = await startSessionHookServer({
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

  it('forwards authenticated session lifecycle hooks with the hook event name preserved', async () => {
    const onSessionHook = vi.fn();
    const options = {
      onSessionHook,
      sessionHookSecret: 'session-forwarder-secret',
    } as Parameters<typeof startSessionHookServer>[0] & { sessionHookSecret: string };
    const server = await startSessionHookServer(options);
    servers.push(server);
    const secretFile = await createSecretFile('session-forwarder-secret');

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'UserPromptSubmit',
      secretFile,
      body: {
        session_id: 'sess_forwarded_1',
        prompt: 'typed in terminal',
      },
    });

    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(onSessionHook).toHaveBeenCalledWith('sess_forwarded_1', expect.objectContaining({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'typed in terminal',
    }));
  });

  it('keeps hook delivery non-controlling when the hook server rejects delivery', async () => {
    const server = await startSessionHookServer({
      sessionHookSecret: 'expected-session-forwarder-secret',
    } as Parameters<typeof startSessionHookServer>[0] & { sessionHookSecret: string });
    servers.push(server);
    const secretFile = await createSecretFile('wrong-session-forwarder-secret');

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'PostToolUse',
      secretFile,
      body: {
        session_id: 'sess_rejected_forwarder',
        tool_use_id: 'toolu_rejected_forwarder',
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('keeps hook delivery non-controlling when the hook server connection is refused', async () => {
    const server = await startSessionHookServer({});
    servers.push(server);
    const refusedPort = server.port;
    server.stop();
    await server.closed;
    const secretFile = await createSecretFile('unused-session-forwarder-secret');

    const result = await runSessionForwarder({
      port: refusedPort,
      hookEventName: 'SubagentStop',
      secretFile,
      body: {
        session_id: 'sess_unreachable_forwarder',
        agent_id: 'agent_unreachable_forwarder',
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('uses one attempt and exits successfully within the 500 ms total deadline when delivery hangs', async () => {
    let deliveryAttempts = 0;
    const server = await startSessionHookServer({
      onSessionHook: async () => {
        deliveryAttempts += 1;
        await new Promise(() => {});
      },
    });
    servers.push(server);
    const secretFile = await createSecretFile('unused-session-forwarder-secret');
    const startedAt = Date.now();

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'Stop',
      secretFile,
      body: {
        session_id: 'sess_hung_forwarder',
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(deliveryAttempts).toBe(1);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('drops oversized hook input before delivery without affecting the Agent', async () => {
    const onSessionHook = vi.fn();
    const server = await startSessionHookServer({ onSessionHook });
    servers.push(server);
    const secretFile = await createSecretFile('unused-session-forwarder-secret');

    const result = await runSessionForwarder({
      port: server.port,
      hookEventName: 'Stop',
      secretFile,
      body: {
        session_id: 'sess_oversized_forwarder',
        ignored: 'x'.repeat(1024 * 1024),
      },
    });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(onSessionHook).not.toHaveBeenCalled();
  });

  it('returns 403 when the permission secret header is missing or mismatched', async () => {
    const onPermissionHook = vi.fn(() => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest' as const,
        decision: { behavior: 'allow' as const },
      },
    }));

    const server = await startSessionHookServer({
      onPermissionHook,
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
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

  it('does not call permission hooks when the body completes after the read timeout', async () => {
    const onPermissionHook = vi.fn(async () => ({
      continue: true,
      suppressOutput: true,
    }));
    const server = await startSessionHookServer({
      onPermissionHook,
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
      requestReadTimeoutMs: 20,
    });
    servers.push(server);
    const request = await openIncompletePost({
      port: server.port,
      path: '/hook/permission-request',
      body: {
        tool_use_id: 'toolu_late_permission',
        tool_name: 'AskUserQuestion',
      },
    });

    try {
      await expect(request.response).resolves.toContain('408');
      request.writeRest();
      await waitForLateHookProcessingWindow();

      expect(onPermissionHook).not.toHaveBeenCalled();
    } finally {
      request.close();
    }
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

    const server = await startSessionHookServer({
      onPermissionHook,
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
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

  it('does not time out an interactive tool when the per-tool resolver returns null', async () => {
    const onPermissionHook = vi.fn(async () => {
      // Slower than the global 20ms cap; an interactive tool must not be cancelled.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          decision: { behavior: 'allow' as const },
        },
      };
    });

    const server = await startSessionHookServer({
      onPermissionHook,
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
      permissionHookSecret: 'secret-interactive',
      permissionRequestTimeoutMs: 20,
      permissionRequestTimeoutMsForTool: (toolName) =>
        toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion' ? null : undefined,
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-interactive',
      body: { tool_use_id: 'toolu_exit', tool_name: 'ExitPlanMode' },
    });

    expect(res.status).toBe(200);
    expect(onPermissionHook).toHaveBeenCalledTimes(1);
  });

  it('still applies the global timeout for non-interactive tools alongside a per-tool resolver', async () => {
    const onPermissionHook = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { continue: true, suppressOutput: true };
    });

    const server = await startSessionHookServer({
      onPermissionHook,
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
      permissionHookSecret: 'secret-noninteractive',
      permissionRequestTimeoutMs: 20,
      permissionRequestTimeoutMsForTool: (toolName) =>
        toolName === 'ExitPlanMode' ? null : undefined,
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-noninteractive',
      body: { tool_use_id: 'toolu_bash', tool_name: 'Bash' },
    });

    expect(res.status).toBe(408);
  });

  it('awaits asynchronous default responses and per-tool timeout resolution', async () => {
    const defaultPermissionHookResponse = vi.fn(async (data: Record<string, unknown>) => ({
      continue: true,
      suppressOutput: true,
      observedEvent: data.hook_event_name,
    }));
    const permissionRequestTimeoutMsForTool = vi.fn(async () => null);
    const server = await startSessionHookServer({
      defaultPermissionHookResponse,
      permissionRequestTimeoutMsForTool,
      permissionHookSecret: 'secret-async-resolvers',
      permissionRequestTimeoutMs: 1,
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-async-resolvers',
      body: {
        hook_event_name: 'PreToolUse',
        tool_name: 'ExitPlanMode',
      },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({
      observedEvent: 'PreToolUse',
    });
    expect(permissionRequestTimeoutMsForTool).toHaveBeenCalledWith('ExitPlanMode');
    expect(defaultPermissionHookResponse).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: 'PreToolUse' }),
    );
  });

  it('falls through to the canonical safe response when async resolvers reject', async () => {
    const server = await startSessionHookServer({
      defaultPermissionHookResponse: async () => {
        throw new Error('default response unavailable');
      },
      permissionRequestTimeoutMsForTool: async () => {
        throw new Error('timeout policy unavailable');
      },
      permissionHookSecret: 'secret-rejected-resolvers',
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-rejected-resolvers',
      body: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      continue: true,
      suppressOutput: true,
    });
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

    const server = await startSessionHookServer({
      onPermissionHook,
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
      permissionHookSecret: 'secret-3',
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-3',
      body: { tool_use_id: 'toolu_3', tool_name: 'Write' },
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as { hookSpecificOutput?: { decision?: { behavior?: string } } };
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

    const server = await startSessionHookServer({
      onPermissionHook,
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
      permissionHookSecret: 'secret-pre-tool-use',
    });
    servers.push(server);
    const secretFile = await createSecretFile('secret-pre-tool-use');

    const result = await runPermissionForwarder({
      port: server.port,
      hookEventName: 'PreToolUse',
      secretFile,
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
    }));
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          answers: { 'Remove the scratch files?': 'Keep for inspection' },
        },
      },
    });
  });

  it('preserves the parsed PreToolUse event name when permission handling throws', async () => {
    const server = await startSessionHookServer({
      onPermissionHook: async () => {
        throw new Error('permission handler failed');
      },
      defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
      permissionHookSecret: 'secret-pre-tool-use-fallback',
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-pre-tool-use-fallback',
      body: {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [] },
        tool_use_id: 'toolu_ask_pre_fallback_1',
      },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse' },
    });
  });

  describe('statusline hook endpoint', () => {
    async function postStatuslineHook(params: {
      port: number;
      secret?: string;
      rawBody?: string;
      body?: unknown;
    }): Promise<{ status: number; text: string }> {
      const res = await fetch(`http://127.0.0.1:${params.port}/hook/statusline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(params.secret ? { 'x-happier-hook-secret': params.secret } : {}),
        },
        body: params.rawBody ?? JSON.stringify(params.body),
      });
      return { status: res.status, text: await res.text() };
    }

    it('delivers statusline payloads to onStatuslineUpdate with unknown fields preserved', async () => {
      const onStatuslineUpdate = vi.fn();
      const server = await startSessionHookServer({
        sessionHookSecret: 'statusline-secret-1',
        onStatuslineUpdate,
      });
      servers.push(server);

      const res = await postStatuslineHook({
        port: server.port,
        secret: 'statusline-secret-1',
        body: {
          session_id: 'claude-session-statusline',
          model: { id: 'claude-fable-5', display_name: 'Fable 5' },
          context_window: { context_window_size: 1_000_000 },
          some_future_field: { nested: true },
        },
      });

      expect(res.status).toBe(200);
      expect(onStatuslineUpdate).toHaveBeenCalledTimes(1);
      expect(onStatuslineUpdate).toHaveBeenCalledWith(expect.objectContaining({
        session_id: 'claude-session-statusline',
        model: { id: 'claude-fable-5', display_name: 'Fable 5' },
        some_future_field: { nested: true },
      }));
    });

    it('does not retain provider-supplied statusline fields in debug logs', async () => {
      const privatePayloadText = 'private-statusline-hook-payload-claim45';
      const rawTranscriptPath = join(tmpdir(), privatePayloadText, 'claude-statusline.jsonl');
      const onStatuslineUpdate = vi.fn();
      const server = await startSessionHookServer({
        session: {
          providerId: 'claude',
          sessionId: 'happier-session-statusline-redaction',
        },
        sessionHookSecret: 'statusline-secret-redaction',
        onStatuslineUpdate,
      });
      servers.push(server);
      loggerDebugMock.mockClear();

      const res = await postStatuslineHook({
        port: server.port,
        secret: 'statusline-secret-redaction',
        body: {
          session_id: privatePayloadText,
          transcript_path: rawTranscriptPath,
          model: { id: privatePayloadText },
        },
      });

      expect(res.status).toBe(200);
      expect(onStatuslineUpdate).toHaveBeenCalledTimes(1);
      const serializedLogs = JSON.stringify(loggerDebugMock.mock.calls);
      expect(serializedLogs).not.toContain(privatePayloadText);
      expect(serializedLogs).not.toContain(rawTranscriptPath);
      expect(serializedLogs).toContain('[redacted-path]');
    });

    it('returns 403 when the statusline secret header is missing or mismatched', async () => {
      const onStatuslineUpdate = vi.fn();
      const server = await startSessionHookServer({
        sessionHookSecret: 'statusline-secret-2',
        onStatuslineUpdate,
      });
      servers.push(server);

      const missing = await postStatuslineHook({ port: server.port, body: { session_id: 'x' } });
      const mismatched = await postStatuslineHook({
        port: server.port,
        secret: 'wrong-secret',
        body: { session_id: 'x' },
      });

      expect(missing.status).toBe(403);
      expect(mismatched.status).toBe(403);
      expect(onStatuslineUpdate).not.toHaveBeenCalled();
    });

    it('responds 200 without invoking the consumer for malformed payloads', async () => {
      const onStatuslineUpdate = vi.fn();
      const server = await startSessionHookServer({
        sessionHookSecret: 'statusline-secret-3',
        onStatuslineUpdate,
      });
      servers.push(server);

      const res = await postStatuslineHook({
        port: server.port,
        secret: 'statusline-secret-3',
        rawBody: '{not json',
      });

      expect(res.status).toBe(200);
      expect(onStatuslineUpdate).not.toHaveBeenCalled();
    });

    it('responds 200 when the statusline consumer throws', async () => {
      const server = await startSessionHookServer({
        sessionHookSecret: 'statusline-secret-4',
        onStatuslineUpdate: () => {
          throw new Error('consumer failed');
        },
      });
      servers.push(server);

      const res = await postStatuslineHook({
        port: server.port,
        secret: 'statusline-secret-4',
        body: { session_id: 'x', model: { id: 'claude-fable-5' } },
      });

      expect(res.status).toBe(200);
    });
  });

  describe('statusline forwarder script', () => {
    async function runStatuslineForwarder(params: {
      args: readonly string[];
      body: unknown;
    }): Promise<{ code: number | null; stdout: string; stderr: string }> {
      const scriptPath = resolve(process.cwd(), 'scripts', 'statusline_forwarder.cjs');
      return await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [scriptPath, ...params.args], {
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
        child.stdin.end(typeof params.body === 'string' ? params.body : JSON.stringify(params.body));
      });
    }

    const statuslinePayload = {
      session_id: 'claude-session-forwarder',
      model: { id: 'claude-fable-5', display_name: 'Fable 5' },
      context_window: { context_window_size: 1_000_000 },
    };

    it('POSTs the payload with the secret read from the secret file (never from argv) and exec-chains the original', async () => {
      const onStatuslineUpdate = vi.fn();
      const server = await startSessionHookServer({
        sessionHookSecret: 'forwarder-secret-file-only',
        onStatuslineUpdate,
      });
      servers.push(server);
      const secretFile = await createSecretFile('forwarder-secret-file-only');

      const originalCommand = `${JSON.stringify(process.execPath)} -e "let b='';process.stdin.on('data',(c)=>{b+=c});process.stdin.on('end',()=>{const p=JSON.parse(b);process.stdout.write('original:'+p.model.id+'\\n');process.exit(7)})"`;
      const args = [
        String(server.port),
        '--secret-file',
        secretFile,
        '--original-b64',
        Buffer.from(originalCommand, 'utf8').toString('base64'),
      ];
      expect(args.join(' ')).not.toContain('forwarder-secret-file-only');

      const result = await runStatuslineForwarder({ args, body: statuslinePayload });
      await waitForLateHookProcessingWindow();

      expect(result.stdout).toContain('original:claude-fable-5');
      // F7: a non-zero chained exit must NOT pass through — Claude Code flags a failing
      // statusLine command as a setup issue and stops invoking it, permanently killing the
      // statusline truth feed to Happier. Chain output still passes through untouched.
      expect(result.code).toBe(0);
      expect(onStatuslineUpdate).toHaveBeenCalledTimes(1);
      expect(onStatuslineUpdate).toHaveBeenCalledWith(expect.objectContaining({
        session_id: 'claude-session-forwarder',
      }));
    });

    it('prints a minimal model line when no original statusline is configured', async () => {
      const server = await startSessionHookServer({
        sessionHookSecret: 'forwarder-secret-fallback',
        onStatuslineUpdate: vi.fn(),
      });
      servers.push(server);
      const secretFile = await createSecretFile('forwarder-secret-fallback');

      const result = await runStatuslineForwarder({
        args: [String(server.port), '--secret-file', secretFile],
        body: statuslinePayload,
      });

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('Fable 5');
      expect(result.stderr).toBe('');
    });

    it('still renders when the hook server is unreachable (fail-open)', async () => {
      const result = await runStatuslineForwarder({
        args: ['1', '--secret-file', '/nonexistent/secret'],
        body: statuslinePayload,
      });

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('Fable 5');
      expect(result.stderr).toBe('');
    });

    it('treats an undecodable original as absent instead of exec-ing garbage', async () => {
      const result = await runStatuslineForwarder({
        args: ['1', '--original-b64', '!!!not-base64!!!'],
        body: statuslinePayload,
      });

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('Fable 5');
    });

    it('falls back to a generic label for unparseable payloads', async () => {
      const result = await runStatuslineForwarder({
        args: ['1'],
        body: 'this is not json',
      });

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('Claude');
    });
  });
});
