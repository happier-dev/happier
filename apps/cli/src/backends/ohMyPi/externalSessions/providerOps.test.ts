import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
  tempDirs.add(path);
  return path;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('ohMyPiExternalSessionProviderOps.resolveTakeoverSpawnOptions', () => {
  it('reuses the linked oh-my-pi agent dir and working directory for takeover', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-provider-ops-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });

    const remoteSessionId = 'omp-session-one';
    const filePath = join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`);
    await writeFile(
      filePath,
      [
        jsonlLine({
          type: 'session',
          id: remoteSessionId,
          timestamp: '2026-04-10T10:00:00.000Z',
          cwd: '/repo/oh-my-pi',
          title: 'QA oh-my-pi session',
        }),
        jsonlLine({
          type: 'message',
          id: 'assistant-1',
          parentId: null,
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello from oh-my-pi' }] },
        }),
      ].join(''),
      'utf8',
    );

    const canonicalAgentDir = await realpath(agentDir);
    const { ohMyPiExternalSessionProviderOps } = await import('./providerOps');

    const result = await ohMyPiExternalSessionProviderOps.resolveTakeoverSpawnOptions({
      linked: {
        rawSession: {
          id: 'raw-session-1',
          seq: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          active: true,
          activeAt: Date.now(),
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
          accountId: 'acct-1',
          machineId: 'machine-1',
          machineLabel: null,
          sessionPath: null,
          providerId: 'ohMyPi',
          providerSessionId: remoteSessionId,
          providerSource: JSON.stringify({ kind: 'ohMyPiAgentDir', agentDir }),
        },
        metadata: {},
        sessionPath: null,
        providerId: 'ohMyPi',
        machineId: 'machine-1',
        remoteSessionId,
        source: { kind: 'ohMyPiAgentDir', agentDir },
        codexBackendMode: null,
      },
      sessionId: 'happy-session-1',
    });

    expect(result).toEqual({
      directory: '/repo/oh-my-pi',
      backendTarget: { kind: 'backend', backendId: 'ohMyPi', sourceKind: 'built_in' },
      existingSessionId: 'happy-session-1',
      resume: remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: {
        PI_CODING_AGENT_DIR: canonicalAgentDir,
      },
    });
  });
});

describe('ohMyPiExternalSessionProviderOps.canonicalizeLinkedSession', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces stale linked agentDir values with the current configured oh-my-pi agent dir', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/current-omp-agent');

    const { ohMyPiExternalSessionProviderOps } = await import('./providerOps');

    await expect(
      ohMyPiExternalSessionProviderOps.canonicalizeLinkedSession?.({
        metadata: {},
        remoteSessionId: 'omp-session',
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: '/tmp/stale-omp-agent',
        },
      }),
    ).resolves.toEqual({
      remoteSessionId: 'omp-session',
      source: {
        kind: 'ohMyPiAgentDir',
        agentDir: '/tmp/current-omp-agent',
      },
    });
  });
});

describe('ohMyPiExternalSessionProviderOps.listCandidates', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the plugin source validation before listing candidates', async () => {
    const configuredAgentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-list-configured-')));
    const staleAgentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-list-stale-')));
    vi.stubEnv('PI_CODING_AGENT_DIR', configuredAgentDir);

    const { ohMyPiExternalSessionProviderOps } = await import('./providerOps');

    await expect(
      ohMyPiExternalSessionProviderOps.listCandidates({
        source: { kind: 'ohMyPiAgentDir', agentDir: staleAgentDir },
        limit: 10,
      }),
    ).rejects.toThrow('source agentDir override is not allowed');
  });
});

describe('ohMyPiExternalSessionProviderOps file-follow bridge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves an exact transcript path for host external-session grants', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-provider-follow-path-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const remoteSessionId = 'omp-session-path';
    const filePath = join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`);
    await writeFile(filePath, jsonlLine({
      type: 'session',
      id: remoteSessionId,
      timestamp: '2026-04-10T10:00:00.000Z',
    }), 'utf8');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const { ohMyPiExternalSessionProviderOps } = await import('./providerOps');
    expect(ohMyPiExternalSessionProviderOps.resolveFollowTranscriptPath).toEqual(expect.any(Function));

    await expect(ohMyPiExternalSessionProviderOps.resolveFollowTranscriptPath!({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId,
      reason: 'attached_view',
    })).resolves.toEqual({
      path: await realpath(filePath),
      sourceId: remoteSessionId,
    });
  });

  it('does not page symlinked transcript entries from the host bridge', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-provider-page-symlink-')));
    const externalDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-provider-page-external-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const remoteSessionId = 'omp-session-page-symlink';
    const targetPath = join(externalDir, 'outside.jsonl');
    await writeFile(
      targetPath,
      [
        jsonlLine({
          type: 'session',
          id: remoteSessionId,
          timestamp: '2026-04-10T10:00:00.000Z',
        }),
        jsonlLine({
          type: 'message',
          id: 'assistant-1',
          parentId: null,
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'must not leak through symlink' }] },
        }),
      ].join(''),
      'utf8',
    );
    await symlink(targetPath, join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const { ohMyPiExternalSessionProviderOps } = await import('./providerOps');

    await expect(ohMyPiExternalSessionProviderOps.pageTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId,
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    })).resolves.toMatchObject({
      items: [],
      hasMore: false,
      truncated: false,
    });
  });

  it('does not read-after symlinked transcript entries from the host bridge', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-provider-read-after-symlink-')));
    const externalDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-provider-read-after-external-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const remoteSessionId = 'omp-session-read-after-symlink';
    const targetPath = join(externalDir, 'outside.jsonl');
    await writeFile(
      targetPath,
      [
        jsonlLine({
          type: 'session',
          id: remoteSessionId,
          timestamp: '2026-04-10T10:00:00.000Z',
        }),
        jsonlLine({
          type: 'message',
          id: 'assistant-1',
          parentId: null,
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'must not leak through read-after' }] },
        }),
      ].join(''),
      'utf8',
    );
    await symlink(targetPath, join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const { ohMyPiExternalSessionProviderOps } = await import('./providerOps');

    await expect(ohMyPiExternalSessionProviderOps.readAfterTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId,
      cursor: 'idx:0',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    })).resolves.toMatchObject({
      items: [],
      truncated: false,
    });
  });

  it('acquires follow leases through the plugin file-follow runtime service', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-oh-my-pi-provider-follow-lease-')));
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const remoteSessionId = 'omp-session-follow';
    const filePath = join(sessionRoot, `2026-04-10T10-00-00-000Z_${remoteSessionId}.jsonl`);
    const sessionHeader = {
      type: 'session',
      id: remoteSessionId,
      timestamp: '2026-04-10T10:00:00.000Z',
      cwd: '/repo/oh-my-pi',
    };
    await writeFile(filePath, jsonlLine(sessionHeader), 'utf8');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const follow = vi.fn(async (input) => ({
      id: 'ohmypi-follow',
      drainNow: vi.fn(async () => {
        await input.onLine({
          line: jsonlLine(sessionHeader).trimEnd(),
          sourcePath: filePath,
          sequence: 1,
        });
      }),
      close: vi.fn(async () => undefined),
    }));
    const { ohMyPiExternalSessionProviderOps } = await import('./providerOps');
    expect(ohMyPiExternalSessionProviderOps.acquireFollowLease).toEqual(expect.any(Function));

    const lease = await ohMyPiExternalSessionProviderOps.acquireFollowLease!({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId,
      reason: 'attached_view',
      runtime: {
        signal: new AbortController().signal,
        transcripts: { fileFollow: { follow } },
        diagnostics: { issue: vi.fn() },
      },
    });

    expect(follow).toHaveBeenCalledWith(expect.objectContaining({
      path: await realpath(filePath),
      startAt: 'beginning',
      strategy: 'poll',
    }));
    await lease?.release();
  });
});
