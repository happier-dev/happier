import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

describe('ohMyPiDirectSessionProviderOps.resolveTakeoverSpawnOptions', () => {
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
    const { ohMyPiDirectSessionProviderOps } = await import('./providerOps');

    const result = await ohMyPiDirectSessionProviderOps.resolveTakeoverSpawnOptions({
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
      backendTarget: { kind: 'builtInAgent', agentId: 'ohMyPi' },
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

describe('ohMyPiDirectSessionProviderOps.canonicalizeLinkedSession', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces stale linked agentDir values with the current configured oh-my-pi agent dir', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/current-omp-agent');

    const { ohMyPiDirectSessionProviderOps } = await import('./providerOps');

    await expect(
      ohMyPiDirectSessionProviderOps.canonicalizeLinkedSession?.({
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
