import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_PROVIDER_HOOK_EVENT_ID_V1,
  SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1,
} from '@happier-dev/protocol';

import { createPluginTranscriptFileFollowService } from '../../context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '../../context/transcripts/fileFollowGrants';
import { logger } from '@/ui/logger';
import { createSessionHooksService, disposeSessionHookArtifactsForSession } from './service';

function hasSessionHooksCapability(capability: string): boolean {
  return capability === 'sessionHooks' || capability === 'session.hooks.control';
}

async function postSessionHook(params: {
  port: number;
  body: unknown;
  sessionHookSecret?: string;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${params.port}/hook/session-start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.sessionHookSecret ? { 'x-happier-hook-secret': params.sessionHookSecret } : {}),
    },
    body: JSON.stringify(params.body),
  });
  return { status: res.status, text: await res.text() };
}

describe('createSessionHooksService', () => {
  it('lets session runtimes dispose hook server secret files directly', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const disposables: Array<{ dispose(): Promise<void> | void }> = [];
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      addDisposable: (dispose) => {
        disposables.push(dispose);
      },
    });

    const server = await service.startServer({
      providerId: 'claude',
      sessionId: 'happier-session-cleanup',
      sessionHookSecret: 'session-secret-service',
      permissionHookSecret: 'permission-secret-service',
    });

    expect(server.sessionHookSecretFile).toContain(join(happyHomeDir, 'tmp'));
    expect(server.permissionHookSecretFile).toContain(join(happyHomeDir, 'tmp'));
    await expect(readFile(server.sessionHookSecretFile!, 'utf8')).resolves.toBe('session-secret-service');
    await expect(readFile(server.permissionHookSecretFile!, 'utf8')).resolves.toBe('permission-secret-service');
    if (process.platform !== 'win32') {
      expect((await stat(server.sessionHookSecretFile!)).mode & 0o777).toBe(0o600);
      expect((await stat(server.permissionHookSecretFile!)).mode & 0o777).toBe(0o600);
    }
    expect(disposables).toHaveLength(1);
    await server.dispose();
    for (const disposable of disposables) await disposable.dispose();
    await expect(stat(server.sessionHookSecretFile!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(server.permissionHookSecretFile!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims one session-scoped hook endpoint with stable secrets across runner services', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    try {
      const firstService = createSessionHooksService({
        happyHomeDir,
        hasCapability: hasSessionHooksCapability,
      });
      const first = await firstService.startServer({
        providerId: 'claude',
        sessionId: 'happy-session-stable-endpoint',
        lifecycle: { kind: 'session', sessionId: 'happy-session-stable-endpoint' },
        sessionHookSecret: 'first-session-secret',
        permissionHookSecret: 'first-permission-secret',
      } as Parameters<typeof firstService.startServer>[0] & {
        lifecycle: { kind: 'session'; sessionId: string };
      });
      const firstPort = first.port;
      const firstSessionSecretFile = first.sessionHookSecretFile!;
      const firstPermissionSecretFile = first.permissionHookSecretFile!;
      await first.dispose();

      await expect(readFile(firstSessionSecretFile, 'utf8')).resolves.toBe('first-session-secret');
      await expect(readFile(firstPermissionSecretFile, 'utf8')).resolves.toBe('first-permission-secret');

      const secondService = createSessionHooksService({
        happyHomeDir,
        hasCapability: hasSessionHooksCapability,
      });
      const second = await secondService.startServer({
        providerId: 'claude',
        sessionId: 'happy-session-stable-endpoint',
        lifecycle: { kind: 'session', sessionId: 'happy-session-stable-endpoint' },
        sessionHookSecret: 'replacement-session-secret',
        permissionHookSecret: 'replacement-permission-secret',
      } as Parameters<typeof secondService.startServer>[0] & {
        lifecycle: { kind: 'session'; sessionId: string };
      });

      expect(second.port).toBe(firstPort);
      expect(second.sessionHookSecretFile).toBe(firstSessionSecretFile);
      expect(second.permissionHookSecretFile).toBe(firstPermissionSecretFile);
      await expect(readFile(second.sessionHookSecretFile!, 'utf8')).resolves.toBe('first-session-secret');
      await expect(postSessionHook({
        port: second.port,
        sessionHookSecret: 'first-session-secret',
        body: { session_id: 'provider-session-stable' },
      })).resolves.toEqual({ status: 200, text: 'ok' });
      await expect(postSessionHook({
        port: second.port,
        sessionHookSecret: 'replacement-session-secret',
        body: { session_id: 'provider-session-stable' },
      })).resolves.toEqual({ status: 403, text: 'forbidden' });

      await second.dispose();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('closes a newly bound session-scoped hook server when endpoint persistence fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    try {
      const firstService = createSessionHooksService({
        happyHomeDir,
        hasCapability: hasSessionHooksCapability,
      });
      const first = await firstService.startServer({
        providerId: 'claude',
        sessionId: 'happy-session-endpoint-write-failure',
        lifecycle: { kind: 'session', sessionId: 'happy-session-endpoint-write-failure' },
        sessionHookSecret: 'stable-session-secret',
      } as Parameters<typeof firstService.startServer>[0] & {
        lifecycle: { kind: 'session'; sessionId: string };
      });
      const sessionRoot = dirname(dirname(first.sessionHookSecretFile!));
      await first.dispose();
      await rm(join(sessionRoot, 'endpoint.json'), { force: true });
      await mkdir(join(sessionRoot, 'endpoint.json'));

      const readActiveHandles = Reflect.get(process, '_getActiveHandles') as (() => unknown[]) | undefined;
      const activeServersBefore = new Set(
        (readActiveHandles?.() ?? []).filter((handle) => (
          typeof handle === 'object'
          && handle !== null
          && Reflect.get(Reflect.get(handle, 'constructor') ?? {}, 'name') === 'Server'
        )),
      );
      const replacementService = createSessionHooksService({
        happyHomeDir,
        hasCapability: hasSessionHooksCapability,
      });

      await expect(replacementService.startServer({
        providerId: 'claude',
        sessionId: 'happy-session-endpoint-write-failure',
        lifecycle: { kind: 'session', sessionId: 'happy-session-endpoint-write-failure' },
        sessionHookSecret: 'replacement-session-secret',
      } as Parameters<typeof replacementService.startServer>[0] & {
        lifecycle: { kind: 'session'; sessionId: string };
      })).rejects.toBeDefined();

      const leakedServers = (readActiveHandles?.() ?? []).filter((handle) => (
        typeof handle === 'object'
        && handle !== null
        && Reflect.get(Reflect.get(handle, 'constructor') ?? {}, 'name') === 'Server'
        && Reflect.get(handle, '_handle') !== null
        && !activeServersBefore.has(handle)
      ));
      expect(leakedServers).toEqual([]);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('removes retained session-scoped servers, secrets, and plugin files at final session cleanup', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    try {
      const service = createSessionHooksService({
        happyHomeDir,
        hasCapability: hasSessionHooksCapability,
      });
      const server = await service.startServer({
        providerId: 'claude',
        sessionId: 'happy-session-final-cleanup',
        lifecycle: { kind: 'session', sessionId: 'happy-session-final-cleanup' },
        sessionHookSecret: 'session-secret-final-cleanup',
      } as Parameters<typeof service.startServer>[0] & {
        lifecycle: { kind: 'session'; sessionId: string };
      });
      const pluginDir = await service.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId: 'happy-session-final-cleanup' },
        files: [
          { path: '.claude-plugin/plugin.json', json: { name: 'happier-final-cleanup' } },
          { path: 'hooks/hooks.json', json: { hooks: {} } },
        ],
      });
      await server.dispose();
      await service.disposePluginDir(pluginDir);
      await expect(stat(server.sessionHookSecretFile!)).resolves.toBeDefined();
      await expect(stat(pluginDir)).resolves.toBeDefined();

      await disposeSessionHookArtifactsForSession({
        happyHomeDir,
        sessionId: 'happy-session-final-cleanup',
      });

      await expect(stat(server.sessionHookSecretFile!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(pluginDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('resolves the statusline forwarder asset and forwards statusline payloads to the runtime consumer', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
    });

    const assets = await service.resolveForwarderAssets();
    expect(assets.statuslineForwarderScript).toContain('statusline_forwarder.cjs');

    const received: unknown[] = [];
    const server = await service.startServer({
      providerId: 'claude',
      sessionId: 'happier-session-statusline',
      sessionHookSecret: 'statusline-service-secret',
      onStatuslineUpdate: (data) => {
        received.push(data);
      },
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/hook/statusline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-happier-hook-secret': 'statusline-service-secret',
      },
      body: JSON.stringify({ session_id: 'claude-x', model: { id: 'claude-fable-5' } }),
    });

    expect(res.status).toBe(200);
    expect(received).toEqual([expect.objectContaining({ session_id: 'claude-x' })]);
    await server.dispose();
  });

  it('lets session runtimes dispose hook plugin dirs directly', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const disposables: Array<{ dispose(): Promise<void> | void }> = [];
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      addDisposable: (dispose) => {
        disposables.push(dispose);
      },
    });

    const pluginDir = await service.createPluginDir({
      providerId: 'claude',
      files: [
        {
          path: '.claude-plugin/plugin.json',
          json: { name: 'happier-session-hooks-test' },
        },
        {
          path: 'hooks/hooks.json',
          json: { hooks: {} },
        },
      ],
    });

    expect(pluginDir).toContain(join(happyHomeDir, 'tmp'));
    await expect(readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain(
      'happier-session-hooks-test',
    );
    await expect(readFile(join(pluginDir, 'hooks', 'hooks.json'), 'utf8')).resolves.toContain('"hooks"');
    if (process.platform !== 'win32') {
      expect((await stat(pluginDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(pluginDir, '.claude-plugin'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(pluginDir, 'hooks'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(pluginDir, '.claude-plugin', 'plugin.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(pluginDir, 'hooks', 'hooks.json'))).mode & 0o777).toBe(0o600);
    }

    await service.disposePluginDir(pluginDir);
    for (const disposable of disposables) await disposable.dispose();
    await expect(stat(pluginDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps session-scoped hook plugin dirs stable across runner cleanup', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const disposables: Array<{ dispose(): Promise<void> | void }> = [];
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      addDisposable: (dispose) => {
        disposables.push(dispose);
      },
    });
    const createdDirs: string[] = [];

    try {
      const firstPluginDir = await service.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId: 'cmr3dpuka06zhtmtpaa1af5gh' },
        files: [
          { path: '.claude-plugin/plugin.json', json: { name: 'happier-session-hooks-stable-v1' } },
          { path: 'hooks/hooks.json', json: { hooks: { PreToolUse: [] } } },
        ],
      });
      createdDirs.push(firstPluginDir);
      const secondPluginDir = await service.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId: 'cmr3dpuka06zhtmtpaa1af5gh' },
        files: [
          { path: '.claude-plugin/plugin.json', json: { name: 'happier-session-hooks-stable-v2' } },
          { path: 'hooks/hooks.json', json: { hooks: { UserPromptSubmit: [] } } },
        ],
      });
      createdDirs.push(secondPluginDir);

      expect(secondPluginDir).toBe(firstPluginDir);
      expect(firstPluginDir).toContain('claude-session-cmr3dpuka06zhtmtpaa1af5gh');
      await expect(readFile(join(firstPluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain(
        'happier-session-hooks-stable-v2',
      );

      await service.disposePluginDir(firstPluginDir);
      for (const disposable of disposables) await disposable.dispose();
      await expect(readFile(join(firstPluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain(
        'happier-session-hooks-stable-v2',
      );
    } finally {
      for (const pluginDir of new Set(createdDirs)) {
        await rm(pluginDir, { recursive: true, force: true });
      }
    }
  });

  it('preserves a previous session-scoped hook plugin dir when regeneration fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
    });
    let pluginDir: string | null = null;

    try {
      pluginDir = await service.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId: 'cmr3dpuka06zhtmtpaa1af5gh' },
        files: [
          { path: '.claude-plugin/plugin.json', json: { name: 'happier-session-hooks-stable-v1' } },
          { path: 'hooks/hooks.json', json: { hooks: { PreToolUse: [] } } },
        ],
      });

      await expect(service.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId: 'cmr3dpuka06zhtmtpaa1af5gh' },
        files: [
          { path: '.claude-plugin/plugin.json', json: { name: 'happier-session-hooks-stable-broken' } },
          { path: '../escape.json', json: { invalid: true } },
        ],
      })).rejects.toThrow(/Invalid session hook plugin file path/);

      await expect(readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain(
        'happier-session-hooks-stable-v1',
      );
      await expect(readFile(join(pluginDir, 'hooks', 'hooks.json'), 'utf8')).resolves.toContain('PreToolUse');
    } finally {
      if (pluginDir) await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it('atomically replaces the complete session-scoped hook plugin file set', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
    });
    try {
      const pluginDir = await service.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId: 'happy-session-exact-plugin-files' },
        files: [
          { path: '.claude-plugin/plugin.json', json: { name: 'happier-exact-v1' } },
          { path: 'hooks/hooks.json', json: { hooks: { PreToolUse: [] } } },
          { path: 'obsolete.txt', contents: 'remove me' },
        ],
      });
      await service.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId: 'happy-session-exact-plugin-files' },
        files: [
          { path: '.claude-plugin/plugin.json', json: { name: 'happier-exact-v2' } },
          { path: 'hooks/hooks.json', json: { hooks: { UserPromptSubmit: [] } } },
        ],
      });

      await expect(readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain(
        'happier-exact-v2',
      );
      await expect(stat(join(pluginDir, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await disposeSessionHookArtifactsForSession({
        happyHomeDir,
        sessionId: 'happy-session-exact-plugin-files',
      });
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('rejects hook plugin dir cleanup for paths not created by the service', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const service = createSessionHooksService({ happyHomeDir, hasCapability: hasSessionHooksCapability });
    const pluginDir = await service.createPluginDir({
      providerId: 'claude',
      files: [{ path: '.claude-plugin/plugin.json', json: { name: 'owned-plugin' } }],
    });
    const pluginRoot = dirname(pluginDir);
    await service.disposePluginDir(pluginDir);

    const unownedInsideRoot = join(pluginRoot, 'not-created-by-service');
    await mkdir(unownedInsideRoot, { recursive: true });
    await writeFile(join(unownedInsideRoot, 'marker.txt'), 'inside-root', 'utf8');
    await expect(service.disposePluginDir(unownedInsideRoot)).rejects.toThrow(/not owned/);
    await expect(readFile(join(unownedInsideRoot, 'marker.txt'), 'utf8')).resolves.toBe('inside-root');

    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-session-hooks-outside-'));
    await writeFile(join(outsideRoot, 'marker.txt'), 'outside-root', 'utf8');
    await expect(service.disposePluginDir(outsideRoot)).rejects.toThrow(/not owned/);
    await expect(readFile(join(outsideRoot, 'marker.txt'), 'utf8')).resolves.toBe('outside-root');
  });

  it('requires the session hook runtime capability and control permission for host hook surfaces', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: (capability: string) => capability === 'sessionHooks',
    } as Parameters<typeof createSessionHooksService>[0] & {
      hasCapability: (capability: string) => boolean;
    });

    await expect(service.startServer({
      providerId: 'claude',
      sessionId: 'happy-session-denied',
    })).rejects.toMatchObject({ code: 'PLUGIN_SESSION_HOOKS_CAPABILITY_REQUIRED' });
    await expect(service.createPluginDir({
      providerId: 'claude',
      files: [{ path: '.claude-plugin/plugin.json', json: { name: 'denied-plugin' } }],
    })).rejects.toMatchObject({ code: 'PLUGIN_SESSION_HOOKS_CAPABILITY_REQUIRED' });
    await expect(service.publishProviderTranscript({
      providerId: 'claude',
      sessionId: 'happy-session-denied',
      kind: 'assistant_stop',
      providerPayload: { type: 'assistant' },
    })).rejects.toMatchObject({ code: 'PLUGIN_SESSION_HOOKS_CAPABILITY_REQUIRED' });
  });

  it('removes partially created hook plugin dirs when creation fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const service = createSessionHooksService({ happyHomeDir, hasCapability: hasSessionHooksCapability });
    const pluginDir = await service.createPluginDir({
      providerId: 'claude',
      files: [{ path: '.claude-plugin/plugin.json', json: { name: 'root-marker' } }],
    });
    const pluginRoot = dirname(pluginDir);
    await service.disposePluginDir(pluginDir);
    const beforeFailure = await readdir(pluginRoot);

    await expect(service.createPluginDir({
      providerId: 'claude',
      files: [
        { path: '.claude-plugin/plugin.json', json: { name: 'partial-plugin' } },
        { path: '../escape.json', json: { invalid: true } },
      ],
    })).rejects.toThrow(/Invalid session hook plugin file path/);

    await expect(readdir(pluginRoot)).resolves.toEqual(beforeFailure);
  });

  it('publishes provider transcript evidence through the host session event seam', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const published: Array<Readonly<{ name: string; payload: unknown }>> = [];
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      publishHostEvent: async (name: string, payload?: unknown) => {
        published.push({ name, payload });
      },
    } as Parameters<typeof createSessionHooksService>[0] & {
      publishHostEvent: (name: string, payload?: unknown) => Promise<void>;
    });
    const transcriptPublisher = service as unknown as {
      publishProviderTranscript?: (payload: unknown) => Promise<void>;
    };

    expect(transcriptPublisher.publishProviderTranscript).toBeTypeOf('function');
    await transcriptPublisher.publishProviderTranscript?.({
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-provider-session-1',
      kind: 'assistant_stop',
      stopReason: 'end_turn',
      providerPayload: { type: 'assistant' },
    });

    expect(published).toEqual([
      {
        name: SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1,
        payload: {
          providerId: 'claude',
          sessionId: 'happy-session-1',
          providerSessionId: 'claude-provider-session-1',
          kind: 'assistant_stop',
          stopReason: 'end_turn',
          providerPayload: { type: 'assistant' },
        },
      },
    ]);
  });

  it('publishes provider lifecycle hooks through the service host event publisher', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const published: Array<Readonly<{ name: string; payload: unknown }>> = [];
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      publishHostEvent: async (name: string, payload?: unknown) => {
        published.push({ name, payload });
      },
    });

    const server = await service.startServer({
      providerId: 'claude',
      sessionId: 'happy-session-hook-publisher',
    });

    try {
      const response = await postSessionHook({
        port: server.port,
        body: {
          hook_event_name: 'SessionStart',
          session_id: 'claude-provider-session-hook-publisher',
          transcript_path: '/tmp/claude-hook-publisher.jsonl',
        },
      });

      expect(response).toEqual({ status: 200, text: 'ok' });
      expect(published).toEqual([
        {
          name: SESSION_PROVIDER_HOOK_EVENT_ID_V1,
          payload: {
            providerId: 'claude',
            sessionId: 'happy-session-hook-publisher',
            providerSessionId: 'claude-provider-session-hook-publisher',
            eventName: 'SessionStart',
            providerPayload: {
              hook_event_name: 'SessionStart',
              session_id: 'claude-provider-session-hook-publisher',
              transcript_path: '/tmp/claude-hook-publisher.jsonl',
            },
          },
        },
      ]);
    } finally {
      server.stop();
    }
  });

  it('grants trusted SessionStart transcript paths before invoking the plugin hook callback', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-transcript-'));
    const transcriptPath = join(transcriptDir, 'provider-session.jsonl');
    await writeFile(transcriptPath, '{"kind":"ready"}\n', 'utf8');

    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    const fileFollow = createPluginTranscriptFileFollowService({
      pluginId: 'acme.sample',
      runtimeId: 'runtime-1',
      readSessionId: () => 'happy-session-grant',
      fileFollowPathGrants,
    });
    const grantRequests: unknown[] = [];
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      grantTranscriptFileFollowPath: async (request: Readonly<{
        providerSessionId: string;
        sessionId: string;
        transcriptPath: string;
      }>) => {
        grantRequests.push(request);
        await fileFollowPathGrants.grant({
          pluginId: 'acme.sample',
          runtimeId: 'runtime-1',
          sessionId: request.sessionId,
          path: request.transcriptPath,
          reason: 'providerTranscriptSource',
          evidence: {
            kind: 'sessionStartTranscriptPath',
            providerSessionId: request.providerSessionId,
          },
        });
      },
    } as Parameters<typeof createSessionHooksService>[0] & {
      grantTranscriptFileFollowPath: (request: Readonly<{
        providerSessionId: string;
        sessionId: string;
        transcriptPath: string;
      }>) => Promise<void>;
    });

    const followedLines: string[] = [];
    let followError: unknown = null;
    const server = await service.startServer({
      providerId: 'claude',
      sessionId: 'happy-session-grant',
      sessionHookSecret: 'trusted-session-hook-secret',
      onSessionHook: async (_providerSessionId, data) => {
        try {
          const handle = await fileFollow.follow({
            path: String(data.transcript_path),
            startAt: 'beginning',
            onLine: (line) => {
              followedLines.push(line.line);
            },
          });
          await handle.drainNow();
          await handle.close();
        } catch (error) {
          followError = error;
        }
      },
    });

    try {
      await expect(postSessionHook({
        port: server.port,
        body: {
          hook_event_name: 'SessionStart',
          session_id: 'provider-session-1',
          transcript_path: transcriptPath,
        },
        sessionHookSecret: 'trusted-session-hook-secret',
      })).resolves.toEqual({ status: 200, text: 'ok' });

      expect(followError).toBeNull();
      expect(followedLines).toEqual(['{"kind":"ready"}']);
      expect(grantRequests).toEqual([
        expect.objectContaining({
          providerId: 'claude',
          sessionId: 'happy-session-grant',
          providerSessionId: 'provider-session-1',
          eventName: 'SessionStart',
          transcriptPath,
        }),
      ]);
    } finally {
      server.stop();
    }
  });

  it('does not pass hostile transcript-grant failures to retained logging', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const privateTranscript = 'private grant transcript that must not enter logs';
    const hostileFailure = {
      toJSON: () => ({ privateTranscript }),
      toString: () => privateTranscript,
    };
    const logDebug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      grantTranscriptFileFollowPath: async () => {
        throw hostileFailure;
      },
    } as Parameters<typeof createSessionHooksService>[0] & {
      grantTranscriptFileFollowPath: () => Promise<void>;
    });
    const server = await service.startServer({
      providerId: 'claude',
      sessionId: 'happy-session-hostile-grant',
      sessionHookSecret: 'trusted-session-hook-secret',
      onSessionHook: vi.fn(),
    });

    try {
      await expect(postSessionHook({
        port: server.port,
        body: {
          hook_event_name: 'SessionStart',
          session_id: 'provider-session-hostile-grant',
          transcript_path: '/tmp/private-provider-transcript.jsonl',
        },
        sessionHookSecret: 'trusted-session-hook-secret',
      })).resolves.toEqual({ status: 200, text: 'ok' });

      expect(logDebug).toHaveBeenCalledWith(
        '[sessionHookServer] Session hook transcript grant failed',
      );
    } finally {
      server.stop();
      logDebug.mockRestore();
    }
  });

  it('does not grant SessionStart transcript paths from unauthenticated hook servers', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-'));
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-session-hooks-transcript-'));
    const transcriptPath = join(transcriptDir, 'provider-session.jsonl');
    await writeFile(transcriptPath, '{"kind":"ready"}\n', 'utf8');

    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    const fileFollow = createPluginTranscriptFileFollowService({
      pluginId: 'acme.sample',
      runtimeId: 'runtime-1',
      readSessionId: () => 'happy-session-untrusted',
      fileFollowPathGrants,
    });
    const grantRequests: unknown[] = [];
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: hasSessionHooksCapability,
      grantTranscriptFileFollowPath: async (request: Readonly<{
        providerSessionId: string;
        sessionId: string;
        transcriptPath: string;
      }>) => {
        grantRequests.push(request);
        await fileFollowPathGrants.grant({
          pluginId: 'acme.sample',
          runtimeId: 'runtime-1',
          sessionId: request.sessionId,
          path: request.transcriptPath,
          reason: 'providerTranscriptSource',
          evidence: {
            kind: 'sessionStartTranscriptPath',
            providerSessionId: request.providerSessionId,
          },
        });
      },
    } as Parameters<typeof createSessionHooksService>[0] & {
      grantTranscriptFileFollowPath: (request: Readonly<{
        providerSessionId: string;
        sessionId: string;
        transcriptPath: string;
      }>) => Promise<void>;
    });

    let followError: unknown = null;
    const server = await service.startServer({
      providerId: 'claude',
      sessionId: 'happy-session-untrusted',
      onSessionHook: async (_providerSessionId, data) => {
        try {
          const handle = await fileFollow.follow({
            path: String(data.transcript_path),
            startAt: 'beginning',
            onLine: () => undefined,
          });
          await handle.close();
        } catch (error) {
          followError = error;
        }
      },
    });

    try {
      await expect(postSessionHook({
        port: server.port,
        body: {
          hook_event_name: 'SessionStart',
          session_id: 'provider-session-1',
          transcript_path: transcriptPath,
        },
      })).resolves.toEqual({ status: 200, text: 'ok' });

      expect(grantRequests).toEqual([]);
      expect(followError).toMatchObject({
        code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED',
      });
    } finally {
      server.stop();
    }
  });
});
