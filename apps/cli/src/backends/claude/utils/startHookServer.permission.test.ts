import { afterEach, describe, expect, it, vi } from 'vitest';

import { startHookServer } from './startHookServer';

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

describe('startHookServer (permission hook)', () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
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
});
