import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOhMyPiExternalSessionsContribution } from './contribution.js';

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
        linkData: { sessionFilePath: canonicalTranscriptPath },
      },
    });
    if (!linked.ok) return;

    await expect(contribution.resolveLinkedIdentity({
      ...invocation(),
      source: source.value.source,
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
          expect.objectContaining({ id: expect.stringContaining(':branch-summary:branch_summary') }),
          expect.objectContaining({ id: expect.stringContaining(':compact-1:compaction') }),
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

  it('keeps duplicate native ids qualified by the candidate file identity', async () => {
    const agentDir = await createAgentDir();
    const remoteSessionId = 'duplicate-id';
    const olderPath = await writeTranscript({
      agentDir,
      rootName: '-older',
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
      rootName: '-newer',
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
        value: { linkData: candidate.linkData },
      });
    }
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
        diagnostics: [
          {
            code: 'malformed_record_skipped',
            count: 1,
            positions: [priorSize],
          },
          {
            code: 'non_transcript_record_skipped',
            count: 1,
            positions: [priorSize + Buffer.byteLength(malformed, 'utf8')],
          },
          {
            code: 'unsupported_record_skipped',
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
        diagnostics: [{
          code: 'malformed_source_utf8',
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

  it('continues a multi-item appended record without exceeding the read-after item bound', async () => {
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

    const itemIds: string[] = [];
    let cursor = initial.value.tailCursor;
    for (let call = 0; call < 4; call += 1) {
      const result = await contribution.readAfterTranscript({
        ...invocation(),
        source,
        remoteSessionId,
        cursor,
        maxItems: 1,
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      if (result.value.outcome === 'already_current') break;
      expect(result.value.outcome).toBe('advanced');
      if (result.value.outcome !== 'advanced') return;
      expect(result.value.items).toHaveLength(1);
      itemIds.push(result.value.items[0]!.id);
      cursor = result.value.nextCursor;
    }

    expect(itemIds).toEqual([
      expect.stringContaining(':assistant-multi:text:0'),
      expect.stringContaining(':assistant-multi:text:1'),
      expect.stringContaining(':assistant-multi:text:2'),
    ]);
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
});
