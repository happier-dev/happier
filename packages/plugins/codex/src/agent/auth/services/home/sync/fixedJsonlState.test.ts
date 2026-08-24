import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reconcileCodexSharedJsonlState } from './fixedJsonlState.js';

describe('reconcileCodexSharedJsonlState', () => {
  it('appends missing history and only newer per-session index records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-fixed-jsonl-'));
    const sourceRoot = join(root, 'source');
    const firstHome = join(root, 'first');
    const secondHome = join(root, 'second');
    try {
      await Promise.all([
        mkdir(sourceRoot, { recursive: true }),
        mkdir(firstHome, { recursive: true }),
        mkdir(secondHome, { recursive: true }),
      ]);
      await writeFile(
        join(firstHome, 'history.jsonl'),
        '{"session_id":"first","ts":1,"text":"first prompt"}\n',
        'utf8',
      );
      await writeFile(
        join(secondHome, 'history.jsonl'),
        '{"session_id":"second","ts":2,"text":"second prompt"}\n',
        'utf8',
      );
      await writeFile(
        join(firstHome, 'session_index.jsonl'),
        [
          '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}',
          '{"id":"shared","thread_name":"Old","updated_at":"2026-08-24T09:00:00.000Z"}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(secondHome, 'session_index.jsonl'),
        [
          '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}',
          '{"id":"shared","thread_name":"New","updated_at":"2026-08-24T12:00:00.000Z"}',
          '',
        ].join('\n'),
        'utf8',
      );

      await reconcileCodexSharedJsonlState({ materializedRootDir: firstHome, sourceRoot });
      await reconcileCodexSharedJsonlState({ materializedRootDir: secondHome, sourceRoot });
      await reconcileCodexSharedJsonlState({ materializedRootDir: firstHome, sourceRoot });

      const historyLines = (await readFile(join(sourceRoot, 'history.jsonl'), 'utf8')).trimEnd().split('\n');
      expect(historyLines).toEqual([
        '{"session_id":"first","ts":1,"text":"first prompt"}',
        '{"session_id":"second","ts":2,"text":"second prompt"}',
      ]);
      const indexLines = (await readFile(join(sourceRoot, 'session_index.jsonl'), 'utf8')).trimEnd().split('\n');
      expect(indexLines).toEqual([
        '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}',
        '{"id":"shared","thread_name":"Old","updated_at":"2026-08-24T09:00:00.000Z"}',
        '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}',
        '{"id":"shared","thread_name":"New","updated_at":"2026-08-24T12:00:00.000Z"}',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
