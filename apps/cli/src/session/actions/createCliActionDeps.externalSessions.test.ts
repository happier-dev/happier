import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const configurationBoundary = vi.hoisted(() => ({
  activeServerDir: '/tmp/happier-external-session-action-unset',
}));

vi.mock('@/configuration', () => ({ configuration: configurationBoundary }));

import { createCliActionDeps } from './createCliActionDeps';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('createCliActionDeps External Session bindings', () => {
  it('routes hook management through the daemon-composed External Sessions owner', async () => {
    const hookManagementAction = vi.fn(async () => ({
      ok: true as const,
      result: {
        ok: true as const,
        rows: [],
        nextCursor: null,
        diagnostics: [],
      },
    }));
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      externalSessionPluginAdmissionOwner: { hookManagementAction },
    });

    await expect(deps.pluginSessionHookManagementAction?.({
      actionId: 'plugins.sessionHooks.status.get',
      input: { intent: 'passive_inventory' },
    })).resolves.toEqual({
      ok: true,
      rows: [],
      nextCursor: null,
      diagnostics: [],
    });
    expect(hookManagementAction).toHaveBeenCalledWith(
      'plugins.sessionHooks.status.get',
      { intent: 'passive_inventory' },
      { surface: 'action' },
    );
  });

  it('passes the daemon-composed private materialize Start into the plugin action consumer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-plugin-materialize-action-'));
    roots.push(activeServerDir);
    configurationBoundary.activeServerDir = activeServerDir;
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const materializeStart = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      externalSessionPluginAdmissionOwner: { materializeStart },
    });

    const result = await deps.externalSessionAction?.({
      actionId: 'sessions.external.materialize.start',
      input: {
        request: {
          v: 1,
          idempotencyKey: 'caller-key',
          sessionId: 'session-1',
          plan: 'materialize',
          targetStorageMode: 'external-linked',
          targetRuntimeMode: null,
        },
      },
      pluginId: 'author.example',
    });

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        error: { code: 'internal_error', message: 'fixture' },
      },
    });
    expect(materializeStart).toHaveBeenCalledWith({
      sessionId: 'session-1',
      durableIdempotencyKey: expect.stringMatching(
        /^plugin-operation:v1:[0-9a-f]{64}$/,
      ),
      authorIntent: {
        v: 1,
        surface: 'plugin',
        kind: 'materialize',
        sessionId: 'session-1',
        targetStorageMode: 'external-linked',
      },
    });
  });
});
