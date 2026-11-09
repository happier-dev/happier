import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { buildHappierBaseSystemPromptV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

/**
 * The only mocked boundary is the filesystem itself, and every call still runs
 * the real `node:fs/promises` implementation underneath. The wrapper exists to
 * count the bytes one title read actually pulls off disk, which is the bound
 * under test: a rollout whose head is pathological may not become an unbounded
 * read.
 */
const fileReads = vi.hoisted(() => ({ bytes: 0, recording: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle) as typeof handle.read;
    return Object.assign(handle, {
      read: async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...(readArgs as Parameters<typeof read>));
        if (fileReads.recording) fileReads.bytes += result.bytesRead;
        return result;
      },
    }) as typeof handle;
  };
  return { ...actual, default: actual, open };
});

const { mkdtemp, writeFile, rm } = await import('node:fs/promises');

const { readCodexRolloutHead } = await import('./rolloutTitle.js');

function recordFileReads(): () => number {
  fileReads.bytes = 0;
  fileReads.recording = true;
  return () => {
    fileReads.recording = false;
    return fileReads.bytes;
  };
}

function messageRecord(role: string, text: string): string {
  return `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: 'input_text', text }] },
  })}\n`;
}

function titleToolRecord(title: string): string {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'session_title_set',
      call_id: 'title-call-1',
      arguments: JSON.stringify({ title }),
    },
  })}\n`;
}

function opaqueRecord(bytes: number): string {
  return `${JSON.stringify({ type: 'world_state', payload: { blob: 'w'.repeat(bytes) } })}\n`;
}

async function writeRollout(name: string, records: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-title-'));
  const filePath = join(root, `${name}.jsonl`);
  await writeFile(filePath, records.join(''), 'utf8');
  return filePath;
}

describe('Codex rollout title reader', () => {
  it('retains head classification when a later record exceeds the advisory title allowance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-large-title-'));
    try {
      const filePath = join(root, 'rollout.jsonl');
      await writeFile(filePath, JSON.stringify({ type: 'session_meta', payload: { id: 'large-record', cwd: '/repo', thread_source: 'guardian_review' } }) + '\n'
        + opaqueRecord(2 * 1024 * 1024));
      const head = await readCodexRolloutHead(filePath, {});
      expect(head).toMatchObject({ title: null, cwd: '/repo' });
      expect(head.thread).toMatchObject({ kind: 'reviewer' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains cwd from the title head read and removes Happier prompt text before deriving its title', async () => {
    const filePath = await writeRollout('native-prompt', [
      JSON.stringify({ type: 'session_meta', payload: { id: 'native-prompt', cwd: '/repo/happier' } }) + '\n',
      messageRecord('user', `${buildHappierBaseSystemPromptV1()}\n\nStabilise CI on the release branch`),
    ]);
    expect(await readCodexRolloutHead(filePath, {})).toMatchObject({
      title: 'Stabilise CI on the release branch', cwd: '/repo/happier',
    });
  });
  it('reads the first genuine message of a normal rollout head', async () => {
    const filePath = await writeRollout('normal', [
      messageRecord('user', 'Fix the Codex candidate title reader'),
      messageRecord('assistant', 'On it.'),
    ]);

    expect((await readCodexRolloutHead(filePath, {})).title)
      .toBe('Fix the Codex candidate title reader');
  });

  it('prefers a later explicit title tool over the opening user-message fallback', async () => {
    const filePath = await writeRollout('explicit-title-after-user', [
      messageRecord('user', 'Opening prompt that is only fallback evidence'),
      titleToolRecord('Explicit title from the session tool'),
      messageRecord('assistant', 'A later assistant fallback.'),
    ]);

    expect((await readCodexRolloutHead(filePath, {})).title)
      .toBe('Explicit title from the session tool');
  });

  it.each([
    ['a large opening message', [messageRecord('user', 'Opening prompt '.repeat(12 * 1024))]],
    ['many opening messages', Array.from({ length: 2000 }, () => messageRecord('user', 'Opening prompt'))],
  ] as const)('finds an explicit title inside the same head after %s', async (_name, openingRecords) => {
    const filePath = await writeRollout('explicit-title-within-head', [
      ...openingRecords,
      titleToolRecord('Explicit title within the title head'),
      opaqueRecord(2 * 1024 * 1024),
    ]);

    const stopRecording = recordFileReads();
    const head = await readCodexRolloutHead(filePath, {});
    const bytesRead = stopRecording();

    expect(head.title).toBe('Explicit title within the title head');
    expect(bytesRead).toBeLessThanOrEqual(512 * 1024);
  });

  it('keeps the earliest append-stable explicit title event', async () => {
    const filePath = await writeRollout('earliest-explicit-title', [
      messageRecord('user', 'Opening prompt that is only fallback evidence'),
      titleToolRecord('First explicit title'),
      titleToolRecord('Later mutable rename'),
    ]);

    expect((await readCodexRolloutHead(filePath, {})).title)
      .toBe('First explicit title');
  });

  it('does not derive an immutable candidate title from assistant prose', async () => {
    const filePath = await writeRollout('assistant-only', [
      messageRecord('assistant', 'Assistant-authored summary is mutable output.'),
    ]);

    expect((await readCodexRolloutHead(filePath, {})).title)
      .toBeNull();
  });

  it('stays identifier-only when the head carries nothing but harness boilerplate', async () => {
    const filePath = await writeRollout('boilerplate-only', [
      messageRecord('user', buildHappierBaseSystemPromptV1()),
      messageRecord('user', '<environment_context>cwd=/tmp</environment_context>'),
    ]);

    expect((await readCodexRolloutHead(filePath, {})).title)
      .toBeNull();
  });

  it('finds the title past a large boilerplate preamble within the same head', async () => {
    // The shape a session started through this harness actually has: a handful
    // of very large records the reader rejects anyway, and the real title
    // sitting past the point where charging those records would have stopped it.
    const hostPrompt = buildHappierBaseSystemPromptV1();
    const repeatedHostPrompt = Array.from({ length: Math.ceil(90 * 1024 / Buffer.byteLength(hostPrompt)) }, () => hostPrompt).join('\n\n');
    const filePath = await writeRollout('oversized-preamble', [
      messageRecord('user', repeatedHostPrompt),
      opaqueRecord(90 * 1024),
      messageRecord('user', `<environment_context>${'x'.repeat(90 * 1024)}`),
      messageRecord('user', 'Fix the Codex candidate title reader'),
      messageRecord('assistant', 'On it.'),
    ]);

    expect((await readCodexRolloutHead(filePath, {})).title)
      .toBe('Fix the Codex candidate title reader');
  });

  it('bounds the read on a pathological rollout whose head is multi-megabyte records', async () => {
    const filePath = await writeRollout('pathological', [
      opaqueRecord(2 * 1024 * 1024),
      opaqueRecord(2 * 1024 * 1024),
      messageRecord('user', 'A title no bounded head read can reach'),
    ]);

    const stopRecording = recordFileReads();
    const { title } = await readCodexRolloutHead(filePath, {});
    const bytesRead = stopRecording();

    expect(title).toBeNull();
    // The stated worst case of one head read: 512 KB traversed, whatever the
    // records in the way are shaped like.
    expect(bytesRead).toBeLessThanOrEqual(512 * 1024);
  });
});
