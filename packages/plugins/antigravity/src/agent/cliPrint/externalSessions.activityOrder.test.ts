import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Real filesystem; only transcript opens are counted, to prove Browse reads
// heads for the page it shows rather than the whole store.
const fsProbe = vi.hoisted(() => ({ transcriptOpens: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).endsWith('transcript_full.jsonl')) fsProbe.transcriptOpens += 1;
      return await actual.open(...args);
    },
  };
});

const { createAntigravityExternalSessionsContribution } = await import('./externalSessions.js');

function invocation() {
  return { signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000, maxSerializedBytes: 64 * 1024 };
}

describe('Antigravity Browse in activity order', () => {
  it('serves the newest conversations by transcript activity and reads heads only for the page', async () => {
    const home = await mkdir(join(tmpdir(), `antigravity-activity-${Date.now()}-`), { recursive: true });
    const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
    try {
      const count = 120;
      // Created first = most recently active: creation order is the reverse of activity.
      for (let index = 0; index < count; index += 1) {
        const id = `conversation-${String(index).padStart(3, '0')}`;
        const logsDir = join(brainDir, id, '.system_generated', 'logs');
        await mkdir(logsDir, { recursive: true });
        const transcriptPath = join(logsDir, 'transcript_full.jsonl');
        await writeFile(transcriptPath, `${JSON.stringify({ id: `entry-${index}`, type: 'USER_INPUT', text: `title ${index}` })}\n`);
        const activity = new Date(Date.UTC(2026, 0, 1) + (count - index) * 60_000);
        await utimes(transcriptPath, activity, activity);
      }
      const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
      const source = { kind: 'antigravityCliPrint' };
      fsProbe.transcriptOpens = 0;
      const first = await contribution.listCandidates({ ...invocation(), source, maxItems: 10 });
      if (!first.ok || !first.value.nextCursor) throw new Error(JSON.stringify(first));
      const firstOpens = fsProbe.transcriptOpens;
      expect({
        ids: first.value.candidates.map((candidate) => candidate.remoteSessionId),
        titles: first.value.candidates.map((candidate) => candidate.title),
        preparation: first.value.preparation,
        transcriptOpens: firstOpens,
      }).toEqual({
        ids: Array.from({ length: 10 }, (_, index) => `conversation-${String(index).padStart(3, '0')}`),
        titles: Array.from({ length: 10 }, (_, index) => `title ${index}`),
        preparation: undefined,
        transcriptOpens: 10,
      });
      const second = await contribution.listCandidates({ ...invocation(), source, maxItems: 10, cursor: first.value.nextCursor });
      if (!second.ok) throw new Error(JSON.stringify(second));
      expect(second.value.candidates.map((candidate) => candidate.remoteSessionId))
        .toEqual(Array.from({ length: 10 }, (_, index) => `conversation-${String(index + 10).padStart(3, '0')}`));
      expect(second.value.preparation).toBeUndefined();
      const updated = second.value.candidates.map((candidate) => candidate.updatedAtMs);
      expect([...updated].sort((left, right) => right - left)).toEqual(updated);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
