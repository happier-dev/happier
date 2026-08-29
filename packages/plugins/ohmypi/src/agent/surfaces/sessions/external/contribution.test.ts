import {
  appendFile,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { TranscriptRawRecordV1Schema } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOhMyPiExternalSessionsContribution } from './contribution.js';
import { listOhMyPiSessionRoots } from './files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: vi.fn(actual.opendir),
  };
});

const roots = new Set<string>();

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

async function createAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-public-external-'));
  roots.add(agentDir);
  return agentDir;
}

async function writeTranscript(params: Readonly<{
  agentDir: string;
  rootName?: string;
  remoteSessionId: string;
  records: readonly unknown[];
}>): Promise<string> {
  const sessionRoot = join(params.agentDir, 'sessions', params.rootName ?? '-repo');
  await mkdir(sessionRoot, { recursive: true });
  const filePath = join(
    sessionRoot,
    `2026-07-23T10-00-00-000Z_${params.remoteSessionId}.jsonl`,
  );
  await writeFile(filePath, params.records.map(jsonlLine).join(''), 'utf8');
  return filePath;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('Oh My Pi public External Sessions contribution', () => {
  it('lists only the explicitly configured source when ambient Pi storage points elsewhere', async () => {
    const configured = await createAgentDir();
    const ambient = await createAgentDir();
    const header = (id: string) => [{
      type: 'session', id, timestamp: '2026-08-16T10:00:00.000Z', cwd: '/repo', title: id,
    }];
    await writeTranscript({
      agentDir: configured, remoteSessionId: 'configured-omp', records: header('configured-omp'),
    });
    await writeTranscript({
      agentDir: ambient, remoteSessionId: 'ambient-omp', records: header('ambient-omp'),
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: ambient },
    });

    const listed = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir', agentDir: configured },
      maxItems: 10,
    });

    expect(listed).toMatchObject({
      ok: true,
      value: { candidates: [expect.objectContaining({ remoteSessionId: 'configured-omp' })] },
    });
    expect(JSON.stringify(listed)).not.toContain('ambient-omp');
  });

  it('projects resolved sources onto the bounded Agent contribution DTO', async () => {
    const agentDir = await createAgentDir();
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    expect(await contribution.resolveSource({
      ...invocation(),
      source: {
        kind: 'ohMyPiAgentDir',
        agentDir,
        resolvedRoot: '/private/host-owned-root',
      },
    })).toEqual({
      ok: true,
      value: {
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: expect.any(String),
        },
      },
    });
  });

  it('keeps transcript item identities stable and file-distinct without publishing session paths', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'shared-session';
    const records = [
      {
        type: 'session',
        id: remoteSessionId,
        timestamp: '2026-07-23T10:00:00.000Z',
        cwd: '/repo',
      },
      {
        type: 'message',
        id: 'shared-entry',
        parentId: null,
        timestamp: '2026-07-23T10:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { target: 'README.md' } },
          ],
        },
      },
    ];
    const transcriptPaths = await Promise.all([
      writeTranscript({ agentDir, rootName: '-repo-a', remoteSessionId, records }),
      writeTranscript({ agentDir, rootName: '-repo-b', remoteSessionId, records }),
    ]);
    const canonicalTranscriptPaths = await Promise.all(transcriptPaths.map((path) => realpath(path)));
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = await contribution.resolveSource({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' },
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const readPage = async (sessionFilePath: string) => {
      const linked = await contribution.resolveLinkIdentity({
        ...invocation(),
        source: source.value.source,
        remoteSessionId,
        linkData: { sessionFilePath },
      });
      expect(linked.ok).toBe(true);
      if (!linked.ok) return null;
      const page = await contribution.pageTranscript({
        ...invocation(),
        source: linked.value.source,
        remoteSessionId,
        direction: 'older',
        maxItems: 10,
      });
      expect(page.ok).toBe(true);
      return page.ok ? page.value : null;
    };

    const firstPage = await readPage(canonicalTranscriptPaths[0]!);
    const repeatedFirstPage = await readPage(canonicalTranscriptPaths[0]!);
    const secondPage = await readPage(canonicalTranscriptPaths[1]!);
    expect(firstPage).not.toBeNull();
    expect(repeatedFirstPage).not.toBeNull();
    expect(secondPage).not.toBeNull();
    if (!firstPage || !repeatedFirstPage || !secondPage) return;

    const firstItem = firstPage.items[0];
    const repeatedFirstItem = repeatedFirstPage.items[0];
    const secondItem = secondPage.items[0];
    expect(firstItem?.id).toBe(repeatedFirstItem?.id);
    expect(firstItem?.id).not.toBe(secondItem?.id);
    expect(firstItem?.id).toMatch(/^omp:[A-Za-z0-9_-]+:shared-entry:toolCall:0$/u);
    expect(firstItem?.localId).toBe(firstItem?.id);
    expect(firstItem?.raw).toMatchObject({
      content: { data: { id: firstItem?.id } },
    });
    expect(firstItem?.id.length).toBeLessThanOrEqual(2_000);

    for (const page of [firstPage, repeatedFirstPage, secondPage]) {
      const serialized = JSON.stringify(page);
      for (const canonicalPath of canonicalTranscriptPaths) {
        expect(serialized).not.toContain(canonicalPath);
      }
    }
  });

  it('exposes exactly six bounded methods and preserves tree/compaction item identity', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'tree-session';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        {
          type: 'session',
          id: remoteSessionId,
          timestamp: '2026-07-23T10:00:00.000Z',
          cwd: '/repo',
          title: 'Tree session',
        },
        {
          type: 'message',
          id: 'user-root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root prompt' },
        },
        {
          type: 'message',
          id: 'abandoned-branch',
          parentId: 'user-root',
          timestamp: '2026-07-23T10:00:02.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] },
        },
        {
          type: 'branch_summary',
          id: 'branch-summary',
          parentId: 'user-root',
          timestamp: '2026-07-23T10:00:03.000Z',
          summary: 'selected branch',
        },
        {
          type: 'compaction',
          id: 'compact-1',
          parentId: 'branch-summary',
          timestamp: '2026-07-23T10:00:04.000Z',
          summary: 'compacted context',
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const canonicalTranscriptPath = await realpath(transcriptPath);

    expect(Object.keys(contribution).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveSource',
    ]);

    const source = await contribution.resolveSource({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' },
    });
    expect(source).toMatchObject({
      ok: true,
      value: { source: { kind: 'ohMyPiAgentDir', agentDir: expect.any(String) } },
    });
    if (!source.ok) return;

    const candidates = await contribution.listCandidates({
      ...invocation(),
      source: source.value.source,
      maxItems: 10,
    });
    expect(candidates).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.objectContaining({
          remoteSessionId,
          linkData: { sessionFilePath: canonicalTranscriptPath },
        })],
      },
    });
    if (!candidates.ok) return;
    const candidate = candidates.value.candidates[0];
    if (!candidate) return;

    const linked = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: source.value.source,
      remoteSessionId,
      linkData: candidate.linkData,
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        remoteSessionId,
        source: { kind: 'ohMyPiAgentDir', sessionFilePath: canonicalTranscriptPath },
        // The resolved session file travels only on the source; the host spreads
        // this record into top-level owner metadata, which rejects unknown keys.
        linkData: {},
      },
    });
    if (!linked.ok) return;
    expect(linked.value.linkData).toEqual({});

    await expect(contribution.resolveLinkedIdentity({
      ...invocation(),
      source: linked.value.source,
      remoteSessionId,
      linkData: linked.value.linkData,
    })).resolves.toEqual(linked);

    const page = await contribution.pageTranscript({
      ...invocation(16 * 1024),
      source: linked.value.source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(page).toMatchObject({
      ok: true,
      value: {
        items: [
          expect.objectContaining({ id: expect.stringContaining(':user-root') }),
          expect.objectContaining({
            id: expect.stringContaining(':branch-summary:branch_summary'),
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'ohMyPi',
                data: {
                  type: 'message',
                  message: 'selected branch',
                },
              },
            },
          }),
          expect.objectContaining({
            id: expect.stringContaining(':compact-1:compaction'),
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'ohMyPi',
                data: expect.objectContaining({
                  type: 'context-compaction',
                  phase: 'completed',
                  trigger: 'unknown',
                  source: 'runtime',
                  summary: 'compacted context',
                }),
              },
            },
          }),
        ],
        tailCursor: expect.any(String),
      },
    });
    expect(JSON.stringify(page)).not.toContain('abandoned');
    if (!page.ok || !page.value.tailCursor) return;

    await appendFile(transcriptPath, jsonlLine({
      type: 'message',
      id: 'assistant-next',
      parentId: 'compact-1',
      timestamp: '2026-07-23T10:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] },
    }), 'utf8');
    const after = await contribution.readAfterTranscript({
      ...invocation(16 * 1024),
      source: linked.value.source,
      remoteSessionId,
      cursor: page.value.tailCursor,
      maxItems: 10,
    });
    expect(after).toMatchObject({
      ok: true,
      value: {
        items: [expect.objectContaining({ id: expect.stringContaining(':assistant-next:text:0') })],
        nextCursor: expect.any(String),
      },
    });
    expect(JSON.stringify(after)).toContain('continued');
  });

  it('traverses session renames while paging and following the active parent chain', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'renamed-tree-session';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
        {
          type: 'message',
          id: 'before-rename',
          parentId: 'root',
          timestamp: '2026-07-23T10:00:02.000Z',
          message: { role: 'assistant', content: 'before rename' },
        },
        {
          type: 'session_info',
          id: 'rename',
          parentId: 'before-rename',
          timestamp: '2026-07-23T10:00:03.000Z',
          name: 'Renamed session',
        },
        {
          type: 'message',
          id: 'leaf',
          parentId: 'rename',
          timestamp: '2026-07-23T10:00:04.000Z',
          message: { role: 'assistant', content: 'after rename' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };

    const newest = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 1,
    });
    expect(newest).toMatchObject({
      ok: true,
      value: {
        items: [expect.objectContaining({ id: expect.stringContaining(':leaf:text:0') })],
        nextCursor: expect.any(String),
        tailCursor: expect.any(String),
        hasMore: true,
        truncated: false,
      },
    });
    if (!newest.ok || !newest.value.nextCursor || !newest.value.tailCursor) return;

    const middle = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      cursor: newest.value.nextCursor,
      maxItems: 1,
    });
    expect(middle).toMatchObject({
      ok: true,
      value: {
        items: [expect.objectContaining({ id: expect.stringContaining(':before-rename:text:0') })],
        nextCursor: expect.any(String),
        hasMore: true,
        truncated: false,
      },
    });
    if (!middle.ok || !middle.value.nextCursor) return;

    await expect(contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      cursor: middle.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        items: [expect.objectContaining({ id: expect.stringMatching(/:root$/u) })],
        nextCursor: null,
        hasMore: false,
        truncated: false,
      },
    });

    const renamePosition = (await stat(transcriptPath)).size;
    await appendFile(transcriptPath, [
      jsonlLine({
        type: 'session_info',
        id: 'follow-rename',
        parentId: 'leaf',
        timestamp: '2026-07-23T10:00:05.000Z',
        name: 'Renamed again',
      }),
      jsonlLine({
        type: 'message',
        id: 'continued',
        parentId: 'follow-rename',
        timestamp: '2026-07-23T10:00:06.000Z',
        message: { role: 'assistant', content: 'continued after rename' },
      }),
    ].join(''), 'utf8');

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: newest.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [expect.objectContaining({ id: expect.stringContaining(':continued:text:0') })],
        diagnostics: [{
          code: 'non_transcript_record_skipped',
          count: 1,
          positions: [renamePosition],
        }],
      },
    });
  });

  it('keeps duplicate native ids qualified by the candidate file identity', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'duplicate-id';
    await Promise.all([
      mkdir(join(agentDir, 'sessions', '-root-a'), { recursive: true }),
      mkdir(join(agentDir, 'sessions', '-root-z'), { recursive: true }),
    ]);
    const [legacyFirstRoot, secondRoot] = await listOhMyPiSessionRoots({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    expect(legacyFirstRoot).toEqual(expect.any(String));
    expect(secondRoot).toEqual(expect.any(String));
    if (!legacyFirstRoot || !secondRoot) return;

    // The legacy unqualified resolver stops at its first root. Put the older
    // duplicate there so this test distinguishes it from shared precedence.
    const olderPath = await writeTranscript({
      agentDir,
      rootName: basename(legacyFirstRoot),
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'older',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'older root' },
        },
      ],
    });
    const newerPath = await writeTranscript({
      agentDir,
      rootName: basename(secondRoot),
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T11:00:00.000Z' },
        {
          type: 'message',
          id: 'newer',
          parentId: null,
          timestamp: '2026-07-23T11:00:01.000Z',
          message: { role: 'user', content: 'newer root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const canonicalOlderPath = await realpath(olderPath);
    const canonicalNewerPath = await realpath(newerPath);
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const listed = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 10,
    });
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) return;
    expect(new Set(listed.value.candidates.map(
      (candidate) => candidate.linkData?.sessionFilePath,
    ))).toEqual(new Set([canonicalOlderPath, canonicalNewerPath]));

    for (const candidate of listed.value.candidates) {
      await expect(contribution.resolveLinkIdentity({
        ...invocation(),
        source,
        remoteSessionId,
        linkData: candidate.linkData,
      })).resolves.toMatchObject({
        ok: true,
        value: {
          source: {
            kind: 'ohMyPiAgentDir',
            sessionFilePath: candidate.linkData?.sessionFilePath,
          },
          linkData: {},
        },
      });
    }

    await expect(contribution.resolveLinkIdentity({
      ...invocation(),
      source,
      remoteSessionId,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'ohMyPiAgentDir',
          sessionFilePath: canonicalNewerPath,
        },
      },
    });
  });

  it('recovers public-ref precedence without replaying a one-entry candidate page per unrelated file', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'public-ref-bounded-winner';
    const noiseRecords = (id: string) => [{
      type: 'session',
      id,
      timestamp: '2026-07-23T10:00:00.000Z',
    }];
    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const remoteNoiseId = `public-ref-noise-${String(index).padStart(3, '0')}`;
      await writeTranscript({
        agentDir,
        rootName: '-noise',
        remoteSessionId: remoteNoiseId,
        records: noiseRecords(remoteNoiseId),
      });
    }));
    await writeTranscript({
      agentDir,
      rootName: '-older',
      remoteSessionId,
      records: [{
        type: 'session',
        id: remoteSessionId,
        timestamp: '2026-07-23T10:00:00.000Z',
      }],
    });
    const newerPath = await writeTranscript({
      agentDir,
      rootName: '-newer',
      remoteSessionId,
      records: [{
        type: 'session',
        id: remoteSessionId,
        timestamp: '2026-07-23T11:00:00.000Z',
      }],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    vi.mocked(opendir).mockClear();
    await expect(contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'ohMyPiAgentDir',
          sessionFilePath: await realpath(newerPath),
        },
      },
    });
    expect(vi.mocked(opendir).mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('does not fall back to a filename-only match when no candidate owns the requested id', async () => {
    const agentDir = await createAgentDir();
    const requestedSessionId = 'requested-session';
    await writeTranscript({
      agentDir,
      remoteSessionId: requestedSessionId,
      records: [
        {
          type: 'session',
          id: 'different-session',
          timestamp: '2026-07-23T10:00:00.000Z',
        },
        {
          type: 'message',
          id: 'different-user',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'different source identity' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId: requestedSessionId,
    })).resolves.toMatchObject({
      ok: false,
      code: 'candidate_not_found',
    });
  });

  it('refuses a stale tail cursor after atomic replacement or a branch switch', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'rewrite-session';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
        {
          type: 'message',
          id: 'old-leaf',
          parentId: 'root',
          timestamp: '2026-07-23T10:00:02.000Z',
          message: { role: 'assistant', content: 'old leaf' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    await appendFile(transcriptPath, jsonlLine({
      type: 'message',
      id: 'new-branch',
      parentId: 'root',
      timestamp: '2026-07-23T10:00:03.000Z',
      message: { role: 'assistant', content: 'branch switch' },
    }), 'utf8');
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: { outcome: 'source_replaced' },
    });

    const replacementPath = `${transcriptPath}.replacement`;
    await writeFile(replacementPath, [
      jsonlLine({ type: 'session', id: remoteSessionId, timestamp: '2026-07-23T12:00:00.000Z' }),
      jsonlLine({
        type: 'message',
        id: 'replacement-root',
        parentId: null,
        timestamp: '2026-07-23T12:00:01.000Z',
        message: { role: 'user', content: 'replacement' },
      }),
    ].join(''), 'utf8');
    await rename(replacementPath, transcriptPath);
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: { outcome: 'source_replaced' },
    });
  });

  it('keeps truncate, delete, and recreate outcomes explicit without advancing stale data', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'source-lifecycle-session';
    const initialRecords = [
      { type: 'session', id: remoteSessionId, timestamp: '2026-07-25T10:00:00.000Z' },
      {
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-07-25T10:00:01.000Z',
        message: { role: 'user', content: 'root' },
      },
      {
        type: 'message',
        id: 'old-leaf',
        parentId: 'root',
        timestamp: '2026-07-25T10:00:02.000Z',
        message: { role: 'assistant', content: 'old leaf' },
      },
    ];
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: initialRecords,
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = {
      kind: 'ohMyPiAgentDir' as const,
      agentDir,
      sessionFilePath: transcriptPath,
    };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    const truncatedContent = initialRecords.slice(0, 2).map(jsonlLine).join('');
    await truncate(transcriptPath, Buffer.byteLength(truncatedContent, 'utf8'));
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_replaced' },
    });

    await rm(transcriptPath);
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_unavailable' },
    });

    await writeFile(transcriptPath, [
      jsonlLine({
        type: 'session',
        id: remoteSessionId,
        timestamp: '2026-07-25T11:00:00.000Z',
      }),
      jsonlLine({
        type: 'message',
        id: 'replacement-root',
        parentId: null,
        timestamp: '2026-07-25T11:00:01.000Z',
        message: { role: 'user', content: 'replacement root' },
      }),
    ].join(''), 'utf8');
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_replaced' },
    });
  });

  it('advances empty reads only with bounded source-offset diagnostics and then reports current', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'diagnostic-only-session';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    const priorSize = (await stat(transcriptPath)).size;
    const malformed = '{"type":\n';
    const nonTranscript = jsonlLine({
      type: 'session_info',
      name: 'Updated title only',
      timestamp: '2026-07-23T10:00:02.000Z',
    });
    const lateSessionHeader = jsonlLine({
      type: 'session',
      id: remoteSessionId,
      timestamp: '2026-07-23T10:00:02.500Z',
    });
    const lateTitleSlot = jsonlLine({
      type: 'title',
      v: 1,
      title: 'Late fixed-width title slot',
    });
    const unknownMetadata = jsonlLine({
      type: 'future_metadata',
      payload: { preserved: true },
      timestamp: '2026-07-23T10:00:03.000Z',
    });
    const unknownTreeEntry = jsonlLine({
      type: 'future_entry',
      id: 'future-entry',
      parentId: 'root',
      timestamp: '2026-07-23T10:00:04.000Z',
      payload: { preserved: true },
    });
    await appendFile(
      transcriptPath,
      `${malformed}${nonTranscript}${lateSessionHeader}${lateTitleSlot}${unknownMetadata}${unknownTreeEntry}`,
      'utf8',
    );

    const advanced = await contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    });
    expect(advanced).toEqual({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [],
        nextCursor: expect.any(String),
        boundary: expect.any(String),
        hasMore: false,
        diagnostics: [
          {
            code: 'malformed_record_skipped',
            severity: 'required',
            count: 1,
            positions: [priorSize],
          },
          {
            code: 'non_transcript_record_skipped',
            severity: 'benign',
            count: 1,
            positions: [priorSize + Buffer.byteLength(malformed, 'utf8')],
          },
          {
            code: 'unsupported_record_skipped',
            severity: 'required',
            count: 4,
            positions: [
              priorSize + Buffer.byteLength(`${malformed}${nonTranscript}`, 'utf8'),
              priorSize + Buffer.byteLength(
                `${malformed}${nonTranscript}${lateSessionHeader}`,
                'utf8',
              ),
              priorSize + Buffer.byteLength(
                `${malformed}${nonTranscript}${lateSessionHeader}${lateTitleSlot}`,
                'utf8',
              ),
              priorSize + Buffer.byteLength(
                `${malformed}${nonTranscript}${lateSessionHeader}${lateTitleSlot}${unknownMetadata}`,
                'utf8',
              ),
            ],
          },
        ],
      },
    });
    if (!advanced.ok || advanced.value.outcome !== 'advanced') return;

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: advanced.value.nextCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'already_current' },
    });
  });

  it('returns a bounded appended suffix as an advanced page with hasMore instead of a gap', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'bounded-suffix-omp';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [{
        type: 'session',
        id: remoteSessionId,
        timestamp: '2026-07-23T10:00:00.000Z',
        cwd: '/repo',
        title: remoteSessionId,
      }, {
        type: 'message',
        id: 'initial',
        parentId: remoteSessionId,
        timestamp: '2026-07-23T10:00:01.000Z',
        message: { role: 'assistant', content: 'initial' },
      }],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };

    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    if (!initial.ok || !initial.value.tailCursor) throw new Error('Expected an OMP tail cursor');

    await appendFile(transcriptPath, [
      jsonlLine({
        type: 'message',
        id: 'first-appended',
        parentId: 'initial',
        timestamp: '2026-07-23T10:00:02.000Z',
        message: { role: 'assistant', content: 'first appended item' },
      }),
      jsonlLine({
        type: 'message',
        id: 'second-appended',
        parentId: 'first-appended',
        timestamp: '2026-07-23T10:00:03.000Z',
        message: { role: 'assistant', content: 'second appended item' },
      }),
    ].join(''), 'utf8');

    // One item fits the budget; the stop is ordinary pagination and must keep
    // the exact continuation cursor the source built instead of reporting a
    // gap that would make the host follow owner drop the suffix.
    const firstBounded = await contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 1,
    });
    expect(firstBounded).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [expect.objectContaining({ id: expect.stringContaining('first-appended') })],
        nextCursor: expect.any(String),
        hasMore: true,
      },
    });
    if (!firstBounded.ok || firstBounded.value.outcome !== 'advanced') return;

    const secondBounded = await contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: firstBounded.value.nextCursor,
      maxItems: 1,
    });
    expect(secondBounded).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [expect.objectContaining({ id: expect.stringContaining('second-appended') })],
        nextCursor: expect.any(String),
        hasMore: false,
      },
    });
    if (!secondBounded.ok || secondBounded.value.outcome !== 'advanced') return;

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: secondBounded.value.nextCursor,
      maxItems: 1,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'already_current' },
    });
  });

  it('rejects a page when one native message mixes representable and unsupported blocks', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'mixed-page-record';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
        {
          type: 'message',
          id: 'mixed',
          parentId: 'root',
          timestamp: '2026-07-23T10:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'representable text' },
              { type: 'image', data: 'aGk=', mimeType: 'image/png' },
            ],
          },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir', agentDir, sessionFilePath: transcriptPath },
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({ ok: false, code: 'agent_error', retryable: false });
  });

  it('rejects a page when a user message mixes text with an unsupported block', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'mixed-user-page-record';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
        {
          type: 'message',
          id: 'mixed-user',
          parentId: 'root',
          timestamp: '2026-07-23T10:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'representable text' },
              { type: 'image', data: 'aGk=', mimeType: 'image/png' },
            ],
          },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir', agentDir, sessionFilePath: transcriptPath },
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({ ok: false, code: 'agent_error', retryable: false });
  });

  it('advances past a mixed native message with a diagnostic instead of publishing a partial row', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'mixed-read-after-record';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir, sessionFilePath: transcriptPath };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    const position = (await stat(transcriptPath)).size;
    await appendFile(transcriptPath, jsonlLine({
      type: 'message',
      id: 'mixed',
      parentId: 'root',
      timestamp: '2026-07-23T10:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'representable text' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      },
    }), 'utf8');

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [],
        nextCursor: expect.any(String),
        boundary: expect.any(String),
        hasMore: false,
        diagnostics: [{
          code: 'unsupported_record_skipped',
          severity: 'required',
          count: 1,
          positions: [position],
        }],
      },
    });
  });

  it('advances past a mixed user message with a diagnostic instead of publishing a partial row', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'mixed-user-read-after-record';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir, sessionFilePath: transcriptPath };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    const position = (await stat(transcriptPath)).size;
    await appendFile(transcriptPath, jsonlLine({
      type: 'message',
      id: 'mixed-user',
      parentId: 'root',
      timestamp: '2026-07-23T10:00:02.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'representable text' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      },
    }), 'utf8');

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [],
        nextCursor: expect.any(String),
        boundary: expect.any(String),
        hasMore: false,
        diagnostics: [{
          code: 'unsupported_record_skipped',
          severity: 'required',
          count: 1,
          positions: [position],
        }],
      },
    });
  });

  it('reports malformed source UTF-8 by byte offset without admitting replacement text', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'malformed-source-utf8-session';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    const before = (await stat(transcriptPath)).size;
    const prefix = Buffer.from(
      '{"type":"message","id":"invalid","parentId":"root","timestamp":"2026-07-23T10:00:02.000Z","message":{"role":"assistant","content":"',
      'utf8',
    );
    await appendFile(
      transcriptPath,
      Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}}\n', 'utf8')]),
    );

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [],
        nextCursor: expect.any(String),
        boundary: expect.any(String),
        hasMore: false,
        diagnostics: [{
          code: 'malformed_source_utf8',
          severity: 'required',
          count: 1,
          positions: [before + prefix.byteLength],
        }],
      },
    });
  });

  it('retains skipped-record diagnostics when the same read advances transcript items', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'mixed-diagnostic-session';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    const priorSize = (await stat(transcriptPath)).size;
    const malformed = 'not-json\n';
    await appendFile(transcriptPath, [
      malformed,
      jsonlLine({
        type: 'message',
        id: 'assistant-next',
        parentId: 'root',
        timestamp: '2026-07-23T10:00:02.000Z',
        message: { role: 'assistant', content: 'continued' },
      }),
    ].join(''), 'utf8');

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [expect.objectContaining({ id: expect.stringContaining(':assistant-next:text:0') })],
        diagnostics: [{
          code: 'malformed_record_skipped',
          count: 1,
          positions: [priorSize],
        }],
      },
    });
  });

  it('advances a bounded nonempty appended record across item budgets instead of reporting a gap', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'read-after-item-continuation';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok || !initial.value.tailCursor) return;

    await appendFile(transcriptPath, jsonlLine({
      type: 'message',
      id: 'assistant-multi',
      parentId: 'root',
      timestamp: '2026-07-23T10:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
          { type: 'text', text: 'third' },
        ],
      },
    }), 'utf8');

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: initial.value.tailCursor,
      maxItems: 1,
    })).resolves.toEqual({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [expect.objectContaining({ id: expect.stringContaining(':assistant-multi:text:0') })],
        nextCursor: expect.any(String),
        boundary: expect.any(String),
        hasMore: true,
      },
    });
  });

  it('returns zero-item gap and unavailable outcomes without advancing source data', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'non-advanced-outcomes';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'root' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = {
      kind: 'ohMyPiAgentDir' as const,
      agentDir,
      sessionFilePath: transcriptPath,
    };

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: 'expired-native-cursor',
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'gap_or_cursor_expired' },
    });

    await rm(transcriptPath);
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId,
      cursor: 'expired-native-cursor',
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_unavailable' },
    });
  });

  it('returns typed source_invalid when a candidate continuation crosses source replacement', async () => {
    const agentDir = await createAgentDir();
    const paths = await Promise.all(Array.from({ length: 4 }, async (_, index) => (
      await writeTranscript({
        agentDir,
        remoteSessionId: `candidate-generation-${index}`,
        records: [{
          type: 'session',
          id: `candidate-generation-${index}`,
          timestamp: `2026-07-23T10:00:0${index}.000Z`,
          cwd: '/repo',
        }],
      })
    )));
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 2,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        nextCursor: expect.any(String),
        preparation: { kind: 'building_candidate_index', scanned: 2 },
      },
    });
    if (!first.ok || !first.value.nextCursor) return;

    const replacementPath = `${paths[1]}.replacement`;
    await writeFile(replacementPath, jsonlLine({
      type: 'session',
      id: 'candidate-generation-1',
      timestamp: '2026-07-23T12:00:00.000Z',
      cwd: '/repo',
    }), 'utf8');
    await rename(replacementPath, paths[1]);

    await expect(contribution.listCandidates({
      ...invocation(),
      source,
      cursor: first.value.nextCursor,
      maxItems: 2,
    })).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
      retryable: true,
    });
  });

  it('refuses a persisted candidate path that has been replaced by a symbolic link', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'symlink-session';
    const transcriptPath = await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z' },
      ],
    });
    const symlinkPath = `${transcriptPath}.link`;
    await symlink(transcriptPath, symlinkPath);
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    await expect(contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId,
      linkData: { sessionFilePath: symlinkPath },
    })).resolves.toMatchObject({
      ok: false,
      code: 'candidate_not_found',
    });
  });

  it('honors cancellation, deadlines, item ceilings, and complete-result byte ceilings', async () => {
    const agentDir = await createAgentDir();
    await writeTranscript({
      agentDir,
      remoteSessionId: 'bounded-session',
      records: [
        {
          type: 'session',
          id: 'bounded-session',
          timestamp: '2026-07-23T10:00:00.000Z',
          title: '😀'.repeat(2_000),
        },
        {
          type: 'message',
          id: 'bounded-user',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'bounded' },
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const aborted = new AbortController();
    aborted.abort();

    expect(await contribution.resolveSource({
      signal: aborted.signal,
      deadlineAtMs: Date.now() + 30_000,
      maxSerializedBytes: 1024,
      source,
    })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await contribution.resolveSource({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() - 1,
      maxSerializedBytes: 1024,
      source,
    })).toMatchObject({ ok: false, code: 'timeout', retryable: true });

    const listed = await contribution.listCandidates({
      ...invocation(512),
      source,
      maxItems: 1,
    });
    expect(listed).toMatchObject({ ok: true });
    expect(Buffer.byteLength(JSON.stringify(listed), 'utf8')).toBeLessThanOrEqual(512);
    if (listed.ok) {
      expect(listed.value.candidates).toHaveLength(1);
    }
  });

  it('continues candidate preparation without skipping when the UTF-8 result budget fits only part of a chunk', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionIds = Array.from({ length: 4 }, (_, index) => `byte-page-${index}`);
    await Promise.all(remoteSessionIds.map(async (remoteSessionId, index) => {
      await writeTranscript({
        agentDir,
        remoteSessionId,
        records: [{
          type: 'session',
          id: remoteSessionId,
          timestamp: `2026-07-23T10:00:0${index}.000Z`,
          cwd: '/repo',
          title: `candidate ${index}`,
        }],
      });
    }));
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    const source = { kind: 'ohMyPiAgentDir' as const, agentDir };
    const seen: string[] = [];
    let cursor: string | undefined;
    let firstCandidateCount: number | null = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await contribution.listCandidates({
        ...invocation(512),
        source,
        ...(cursor ? { cursor } : {}),
        maxItems: 4,
      });
      expect(page).toMatchObject({ ok: true });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(512);
      if (!page.ok) return;
      firstCandidateCount ??= page.value.candidates.length;
      seen.push(...page.value.candidates.map((candidate) => candidate.remoteSessionId));
      cursor = page.value.nextCursor ?? undefined;
      if (!cursor) break;
    }

    expect(firstCandidateCount).toBeGreaterThan(0);
    expect(firstCandidateCount).toBeLessThan(remoteSessionIds.length);
    expect(seen).toHaveLength(remoteSessionIds.length);
    expect(new Set(seen)).toEqual(new Set(remoteSessionIds));
  });

  it('publishes every transcript row as a canonical transcript raw record', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'canonical-envelope';
    await writeTranscript({
      agentDir,
      remoteSessionId,
      records: [
        { type: 'session', id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
        {
          type: 'message',
          id: 'user-string',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'plain string prompt' },
        },
        {
          type: 'message',
          id: 'user-blocks',
          parentId: 'user-string',
          timestamp: '2026-07-23T10:00:02.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'first part' }, { type: 'text', text: ' and second' }],
          },
        },
        {
          type: 'message',
          id: 'assistant-string',
          parentId: 'user-blocks',
          timestamp: '2026-07-23T10:00:03.000Z',
          message: {
            role: 'assistant',
            content: 'plain assistant answer',
            usage: { input_tokens: 12, output_tokens: 34 },
          },
        },
        {
          type: 'message',
          id: 'assistant-blocks',
          parentId: 'assistant-string',
          timestamp: '2026-07-23T10:00:04.000Z',
          message: {
            role: 'assistant',
            usage: { input_tokens: 5, output_tokens: 7 },
            content: [
              { type: 'thinking', thinking: 'weighing options' },
              { type: 'text', text: 'here is the plan' },
              { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/repo/a.ts' } },
              { type: 'tool_use', id: 'call-2', name: 'bash', input: { command: 'ls' } },
              { type: 'tool_result', tool_use_id: 'call-2', content: 'a.ts', is_error: false },
            ],
          },
        },
        {
          type: 'message',
          id: 'tool-result',
          parentId: 'assistant-blocks',
          timestamp: '2026-07-23T10:00:05.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'file body' }],
            isError: false,
          },
        },
        {
          type: 'branch_summary',
          id: 'branch-summary',
          parentId: 'tool-result',
          timestamp: '2026-07-23T10:00:06.000Z',
          summary: 'summarized the abandoned branch',
        },
        {
          type: 'compaction',
          id: 'compaction',
          parentId: 'branch-summary',
          timestamp: '2026-07-23T10:00:07.000Z',
          summary: 'compacted the earlier turns',
        },
      ],
    });
    const contribution = createOhMyPiExternalSessionsContribution({
      env: { PI_CODING_AGENT_DIR: agentDir },
    });

    const page = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'ohMyPiAgentDir' as const, agentDir },
      remoteSessionId,
      direction: 'older',
      maxItems: 50,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;

    const failures = page.value.items.flatMap((item) => {
      const parsed = TranscriptRawRecordV1Schema.safeParse(item.raw);
      return parsed.success ? [] : [{ id: item.id, raw: item.raw, issues: parsed.error.issues }];
    });
    expect(failures).toEqual([]);

    const raws = page.value.items.map((item) => item.raw);
    expect(raws).toEqual(expect.arrayContaining([
      { role: 'user', content: { type: 'text', text: 'plain string prompt' } },
      { role: 'user', content: { type: 'text', text: 'first part and second' } },
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'ohMyPi',
          data: { type: 'thinking', text: 'weighing options' },
        },
      },
    ]));
  });
});
