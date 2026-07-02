import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginContextV1, PluginDisposable } from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';
import { activate } from '@happier-dev/plugins-ohmypi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';

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

function createPluginContext(): PluginContextV1 {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as PluginContextV1;
  // The OhMyPi backend engine currently consumes no PluginContext services at construction time.
}

async function createOhMyPiSessionFile(): Promise<Readonly<{
  agentDir: string;
  remoteSessionId: string;
  filePath: string;
  realFilePath: string;
}>> {
  const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-file-follow-grant-')));
  const sessionRoot = join(agentDir, 'sessions', '-repo');
  await mkdir(sessionRoot, { recursive: true });
  const remoteSessionId = 'omp-session-grant';
  const filePath = join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`);
  await writeFile(filePath, [
    jsonlLine({
      type: 'session',
      id: remoteSessionId,
      timestamp: '2026-04-10T10:00:00.000Z',
      cwd: '/repo/ohmypi',
      title: 'OhMyPi grant test',
    }),
    jsonlLine({
      type: 'message',
      id: 'assistant-1',
      parentId: null,
      timestamp: '2026-04-10T10:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'initial message' }] },
    }),
  ].join(''), 'utf8');
  return {
    agentDir,
    remoteSessionId,
    filePath,
    realFilePath: await realpath(filePath),
  };
}

async function createOhMyPiExternalSessionSurface() {
  const registrations: BundledRegisterBackendEngineV1[] = [];
  activate({
    registerBackendEngine: (registration) => {
      registrations.push(registration);
      return { dispose: vi.fn() } satisfies PluginDisposable;
    },
  });
  const engine = await registrations[0]!.create(createPluginContext());
  if (!engine.externalSessionSurface?.acquireFollowLease) {
    throw new Error('Expected OhMyPi plugin engine to expose acquireFollowLease');
  }
  return engine.externalSessionSurface;
}

describe('OhMyPi plugin file-follow bridge', () => {
  it('denies ungranted transcript paths and follows exactly granted realpaths through the host service', async () => {
    const session = await createOhMyPiSessionFile();
    vi.stubEnv('PI_CODING_AGENT_DIR', session.agentDir);

    const surface = await createOhMyPiExternalSessionSurface();
    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    const pluginId = 'happier.agent.ohmypi';
    const runtimeId = 'ohmypi-file-follow-test-runtime';
    const runtime = {
      signal: new AbortController().signal,
      transcripts: {
        fileFollow: createPluginTranscriptFileFollowService({
          pluginId,
          runtimeId,
          readSessionId: () => null,
          fileFollowPathGrants,
        }),
      },
      diagnostics: { issue: vi.fn() },
    };

    const denied = await surface.acquireFollowLease!({
      source: { kind: 'ohMyPiAgentDir', agentDir: session.agentDir },
      providerSessionId: session.remoteSessionId,
      reason: 'attached_view',
      runtime,
    });
    expect(denied.ok).toBe(false);

    await fileFollowPathGrants.grant({
      pluginId,
      runtimeId,
      sessionId: null,
      path: session.realFilePath,
      reason: 'externalSessionTranscript',
      evidence: { kind: 'hostMaterializedTranscriptPath', sourceId: session.remoteSessionId },
    });

    const granted = await surface.acquireFollowLease!({
      source: { kind: 'ohMyPiAgentDir', agentDir: session.agentDir },
      providerSessionId: session.remoteSessionId,
      reason: 'attached_view',
      runtime,
    });

    expect(granted.ok).toBe(true);
    if (granted.ok) {
      await granted.value.release();
    }
  });
});
