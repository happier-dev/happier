import { appendFile, mkdir, opendir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createAntigravityExternalSessionsContribution,
  readAntigravityExternalTranscriptAfter,
} from './externalSessions.js';
import { snapshotAntigravityTranscriptSource } from './transcript/jsonl.js';

function userRaw(text: string) {
  return { role: 'user', content: { type: 'text', text } };
}

function agentMessageRaw(message: string) {
  return {
    role: 'agent',
    content: { type: 'acp', agentId: 'antigravity', data: { type: 'message', message } },
  };
}

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
  it('rejects exact identity and transcript reads through a conversation alias outside the brain root', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-escaped-conversation-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const outsideBrainDir = join(home, 'outside-brain');
    const outsideTranscriptPath = await createConversation(outsideBrainDir, 'conversation-escaped', [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', text: 'outside transcript' }),
    ]);
    const snapshot = await snapshotAntigravityTranscriptSource(outsideTranscriptPath);
    if (!snapshot) throw new Error('missing escaped transcript snapshot');
    await mkdir(brainDir, { recursive: true });
    await symlink(
      join(outsideBrainDir, 'conversation-escaped'),
      join(brainDir, 'conversation-escaped'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = {
      kind: 'antigravityCliPrint' as const,
      brainDir,
      conversationId: 'conversation-escaped',
      sourceRevision: snapshot.sourceRevision,
    };

    const [identity, page] = await Promise.all([
      contribution.resolveLinkIdentity({
        ...invocation(),
        source,
        remoteSessionId: 'conversation-escaped',
      }),
      contribution.pageTranscript({
        ...invocation(),
        source,
        remoteSessionId: 'conversation-escaped',
        direction: 'older',
        maxItems: 10,
      }),
    ]);

    expect(identity).toMatchObject({ ok: false, code: 'candidate_not_found' });
    expect(page).toMatchObject({ ok: false, code: 'candidate_not_found' });
  });

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
    expect(firstPage.value).toMatchObject({
      preparation: { kind: 'building_candidate_index', scanned: 3 },
    });
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

  it('hands a newer candidate discovered in a later filesystem chunk to canonical index preparation', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-traversal-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const firstPath = await createConversation(brainDir, 'conversation-traversal-first', [
      '{"id":"first","type":"USER_INPUT","text":"first"}',
    ]);
    const laterPath = await createConversation(brainDir, 'conversation-traversal-later', [
      '{"id":"later","type":"USER_INPUT","text":"later"}',
    ]);
    const directory = await opendir(brainDir);
    const traversal = [] as string[];
    for await (const entry of directory) {
      if (entry.isDirectory()) traversal.push(entry.name);
    }
    const newestId = traversal.at(-1) === 'conversation-traversal-first'
      ? 'conversation-traversal-first'
      : 'conversation-traversal-later';
    const newestPath = newestId === 'conversation-traversal-first' ? firstPath : laterPath;
    const newestTimestamp = new Date('2026-07-22T10:00:00.000Z');
    const olderTimestamp = new Date('2026-07-20T10:00:00.000Z');
    await Promise.all([
      utimes(firstPath, olderTimestamp, firstPath === newestPath ? newestTimestamp : olderTimestamp),
      utimes(laterPath, olderTimestamp, laterPath === newestPath ? newestTimestamp : olderTimestamp),
    ]);

    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' as const };
    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.any(Object)],
        nextCursor: expect.any(String),
        preparation: { kind: 'building_candidate_index', scanned: 1 },
      },
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('expected later traversal cursor');
    expect(first.value.candidates[0]?.remoteSessionId).not.toBe(newestId);

    const second = await contribution.listCandidates({
      ...invocation(),
      source,
      cursor: first.value.nextCursor,
      maxItems: 1,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.objectContaining({
          remoteSessionId: newestId,
          updatedAtMs: newestTimestamp.getTime(),
        })],
        preparation: { kind: 'building_candidate_index', scanned: 2 },
      },
    });
  });

  // A full search reads one bounded directory chunk per public call. The first
  // call must not drain later chunks to answer with a globally ordered page: it
  // serves its own chunk's matches as deterministic partial state, and the
  // query-bound continuation resumes the walk without repeating or skipping a
  // match.
  it('serves one bounded full-search chunk per call and resumes without duplicates or skips', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-search-chunked-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const paths: Record<string, string> = {};
    for (const [index, id] of ['alpha', 'bravo', 'charlie'].entries()) {
      paths[id] = await createConversation(brainDir, `conversation-chunked-${id}`, [
        `{"id":"${id}","type":"USER_INPUT","text":"chunk probe candidate ${index}"}`,
      ]);
    }
    const directory = await opendir(brainDir);
    const traversal: string[] = [];
    for await (const entry of directory) {
      if (entry.isDirectory()) traversal.push(entry.name);
    }
    expect(traversal).toHaveLength(3);
    // Recency ascends along the traversal, so the newest match lives in the
    // last chunk and a draining first call would answer with a different page.
    const modifiedAt = (index: number) => new Date(Date.parse('2026-07-20T10:00:00.000Z') + index * 86_400_000);
    await Promise.all(traversal.map((entry, index) => {
      const path = paths[entry.replace('conversation-chunked-', '')]!;
      return utimes(path, modifiedAt(index), modifiedAt(index));
    }));

    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' as const };
    const search = { searchTerm: 'chunk probe', searchMode: 'full' as const };
    const served: string[] = [];

    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      ...search,
      maxItems: 1,
    });
    if (!first.ok) throw new Error('first full-search chunk unexpectedly failed');
    expect(first.value.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([traversal[0]]);
    expect(first.value.searchIncomplete).toBe(true);
    expect(first.value.nextCursor).toEqual(expect.any(String));
    served.push(...first.value.candidates.map((candidate) => candidate.remoteSessionId));

    let cursor = first.value.nextCursor;
    for (const entry of traversal.slice(1)) {
      if (!cursor) throw new Error('full-search continuation unexpectedly missing');
      const page = await contribution.listCandidates({
        ...invocation(),
        source,
        ...search,
        cursor,
        maxItems: 1,
      });
      if (!page.ok) throw new Error('full-search continuation unexpectedly failed');
      expect(page.value.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([entry]);
      served.push(...page.value.candidates.map((candidate) => candidate.remoteSessionId));
      expect(page.value.searchIncomplete).toBe(true);
      expect(page.value.nextCursor).toEqual(expect.any(String));
      cursor = page.value.nextCursor;
    }

    // The chunk boundary past the last entry is not known to be the end until
    // the next bounded scan comes back empty and completes the search.
    if (!cursor) throw new Error('terminal continuation unexpectedly missing');
    const terminal = await contribution.listCandidates({
      ...invocation(),
      source,
      ...search,
      cursor,
      maxItems: 1,
    });
    expect(terminal).toMatchObject({
      ok: true,
      value: { candidates: [], nextCursor: null },
    });
    if (terminal.ok) expect(terminal.value).not.toHaveProperty('searchIncomplete');

    expect(served).toEqual(traversal);
  });

  // A full-search cursor is an ordering ANCHOR over a mutable recency key: a
  // conversation the user is still driving keeps touching its transcript. Every
  // never-served match a later chunk holds must order after the served anchor —
  // one that does not means the prefix the walk already served is no longer a
  // prefix of the current ordering, and answering the chunk would skip or
  // repeat a match.
  it('rejects a full-search continuation whose unserved match overtook the anchor', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-search-reorder-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const paths: Record<string, string> = {};
    for (const [index, id] of ['alpha', 'bravo', 'charlie'].entries()) {
      paths[id] = await createConversation(brainDir, `conversation-reorder-${id}`, [
        `{"id":"${id}","type":"USER_INPUT","text":"reorder probe candidate ${index}"}`,
      ]);
    }
    const directory = await opendir(brainDir);
    const traversal: string[] = [];
    for await (const entry of directory) {
      if (entry.isDirectory()) traversal.push(entry.name);
    }
    const shortId = (entry: string) => entry.replace('conversation-reorder-', '');
    expect(traversal).toHaveLength(3);
    const at = (iso: string) => new Date(iso);
    // The first chunk holds the newest match and becomes the anchor; the
    // trailing chunk holds only never-served older matches.
    await Promise.all(traversal.map((entry, index) => {
      const modified = index === 0 ? '2026-07-22T10:00:00.000Z' : '2026-07-21T10:00:00.000Z';
      return utimes(paths[shortId(entry)]!, at('2026-07-20T10:00:00.000Z'), at(modified));
    }));

    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' as const };
    const search = { searchTerm: 'reorder probe', searchMode: 'full' as const };

    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      ...search,
      maxItems: 1,
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('expected full-search continuation');
    expect(first.value.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([traversal[0]]);

    // The last conversation was never served and now outranks the anchor the
    // cursor was cut at; the middle one was never served and still trails it.
    await utimes(paths[shortId(traversal.at(-1)!)], at('2026-07-20T10:00:00.000Z'), at('2026-07-23T10:00:00.000Z'));

    const second = await contribution.listCandidates({
      ...invocation(),
      source,
      ...search,
      cursor: first.value.nextCursor,
      maxItems: 5,
    });

    // Either serve it or declare the cursor stale — never answer "these are the
    // remaining matches" with the overtaking match dropped.
    if (second.ok) {
      expect(second.value.candidates.map((candidate) => candidate.remoteSessionId)).toContain(
        traversal.at(-1),
      );
    } else {
      expect(second).toMatchObject({ ok: false, code: 'source_invalid', retryable: true });
    }
  });

  // Two compensating changes — a never-served match overtaking the anchor while
  // an already-served one vanishes — leave the conversation directory set
  // intact, so the brain-dir generation cannot see them either. The
  // continuation must not answer "these are the remaining matches" over a
  // served prefix that is no longer a prefix of the current ordering.
  it('rejects a full-search continuation whose anchor prefix changed without changing its size', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-search-alias-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const paths: Record<string, string> = {};
    for (const [index, id] of ['alpha', 'bravo', 'charlie', 'delta'].entries()) {
      paths[id] = await createConversation(brainDir, `conversation-alias-${id}`, [
        `{"id":"${id}","type":"USER_INPUT","text":"alias probe candidate ${index}"}`,
      ]);
    }
    const directory = await opendir(brainDir);
    const traversal: string[] = [];
    for await (const entry of directory) {
      if (entry.isDirectory()) traversal.push(entry.name);
    }
    const shortId = (entry: string) => entry.replace('conversation-alias-', '');
    expect(traversal).toHaveLength(4);
    const at = (iso: string) => new Date(iso);
    // The first chunk holds the two newest matches and serves both; the
    // trailing chunk holds only never-served older matches.
    const modifiedTimes = [
      '2026-07-24T10:00:00.000Z',
      '2026-07-23T10:00:00.000Z',
      '2026-07-22T10:00:00.000Z',
      '2026-07-21T10:00:00.000Z',
    ];
    await Promise.all(traversal.map((entry, index) => {
      return utimes(paths[shortId(entry)]!, at('2026-07-20T10:00:00.000Z'), at(modifiedTimes[index]!));
    }));

    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' as const };
    const search = { searchTerm: 'alias probe', searchMode: 'full' as const };

    const first = await contribution.listCandidates({
      ...invocation(),
      source,
      ...search,
      maxItems: 2,
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('expected full-search continuation');
    expect(first.value.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
      traversal[0],
      traversal[1],
    ]);

    // `traversal[2]` was never served and overtakes the `traversal[1]` anchor,
    // while `traversal[0]` — already served — loses its transcript file. The
    // conversation directory survives, so the brain-dir generation is unchanged.
    await utimes(paths[shortId(traversal[2]!)], at('2026-07-20T10:00:00.000Z'), at('2026-07-25T10:00:00.000Z'));
    await rm(paths[shortId(traversal[0]!)]!);

    const second = await contribution.listCandidates({
      ...invocation(),
      source,
      ...search,
      cursor: first.value.nextCursor,
      maxItems: 5,
    });

    // Never answer "these are the remaining matches" with the overtaking match
    // silently dropped: the served prefix changed, so the cursor is stale.
    expect(second).toMatchObject({ ok: false, code: 'source_invalid', retryable: true });
    if (second.ok) {
      expect(second.value.candidates.map((candidate) => candidate.remoteSessionId)).toContain(
        traversal[2],
      );
    }
  });

  it('marks a terminal full search complete instead of retaining its fast-preview state', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-terminal-full-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    await createConversation(brainDir, 'conversation-terminal-full', [
      '{"id":"terminal","type":"USER_INPUT","text":"complete full search result"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const fast = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      searchTerm: 'complete full search',
      searchMode: 'fast',
      maxItems: 1,
    });
    expect(fast).toMatchObject({
      ok: true,
      value: { searchIncomplete: true },
    });

    const result = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      searchTerm: 'complete full search',
      searchMode: 'full',
      maxItems: 1,
    });
    if (!result.ok) throw new Error('full-search chunk unexpectedly failed');
    expect(result.value.candidates).toEqual([
      expect.objectContaining({ remoteSessionId: 'conversation-terminal-full' }),
    ]);
    expect(result.value.searchIncomplete).toBe(true);
    if (!result.value.nextCursor) throw new Error('expected full-search continuation');

    // The chunk boundary past the only conversation is not the end of the
    // source; the next bounded scan comes back empty and completes the search
    // without retaining the fast-preview state.
    const terminal = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      cursor: result.value.nextCursor,
      searchTerm: 'complete full search',
      searchMode: 'full',
      maxItems: 1,
    });
    expect(terminal).toMatchObject({
      ok: true,
      value: { candidates: [], nextCursor: null },
    });
    if (terminal.ok) expect(terminal.value).not.toHaveProperty('searchIncomplete');
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

    const linkedTranscript = await contribution.pageTranscript({
      ...invocation(),
      source: linked.value.source,
      remoteSessionId: linked.value.remoteSessionId,
      direction: 'older',
      maxItems: 10,
    });
    expect(linkedTranscript).toMatchObject({
      ok: true,
      value: {
        items: [expect.objectContaining({ messageRole: 'user' })],
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
          { messageRole: 'user', raw: userRaw('inspect') },
          { messageRole: 'agent', raw: agentMessageRaw('working') },
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
        raw: agentMessageRaw('complete'),
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
          raw: agentMessageRaw('complete'),
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
        items: [{ raw: agentMessageRaw('original newest') }],
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
        items: [{ raw: agentMessageRaw('middle') }],
      },
    });
  });

  it('correlates id-less tool results at transcript page and read-after boundaries', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-tool-boundary-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-tool-boundary', [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ id: 'tool-call-before-page', name: 'list_dir', args: { path: '.' } }],
      }),
      JSON.stringify({ step_index: 2, type: 'LIST_DIRECTORY', content: ['README.md'] }),
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' as const };

    const backward = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'conversation-tool-boundary',
      direction: 'older',
      maxItems: 1,
    });
    expect(backward).toMatchObject({
      ok: true,
      value: {
        items: [{
          raw: {
            content: {
              data: { type: 'tool-result', callId: 'tool-call-before-page' },
            },
          },
        }],
      },
    });

    const tail = await contribution.pageTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'conversation-tool-boundary',
      direction: 'older',
      maxItems: 10,
    });
    if (!tail.ok || !tail.value.tailCursor) throw new Error('tail cursor missing');

    await appendFile(transcriptPath, [
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ id: 'tool-call-across-read-after', name: 'view_file', args: { path: 'README.md' } }],
      }),
      JSON.stringify({ step_index: 4, type: 'VIEW_FILE', content: '# README' }),
      '',
    ].join('\n'));

    const planner = await contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'conversation-tool-boundary',
      cursor: tail.value.tailCursor,
      maxItems: 1,
    });
    if (!planner.ok || planner.value.outcome !== 'advanced') {
      throw new Error('planner continuation unexpectedly failed');
    }

    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source,
      remoteSessionId: 'conversation-tool-boundary',
      cursor: planner.value.nextCursor,
      maxItems: 1,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [{
          raw: {
            content: {
              data: { type: 'tool-result', callId: 'tool-call-across-read-after' },
            },
          },
        }],
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
        items: [{ raw: agentMessageRaw('first') }],
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
        items: [{ raw: agentMessageRaw('second') }],
        boundary: expect.any(String),
      },
    });
  });

  it('declares an older page incomplete instead of finalizing history past an unknown record', async () => {
    const home = await mkdir(
      join(tmpdir(), `antigravity-external-page-unknown-${Date.now()}-`),
      { recursive: true },
    );
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    await createConversation(brainDir, 'conversation-page-unknown', [
      '{"step_index":1,"type":"USER_INPUT","text":"oldest visible"}',
      '{"step_index":2,"type":"FUTURE_RECORD_KIND","payload":{"turn":"unreadable"}}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","text":"newest visible"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-page-unknown',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');

    // A page has no diagnostics channel, so an unreadable record can only be
    // reported by declaring the page incomplete. Returning the older rows as an
    // ordinary success would finalize a history with a hole the user can never
    // recover, and would hand back a cursor that walks straight past it.
    const page = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-page-unknown',
      direction: 'older',
      maxItems: 10,
    });

    expect(page).toMatchObject({
      ok: true,
      value: {
        items: [{ raw: agentMessageRaw('newest visible') }],
        nextCursor: null,
        hasMore: false,
        truncated: true,
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
        items: [{ raw: agentMessageRaw('visible') }],
        diagnostics: [{
          code: 'unsupported_record_skipped',
          count: 1,
          positions: [expect.any(Number)],
        }],
      },
    });
  });

  it('separates a recognized non-transcript record from one this build cannot read', async () => {
    const home = await mkdir(
      join(tmpdir(), `antigravity-external-read-after-known-skips-${Date.now()}-`),
      { recursive: true },
    );
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-known-skips', [
      '{"step_index":1,"type":"USER_INPUT","text":"start"}',
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-known-skips',
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');
    const initial = await contribution.pageTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-known-skips',
      direction: 'older',
      maxItems: 10,
    });
    if (!initial.ok || !initial.value.tailCursor) throw new Error('tail cursor missing');

    await appendFile(transcriptPath, [
      '{"step_index":2,"type":"CHECKPOINT","checkpointId":"cp-1"}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","text":"visible"}',
      '',
    ].join('\n'));

    // A checkpoint is a record this build reads and deliberately does not
    // project. The host counts every other skip code as a REQUIRED item
    // failure, so reporting an omission as unreadable history is wrong in the
    // direction that matters.
    await expect(contribution.readAfterTranscript({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: 'conversation-known-skips',
      cursor: initial.value.tailCursor,
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [{ raw: agentMessageRaw('visible') }],
        diagnostics: [{
          code: 'non_transcript_record_skipped',
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

  it('browses, links, and reloads with a strict declared source and durable revision linkData', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-link-identity-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    await createConversation(brainDir, 'conversation-identity', [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\ninspect\n</USER_REQUEST>' }),
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
    const source = { kind: 'antigravityCliPrint' };

    const candidates = await contribution.listCandidates({
      ...invocation(),
      source,
      maxItems: 5,
    });
    if (!candidates.ok) throw new Error('candidate browse unexpectedly failed');
    const candidate = candidates.value.candidates[0];
    if (!candidate?.linkData) throw new Error('candidate linkData unexpectedly missing');

    const identity = await contribution.resolveLinkIdentity({
      ...invocation(),
      source,
      remoteSessionId: candidate.remoteSessionId,
      linkData: candidate.linkData,
    });
    if (!identity.ok) throw new Error('identity unexpectedly failed');
    const canonicalBrainDir = await realpath(brainDir);
    expect(identity.value).toEqual({
      source: {
        kind: 'antigravityCliPrint',
        brainDir: canonicalBrainDir,
        conversationId: 'conversation-identity',
        sourceRevision: candidate.linkData.sourceRevision,
      },
      remoteSessionId: 'conversation-identity',
      linkData: {
        sourceRevision: candidate.linkData.sourceRevision,
      },
    });

    const linked = await contribution.resolveLinkedIdentity({
      ...invocation(),
      source: identity.value.source,
      remoteSessionId: identity.value.remoteSessionId,
      linkData: identity.value.linkData,
    });
    if (!linked.ok) throw new Error('linked identity unexpectedly failed');
    expect(linked.value).toEqual(identity.value);
  });

  it.each(['fast', 'full'] as const)('searches candidate titles in %s mode', async (searchMode) => {
    const home = join(tmpdir(), `antigravity-external-candidate-title-${searchMode}-${Date.now()}-`);
    await mkdir(home, { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    await createConversation(brainDir, 'conversation-title', [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nAudit   the\nlink flow\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnoise\n</ADDITIONAL_METADATA>',
      }),
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });

    const page = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      maxItems: 5,
      searchTerm: 'link flow',
      searchMode,
    });
    if (!page.ok) throw new Error('candidate page unexpectedly failed');
    expect(page.value.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: 'conversation-title',
        title: 'Audit the link flow',
      }),
    ]);

    const idPage = await contribution.listCandidates({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      maxItems: 5,
      searchTerm: 'conversation-title',
      searchMode,
    });
    if (!idPage.ok) throw new Error('candidate id search unexpectedly failed');
    expect(idPage.value.candidates).toEqual([
      expect.objectContaining({ remoteSessionId: 'conversation-title' }),
    ]);
  });

  // One valid planner record projects to assistant text PLUS one public item per
  // tool call. Budgeting native records by the PUBLIC item limit and then
  // refusing the flattened result makes that record permanently unreadable at a
  // small page size: every retry reads the same record and fails the same way.
  it('pages a one-to-many native record across item-budgeted pages instead of refusing it', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-intra-record-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    await createConversation(brainDir, 'conversation-intra', [
      JSON.stringify({ step_index: 1, type: 'USER_MESSAGE', text: 'hi' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        text: 'planned answer',
        tool_calls: [
          { name: 'list_dir', args: { path: '.' } },
          { name: 'read_file', args: { path: 'a.ts' } },
        ],
      }),
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });

    const complete = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-intra',
      direction: 'older',
      maxItems: 50,
    });
    if (!complete.ok) throw new Error('expected a complete page');
    const expectedIds = complete.value.items.map((item) => item.id);
    expect(expectedIds).toHaveLength(4);

    const drainedNewestFirst: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page += 1) {
      const result = await contribution.pageTranscript({
        ...invocation(),
        source: { kind: 'antigravityCliPrint' },
        remoteSessionId: 'conversation-intra',
        direction: 'older',
        ...(cursor ? { cursor } : {}),
        maxItems: 1,
      });
      if (!result.ok) throw new Error(`page ${page} failed: ${result.code}`);
      expect(result.value.items.length).toBeLessThanOrEqual(1);
      drainedNewestFirst.unshift(...result.value.items.map((item) => item.id));
      if (!result.value.hasMore) {
        expect(result.value.nextCursor).toBeNull();
        break;
      }
      expect(result.value.nextCursor).toBeTruthy();
      cursor = result.value.nextCursor ?? undefined;
    }

    // Deterministic order, no duplication, eventual progress.
    expect(drainedNewestFirst).toEqual(expectedIds);
  });

  it('drains a one-to-many native record across read-after item budgets without repeating an item', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-intra-after-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const transcriptPath = await createConversation(brainDir, 'conversation-intra-after', [
      JSON.stringify({ step_index: 1, type: 'USER_MESSAGE', text: 'hi' }),
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });

    const head = await contribution.pageTranscript({
      ...invocation(),
      source: { kind: 'antigravityCliPrint' },
      remoteSessionId: 'conversation-intra-after',
      direction: 'older',
      maxItems: 50,
    });
    if (!head.ok || !head.value.tailCursor) throw new Error('expected a tail cursor');

    await appendFile(transcriptPath, `${JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      text: 'planned answer',
      tool_calls: [
        { name: 'list_dir', args: { path: '.' } },
        { name: 'read_file', args: { path: 'a.ts' } },
      ],
    })}\n`);

    const drained: string[] = [];
    let cursor = head.value.tailCursor;
    for (let read = 0; read < 12; read += 1) {
      const result = await contribution.readAfterTranscript({
        ...invocation(),
        source: { kind: 'antigravityCliPrint' },
        remoteSessionId: 'conversation-intra-after',
        cursor,
        maxItems: 1,
      });
      if (!result.ok) throw new Error(`read-after ${read} failed: ${result.code}`);
      if (result.value.outcome === 'already_current') break;
      if (result.value.outcome !== 'advanced') {
        throw new Error(`unexpected read-after outcome ${result.value.outcome}`);
      }
      expect(result.value.items.length).toBeLessThanOrEqual(1);
      drained.push(...result.value.items.map((item) => item.id));
      cursor = result.value.nextCursor;
    }

    expect(drained).toEqual([
      'antigravity-turn-conversation-intra-after-byte-51-step-2',
      'antigravity-turn-conversation-intra-after-byte-51-step-2-tool-1',
      'antigravity-turn-conversation-intra-after-byte-51-step-2-tool-2',
    ]);
  });

  it('classifies a transcript that cannot fit a valid result budget as a nonretryable producer error', async () => {
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
      code: 'agent_error',
      retryable: false,
    });
  });

  it('classifies an unfit candidate envelope as a nonretryable producer error', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-external-candidate-budget-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    const conversationId = `conversation-${'x'.repeat(160)}`;
    await createConversation(brainDir, conversationId, [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', text: 'candidate' }),
    ]);
    const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });

    await expect(contribution.listCandidates({
      ...invocation(120),
      source: { kind: 'antigravityCliPrint' },
      maxItems: 10,
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_error',
      retryable: false,
    });
  });
});
