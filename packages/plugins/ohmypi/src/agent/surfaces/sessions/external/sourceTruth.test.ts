import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOhMyPiExternalSessionsContribution } from './contribution.js';
import { ohMyPiExternalSessionTakeoverContribution } from './semantics.js';

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function invocation(maxSerializedBytes = 1024 * 1024) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes,
  };
}

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function createSource(params: Readonly<{
  remoteSessionId: string;
  records: readonly unknown[];
}>): Promise<Readonly<{ agentDir: string; filePath: string }>> {
  const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-source-truth-'));
  roots.add(agentDir);
  const sessionRoot = join(agentDir, 'sessions', '-repo');
  await mkdir(sessionRoot, { recursive: true });
  const filePath = join(sessionRoot, `2026-07-23T10-00-00-000Z_${params.remoteSessionId}.jsonl`);
  await writeFile(filePath, params.records.map(jsonlLine).join(''), 'utf8');
  return { agentDir, filePath };
}

const contribution = createOhMyPiExternalSessionsContribution();

describe('Oh My Pi external-session source truth', () => {
  it('refuses a page whose named session file does not exist', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-source-truth-'));
    roots.add(agentDir);
    await mkdir(join(agentDir, 'sessions', '-repo'), { recursive: true });
    const result = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' as const, agentDir },
      remoteSessionId: 'never-written',
      direction: 'older',
      maxItems: 50,
    });
    expect(result).toMatchObject({ ok: false, code: 'source_unreachable' });
  });

  it('refuses a page whose named file now holds a different session', async () => {
    const { agentDir, filePath } = await createSource({
      remoteSessionId: 'omp-1',
      records: [{ type: 'session', id: 'omp-1', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' }],
    });
    await writeFile(
      filePath,
      jsonlLine({ type: 'session', id: 'omp-replaced', timestamp: '2026-07-23T11:00:00.000Z', cwd: '/repo' }),
      'utf8',
    );
    const result = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' as const, agentDir, sessionFilePath: filePath },
      remoteSessionId: 'omp-1',
      direction: 'older',
      maxItems: 50,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { code: string }).code).not.toBe('agent_error');
  });

  it('refuses a page for a file outside the granted session roots', async () => {
    const { agentDir } = await createSource({
      remoteSessionId: 'omp-1',
      records: [{ type: 'session', id: 'omp-1', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' }],
    });
    const outside = await mkdtemp(join(tmpdir(), 'happier-ohmypi-outside-'));
    roots.add(outside);
    const outsidePath = join(outside, 'stolen.jsonl');
    await writeFile(
      outsidePath,
      jsonlLine({ type: 'session', id: 'omp-1', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' }),
      'utf8',
    );
    const result = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' as const, agentDir, sessionFilePath: outsidePath },
      remoteSessionId: 'omp-1',
      direction: 'older',
      maxItems: 50,
    });
    expect(result).toMatchObject({ ok: false, code: 'source_unreachable' });
  });

  it('refuses a newer-direction page instead of reporting an empty one', async () => {
    const { agentDir, filePath } = await createSource({
      remoteSessionId: 'omp-1',
      records: [{ type: 'session', id: 'omp-1', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' }],
    });
    const result = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' as const, agentDir, sessionFilePath: filePath },
      remoteSessionId: 'omp-1',
      direction: 'newer',
      maxItems: 50,
    });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('still reports a real but empty branch as a successful empty page', async () => {
    const { agentDir, filePath } = await createSource({
      remoteSessionId: 'omp-1',
      records: [{ type: 'session', id: 'omp-1', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' }],
    });
    const result = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' as const, agentDir, sessionFilePath: filePath },
      remoteSessionId: 'omp-1',
      direction: 'older',
      maxItems: 50,
    });
    expect(result).toMatchObject({ ok: true });
    expect((result as { value: { items: unknown[] } }).value.items).toEqual([]);
  });

  it('resolves the launch from the session-header source alone without a launch directory', async () => {
    const { agentDir, filePath } = await createSource({
      remoteSessionId: 'omp-1',
      records: [
        { type: 'session', id: 'omp-1', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo/workspace' },
        {
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'hello' },
        },
      ],
    });
    const result = await ohMyPiExternalSessionTakeoverContribution.resolveLaunch({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' as const, agentDir, sessionFilePath: filePath },
      remoteSessionId: 'omp-1',
    } as never);
    // The launch plan carries no cwd authority: the host enforces the request
    // targetDirectory as the spawned cwd.
    expect(result).toMatchObject({
      ok: true,
      value: { environmentVariables: { PI_CODING_AGENT_DIR: agentDir } },
    });
    expect(result).not.toMatchObject({ value: { directory: expect.anything() } });
  });
});
