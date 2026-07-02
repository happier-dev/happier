import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExternalSessionFileFollowInputV1 } from '@happier-dev/agents';
import type { PluginContextV1, PluginDisposable } from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
  tempDirs.add(path);
  return path;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function createPluginContext(fileFollow: Readonly<{
  follow(input: ExternalSessionFileFollowInputV1): Promise<Readonly<{
    id: string;
    drainNow(): Promise<void>;
    close(): Promise<void>;
  }>>;
}>): PluginContextV1 {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    transcripts: {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(),
      fileFollow,
    },
  } as unknown as PluginContextV1;
  // Test fixture supplies only the plugin services consumed by the OhMyPi engine.
}

describe('OhMyPi plugin activation external sessions', () => {
  it('registers a backend engine whose external-session follow lease uses ctx.transcripts.fileFollow', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-plugin-follow-')));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const remoteSessionId = 'omp-session-one';
    const filePath = join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`);
    const sessionHeader = {
      type: 'session',
      id: remoteSessionId,
      timestamp: '2026-04-10T10:00:00.000Z',
      cwd: '/repo/ohmypi',
      title: 'OhMyPi plugin follow',
    };
    const firstMessage = {
      type: 'message',
      id: 'assistant-1',
      parentId: null,
      timestamp: '2026-04-10T10:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'initial message' }] },
    };
    await writeFile(filePath, [jsonlLine(sessionHeader), jsonlLine(firstMessage)].join(''), 'utf8');
    const realFilePath = await realpath(filePath);

    const registrations: BundledRegisterBackendEngineV1[] = [];
    activate({
      registerBackendEngine: (registration) => {
        registrations.push(registration);
        return { dispose: vi.fn() } satisfies PluginDisposable;
      },
    });

    expect(registrations.map((registration) => registration.backendId)).toEqual(['ohMyPi']);

    let followInput: ExternalSessionFileFollowInputV1 | null = null;
    const ctx = createPluginContext({
      follow: vi.fn(async (input) => {
        followInput = input;
        return {
          id: 'follow-1',
          drainNow: vi.fn(async () => {
            await input.onLine({ line: jsonlLine(sessionHeader).trimEnd(), sourcePath: filePath, sequence: 1 });
            await input.onLine({ line: jsonlLine(firstMessage).trimEnd(), sourcePath: filePath, sequence: 2 });
          }),
          close: vi.fn(async () => undefined),
        };
      }),
    });
    const engine = await registrations[0]!.create(ctx);
    const surface = engine.externalSessionSurface;
    if (!surface?.acquireFollowLease) {
      throw new Error('Expected OhMyPi engine to expose acquireFollowLease');
    }
    const runtime = {
      signal: new AbortController().signal,
      transcripts: { fileFollow: ctx.transcripts.fileFollow },
      diagnostics: { issue: vi.fn() },
    };
    const resolveFollowTranscriptPath = Reflect.get(surface, 'resolveFollowTranscriptPath');
    expect(resolveFollowTranscriptPath).toEqual(expect.any(Function));
    if (typeof resolveFollowTranscriptPath !== 'function') return;

    await expect(resolveFollowTranscriptPath({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      providerSessionId: remoteSessionId,
      reason: 'attached_view',
      runtime,
    })).resolves.toEqual({
      ok: true,
      value: {
        path: realFilePath,
        sourceId: remoteSessionId,
      },
    });

    const leaseResult = await surface.acquireFollowLease({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      providerSessionId: remoteSessionId,
      reason: 'attached_view',
      runtime,
    });

    expect(leaseResult.ok).toBe(true);
    if (!leaseResult.ok) return;
    expect(followInput).toEqual(expect.objectContaining({
      path: realFilePath,
      startAt: 'beginning',
      strategy: 'poll',
      onLine: expect.any(Function),
    }));

    const events: unknown[] = [];
    leaseResult.value.subscribeToTranscriptUpdates?.((event) => {
      events.push(event);
    });

    expect(events).toEqual([]);

    await followInput!.onLine({
      line: jsonlLine({
        type: 'message',
        id: 'assistant-2',
        parentId: 'assistant-1',
        timestamp: '2026-04-10T10:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'follow-up message' }] },
      }).trimEnd(),
      sourcePath: filePath,
      sequence: 3,
    });

    expect(JSON.stringify(events)).toContain('follow-up message');
    await leaseResult.value.release();
  });

  it('does not read a transcript path before delegating authorization to ctx.transcripts.fileFollow', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-plugin-follow-denied-')));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const remoteSessionId = 'omp-session-denied';
    const unreadableTranscript = join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`);
    await writeFile(unreadableTranscript, jsonlLine({
      type: 'session',
      id: remoteSessionId,
      timestamp: '2026-04-10T10:00:00.000Z',
    }), 'utf8');
    await chmod(unreadableTranscript, 0o000);

    const registrations: BundledRegisterBackendEngineV1[] = [];
    activate({
      registerBackendEngine: (registration) => {
        registrations.push(registration);
        return { dispose: vi.fn() } satisfies PluginDisposable;
      },
    });

    const follow = vi.fn(async () => {
      throw new Error('path is not granted');
    });
    const ctx = createPluginContext({ follow });
    const engine = await registrations[0]!.create(ctx);
    const surface = engine.externalSessionSurface;
    if (!surface?.acquireFollowLease) {
      throw new Error('Expected OhMyPi engine to expose acquireFollowLease');
    }

    const leaseResult = await surface.acquireFollowLease({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      providerSessionId: remoteSessionId,
      reason: 'attached_view',
      runtime: {
        signal: new AbortController().signal,
        transcripts: { fileFollow: ctx.transcripts.fileFollow },
        diagnostics: { issue: vi.fn() },
      },
    });

    expect(follow).toHaveBeenCalledTimes(1);
    expect(leaseResult.ok).toBe(false);
  });

  it('does not follow symlinked transcript files discovered under the agent directory', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-plugin-follow-symlink-')));
    const externalDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-plugin-follow-external-')));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const remoteSessionId = 'omp-session-symlink';
    const externalFile = join(externalDir, 'outside.jsonl');
    await writeFile(externalFile, jsonlLine({
      type: 'session',
      id: remoteSessionId,
      timestamp: '2026-04-10T10:00:00.000Z',
    }), 'utf8');
    await symlink(externalFile, join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`));

    const registrations: BundledRegisterBackendEngineV1[] = [];
    activate({
      registerBackendEngine: (registration) => {
        registrations.push(registration);
        return { dispose: vi.fn() } satisfies PluginDisposable;
      },
    });

    const follow = vi.fn(async () => ({
      id: 'unexpected-follow',
      drainNow: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));
    const ctx = createPluginContext({ follow });
    const engine = await registrations[0]!.create(ctx);
    const surface = engine.externalSessionSurface;
    if (!surface?.acquireFollowLease) {
      throw new Error('Expected OhMyPi engine to expose acquireFollowLease');
    }

    const leaseResult = await surface.acquireFollowLease({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      providerSessionId: remoteSessionId,
      reason: 'attached_view',
      runtime: {
        signal: new AbortController().signal,
        transcripts: { fileFollow: ctx.transcripts.fileFollow },
        diagnostics: { issue: vi.fn() },
      },
    });

    expect(follow).not.toHaveBeenCalled();
    expect(leaseResult.ok).toBe(false);
  });
});
