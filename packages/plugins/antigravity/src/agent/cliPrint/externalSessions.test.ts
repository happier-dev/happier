import { appendFile, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createAntigravityExternalSessionsContribution,
  readAntigravityExternalTranscriptAfter,
} from './externalSessions.js';

function invocation(maxSerializedBytes = 64 * 1024) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 10_000,
    maxSerializedBytes,
  };
}

async function createConversation(
  brainDir: string,
  conversationId: string,
  lines: readonly string[],
): Promise<string> {
  const logsDir = join(brainDir, conversationId, '.system_generated', 'logs');
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = join(logsDir, 'transcript_full.jsonl');
  await writeFile(transcriptPath, `${lines.join('\n')}\n`);
  return transcriptPath;
}

describe('Antigravity external-session pure leaf', () => {
  it('bounds the first candidate scan chunk and rejects continuation across a brain generation change', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-large-candidates-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      await createConversation(brainDir, `conversation-${String(index).padStart(3, '0')}`, [
        JSON.stringify({ id: `entry-${index}`, type: 'USER_INPUT', text: `entry ${index}` }),
      ]);
    }));
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' };

    const firstPage = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 3,
    });
    expect(firstPage).toMatchObject({
      ok: true,
      value: {
        candidates: expect.any(Array),
        nextCursor: expect.any(String),
      },
    });
    if (!firstPage.ok || !firstPage.value.nextCursor) {
      throw new Error('candidate scan continuation unexpectedly missing');
    }
    expect(firstPage.value).not.toHaveProperty('preparation');
    expect(firstPage.value.candidates.length).toBeLessThanOrEqual(3);

    await createConversation(brainDir, 'conversation-added-after-page-one', [
      '{"id":"new","type":"USER_INPUT","text":"new"}',
    ]);
    await expect(contribution.listCandidates({
      ...invocation(),
      source,
      cursor: firstPage.value.nextCursor,
      maxItems: 3,
    })).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
      retryable: true,
    });
  });

  it('pages bounded candidates with source-qualified identities and detects replacement', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-candidates-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const firstPath = await createConversation(brainDir, 'conversation-a', [
      '{"id":"a","type":"USER_INPUT","text":"first"}',
    ]);
    const secondPath = await createConversation(brainDir, 'conversation-b', [
      '{"id":"b","type":"USER_INPUT","text":"second"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' };

    const firstPage = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(firstPage).toMatchObject({
      ok: true,
      value: {
        candidates: [{
          remoteSessionId: expect.stringMatching(/^conversation-[ab]$/),
          linkData: { sourceRevision: expect.any(String) },
        }],
        nextCursor: expect.any(String),
      },
    });
    if (!firstPage.ok) throw new Error('candidate page unexpectedly failed');
    const firstCandidate = firstPage.value.candidates[0];
    if (!firstCandidate?.linkData) throw new Error('candidate linkData missing');

    const linked = await contribution.resolveLinkedIdentity({
      ...invocation(),
      source,
      remoteSessionId: firstCandidate.remoteSessionId,
      linkData: firstCandidate.linkData,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) throw new Error('linked identity unexpectedly failed');
    const canonicalBrainDir = await realpath(brainDir);
    expect(linked.value).toEqual({
      source: {
        kind: 'antigravityCliPrint',
        brainDir: canonicalBrainDir,
        conversationId: firstCandidate.remoteSessionId,
        sourceRevision: firstCandidate.linkData.sourceRevision,
      },
      remoteSessionId: firstCandidate.remoteSessionId,
      linkData: {
        sourceRevision: firstCandidate.linkData.sourceRevision,
      },
    });

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: {
        ...linked.value.source,
        conversationId: firstCandidate.remoteSessionId === 'conversation-a'
          ? 'conversation-b'
          : 'conversation-a',
      },
      remoteSessionId: firstCandidate.remoteSessionId,
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
    });

    const linkedPath = firstCandidate.remoteSessionId === 'conversation-a' ? firstPath : secondPath;
    await rename(linkedPath, `${linkedPath}.old`);
    await writeFile(linkedPath, '{"id":"replacement","type":"USER_INPUT","text":"replacement"}\n');
    await expect(contribution.resolveLinkedIdentity({
      ...invocation(),
      source,
      remoteSessionId: firstCandidate.remoteSessionId,
      linkData: firstCandidate.linkData,
    })).resolves.toMatchObject({
      ok: false,
      code: 'candidate_not_found',
    });
  });

  it('pages shared semantic projections and read-after preserves split-line custody', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-transcript-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-1', [
      '{"step_index":1,"type":"USER_INPUT","text":"inspect","created_at":"2026-07-23T08:00:00Z"}',
      '{"step_index":2,"type":"PLANNER_RESPONSE","text":"working","created_at":"2026-07-23T08:00:01Z"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' };
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source,
      remoteSessionId: 'conversation-1',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');

    const page = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-1',
      direction: 'older',
      maxItems: 2,
    });
    expect(page).toMatchObject({
      ok: true,
      value: {
        items: [
          { messageRole: 'user', raw: { type: 'text', text: 'inspect' } },
          { messageRole: 'agent', raw: { type: 'text', text: 'working' } },
        ],
        tailCursor: expect.any(String),
      },
    });
    if (!page.ok || !page.value.tailCursor) throw new Error('tail cursor missing');
    const tailCursor = page.value.tailCursor;

    await appendFile(transcriptPath, '{"step_index":3,"type":"PLANNER_RESPONSE","text":');
    const partial = await readAntigravityExternalTranscriptAfter({
      transcriptPath,
      conversationId: 'conversation-1',
      sourceRevision: String(identity.value.linkData.sourceRevision),
      cursor: tailCursor,
      maxItems: 10,
      maxBytes: 64 * 1024,
    });
    expect(partial).toMatchObject({ kind: 'already_current', cursor: tailCursor });
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-1',
      cursor: tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'already_current' },
    });

    await appendFile(transcriptPath, '"complete","created_at":"2026-07-23T08:00:02Z"}\n');
    const completed = await readAntigravityExternalTranscriptAfter({
      transcriptPath,
      conversationId: 'conversation-1',
      sourceRevision: String(identity.value.linkData.sourceRevision),
      cursor: tailCursor,
      maxItems: 10,
      maxBytes: 64 * 1024,
    });
    expect(completed).toMatchObject({
      kind: 'advanced',
      items: [{
        messageRole: 'agent',
        raw: { type: 'text', text: 'complete' },
      }],
    });
    if (completed.kind !== 'advanced') throw new Error('completed append was not advanced');
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-1',
      cursor: tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [{
          messageRole: 'agent',
          raw: { type: 'text', text: 'complete' },
        }],
      },
    });

    await appendFile(transcriptPath, 'not-json\n');
    await expect(readAntigravityExternalTranscriptAfter({
      transcriptPath,
      conversationId: 'conversation-1',
      sourceRevision: String(identity.value.linkData.sourceRevision),
      cursor: completed.nextCursor,
      maxItems: 10,
      maxBytes: 64 * 1024,
    })).resolves.toMatchObject({ kind: 'read_failed' });
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-1',
      cursor: completed.nextCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'read_failed' },
    });

    await writeFile(transcriptPath, [
      '{"step_index":1,"type":"USER_INPUT","text":"rewritten"}',
      `{"step_index":2,"type":"PLANNER_RESPONSE","text":"${'replacement-padding'.repeat(20)}"}`,
      '',
    ].join('\n'));
    await expect(readAntigravityExternalTranscriptAfter({
      transcriptPath,
      conversationId: 'conversation-1',
      sourceRevision: String(identity.value.linkData.sourceRevision),
      cursor: completed.nextCursor,
      maxItems: 10,
      maxBytes: 64 * 1024,
    })).resolves.toMatchObject({ kind: 'source_replaced' });
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-1',
      cursor: completed.nextCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_replaced' },
    });

    await writeFile(transcriptPath, '');
    await expect(readAntigravityExternalTranscriptAfter({
      transcriptPath,
      conversationId: 'conversation-1',
      sourceRevision: String(identity.value.linkData.sourceRevision),
      cursor: completed.nextCursor,
      maxItems: 10,
      maxBytes: 64 * 1024,
    })).resolves.toMatchObject({ kind: 'gap_or_cursor_expired' });
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-1',
      cursor: completed.nextCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'gap_or_cursor_expired' },
    });

    await rename(transcriptPath, `${transcriptPath}.missing`);
    await expect(readAntigravityExternalTranscriptAfter({
      transcriptPath,
      conversationId: 'conversation-1',
      sourceRevision: String(identity.value.linkData.sourceRevision),
      cursor: completed.nextCursor,
      maxItems: 10,
      maxBytes: 64 * 1024,
    })).resolves.toMatchObject({ kind: 'source_unavailable' });
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-1',
      cursor: completed.nextCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_unavailable' },
    });
  });

  it('preserves source availability and replacement in the public read-after result union', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-read-after-source-state-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-source-state', [
      '{"step_index":1,"type":"USER_INPUT","text":"start"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-source-state',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-source-state',
      direction: 'older',
      maxItems: 10,
    });
    if (!initial.ok || !initial.value.tailCursor) throw new Error('tail cursor missing');

    const missingPath = `${transcriptPath}.missing`;
    await rename(transcriptPath, missingPath);
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-source-state',
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_unavailable' },
    });
    await expect(contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-source-state',
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'unavailable',
    });

    await writeFile(transcriptPath, '{"step_index":1,"type":"USER_INPUT","text":"replacement"}\n');
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-source-state',
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: { outcome: 'source_replaced' },
    });
    await expect(contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-source-state',
      direction: 'older',
      maxItems: 10,
    })).resolves.toEqual({
      ok: true,
      value: {
        items: [],
        nextCursor: null,
        hasMore: false,
        truncated: true,
      },
    });
  });

  it('rejects a backward-page cursor after an in-place transcript rewrite', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-page-rewrite-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-page-rewrite', [
      '{"step_index":1,"type":"USER_INPUT","text":"original oldest"}',
      '{"step_index":2,"type":"PLANNER_RESPONSE","text":"original middle"}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","text":"original newest"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-page-rewrite',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');

    const firstPage = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-page-rewrite',
      direction: 'older',
      maxItems: 1,
    });
    expect(firstPage).toMatchObject({
      ok: true,
      value: {
        items: [{ raw: { type: 'text', text: 'original newest' } }],
        nextCursor: expect.any(String),
      },
    });
    if (!firstPage.ok || !firstPage.value.nextCursor) {
      throw new Error('backward-page cursor unexpectedly missing');
    }

    await writeFile(transcriptPath, [
      '{"step_index":1,"type":"USER_INPUT","text":"rewritten oldest with padding"}',
      '{"step_index":2,"type":"PLANNER_RESPONSE","text":"rewritten middle with padding"}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","text":"rewritten newest with padding"}',
      '',
    ].join('\n'));

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-page-rewrite',
      direction: 'older',
      cursor: firstPage.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        items: [],
        nextCursor: null,
        hasMore: false,
        truncated: true,
      },
    });
  });

  it('keeps a backward-page cursor valid when records append beyond its boundary', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-page-append-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-page-append', [
      '{"step_index":1,"type":"USER_INPUT","text":"oldest"}',
      '{"step_index":2,"type":"PLANNER_RESPONSE","text":"middle"}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","text":"newest"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-page-append',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');

    const firstPage = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-page-append',
      direction: 'older',
      maxItems: 1,
    });
    if (!firstPage.ok || !firstPage.value.nextCursor) {
      throw new Error('backward-page cursor unexpectedly missing');
    }

    await appendFile(
      transcriptPath,
      '{"step_index":4,"type":"PLANNER_RESPONSE","text":"appended after paging"}\n',
    );

    await expect(contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-page-append',
      direction: 'older',
      cursor: firstPage.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        items: [{ raw: { type: 'text', text: 'middle' } }],
      },
    });
  });

  it('advertises and drains complete appended records beyond one read-after item budget', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-read-after-budget-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-read-after', [
      '{"step_index":1,"type":"USER_INPUT","text":"start"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-read-after',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-read-after',
      direction: 'older',
      maxItems: 1,
    });
    if (!initial.ok || !initial.value.tailCursor) throw new Error('tail cursor missing');

    await appendFile(transcriptPath, [
      '{"step_index":2,"type":"PLANNER_RESPONSE","text":"first"}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","text":"second"}',
      '',
    ].join('\n'));
    const first = await contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-read-after',
      cursor: initial.value.tailCursor,
      maxItems: 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [{ raw: { type: 'text', text: 'first' } }],
        nextCursor: expect.any(String),
        boundary: expect.any(String),
      },
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('read-after continuation missing');

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-read-after',
      cursor: first.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [{ raw: { type: 'text', text: 'second' } }],
        boundary: expect.any(String),
      },
    });
  });

  it('reports skipped native records while advancing visible items', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-read-after-skips-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-read-after-skips', [
      '{"step_index":1,"type":"USER_INPUT","text":"start"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-read-after-skips',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-read-after-skips',
      direction: 'older',
      maxItems: 10,
    });
    if (!initial.ok || !initial.value.tailCursor) throw new Error('tail cursor missing');

    await appendFile(transcriptPath, [
      '{"step_index":2,"type":"UNSUPPORTED_RECORD","text":"ignored"}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","text":"visible"}',
      '',
    ].join('\n'));

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-read-after-skips',
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [{ raw: { type: 'text', text: 'visible' } }],
        diagnostics: [{
          code: 'unsupported_record_skipped',
          count: 1,
          positions: [expect.any(Number)],
        }],
      },
    });
  });

  it('reports malformed source UTF-8 with exact aggregate and bounded byte positions', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-malformed-utf8-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-malformed-utf8', [
      '{"step_index":1,"type":"USER_INPUT","text":"start"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-malformed-utf8',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-malformed-utf8',
      direction: 'older',
      maxItems: 10,
    });
    if (!initial.ok || !initial.value.tailCursor) throw new Error('tail cursor missing');

    const appendOffset = (await stat(transcriptPath)).size;
    const malformedLine = Buffer.from(
      '{"step_index":2,"type":"PLANNER_RESPONSE","text":"x"}\n',
      'utf8',
    );
    const malformedByteOffset = malformedLine.indexOf(Buffer.from('"x"', 'utf8')) + 1;
    malformedLine[malformedByteOffset] = 0xff;
    await appendFile(transcriptPath, malformedLine);

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-malformed-utf8',
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [],
        diagnostics: [{
          code: 'malformed_source_utf8',
          count: 1,
          positions: [appendOffset + malformedByteOffset],
        }],
      },
    });
  });

  it('honors complete serialized-result byte budgets without splitting a native record', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-budget-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    await createConversation(brainDir, 'conversation-budget', [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        text: 'a'.repeat(300),
        tool_calls: [{ name: 'list_dir', args: { path: '.' } }],
      }),
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });

    await expect(contribution.pageTranscript({
      ...invocation(180),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-budget',
      direction: 'older',
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });
});
