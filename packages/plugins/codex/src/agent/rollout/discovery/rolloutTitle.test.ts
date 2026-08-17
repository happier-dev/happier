import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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

const { mkdtemp, writeFile } = await import('node:fs/promises');

const {
  CODEX_ROLLOUT_TITLE_HEAD_BUDGET,
  readCodexSessionTitleFromRollout,
} = await import('./rolloutTitle.js');

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

function padded(prefix: string, bytes: number): string {
  return `${prefix} ${'x'.repeat(Math.max(0, bytes - prefix.length - 1))}`;
}

async function writeRollout(name: string, records: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-title-'));
  const filePath = join(root, `${name}.jsonl`);
  await writeFile(filePath, records.join(''), 'utf8');
  return filePath;
}

describe('Codex rollout title reader', () => {
  it('reads the first genuine message of a normal rollout head', async () => {
    const filePath = await writeRollout('normal', [
      messageRecord('user', 'Fix the Codex candidate title reader'),
      messageRecord('assistant', 'On it.'),
    ]);

    expect(await readCodexSessionTitleFromRollout(filePath, {}, CODEX_ROLLOUT_TITLE_HEAD_BUDGET))
      .toBe('Fix the Codex candidate title reader');
  });

  it('prefers a later explicit title tool over the opening user-message fallback', async () => {
    const filePath = await writeRollout('explicit-title-after-user', [
      messageRecord('user', 'Opening prompt that is only fallback evidence'),
      titleToolRecord('Explicit title from the session tool'),
      messageRecord('assistant', 'A later assistant fallback.'),
    ]);

    expect(await readCodexSessionTitleFromRollout(filePath, {}, CODEX_ROLLOUT_TITLE_HEAD_BUDGET))
      .toBe('Explicit title from the session tool');
  });

  it('stays identifier-only when the head carries nothing but harness boilerplate', async () => {
    const filePath = await writeRollout('boilerplate-only', [
      messageRecord('user', '# Session title\n\nAt the start of the session, call the change_title tool.'),
      messageRecord('user', '<environment_context>cwd=/tmp</environment_context>'),
    ]);

    expect(await readCodexSessionTitleFromRollout(filePath, {}, CODEX_ROLLOUT_TITLE_HEAD_BUDGET))
      .toBeNull();
  });

  it('finds the title past an oversized boilerplate preamble that outweighs the considered-byte budget', async () => {
    // The shape a session started through this harness actually has: a handful
    // of very large records the reader rejects anyway, and the real title
    // sitting past the point where charging those records would have stopped it.
    const filePath = await writeRollout('oversized-preamble', [
      messageRecord('user', padded('# Session title\n\nAt the start of the session, call the change_title tool.', 90 * 1024)),
      opaqueRecord(90 * 1024),
      messageRecord('user', padded('<environment_context>', 90 * 1024)),
      messageRecord('user', 'Fix the Codex candidate title reader'),
      messageRecord('assistant', 'On it.'),
    ]);

    expect(await readCodexSessionTitleFromRollout(filePath, {}, CODEX_ROLLOUT_TITLE_HEAD_BUDGET))
      .toBe('Fix the Codex candidate title reader');
  });

  it('bounds the read on a pathological rollout whose head is multi-megabyte records', async () => {
    const filePath = await writeRollout('pathological', [
      opaqueRecord(2 * 1024 * 1024),
      opaqueRecord(2 * 1024 * 1024),
      messageRecord('user', 'A title no bounded head read can reach'),
    ]);

    const stopRecording = recordFileReads();
    const title = await readCodexSessionTitleFromRollout(filePath, {}, CODEX_ROLLOUT_TITLE_HEAD_BUDGET);
    const bytesRead = stopRecording();

    expect(title).toBeNull();
    // The stated worst case of one head read: 512 KB traversed, whatever the
    // records in the way are shaped like.
    expect(bytesRead).toBeLessThanOrEqual(512 * 1024);
  });
});
