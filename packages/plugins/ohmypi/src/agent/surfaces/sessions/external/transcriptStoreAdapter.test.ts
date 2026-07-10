import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOhMyPiExternalSessionTranscriptStoreAdapter } from './transcriptStoreAdapter.js';

const tempDirs = new Set<string>();

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('createOhMyPiExternalSessionTranscriptStoreAdapter', () => {
  it('pages transcript items and session metadata from the plugin-owned store adapter', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-store-adapter-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      join(sessionRoot, '2026-04-10T10-00-00-000Z_session-1.jsonl'),
      [
        jsonlLine({
          type: 'session',
          id: 'session-1',
          timestamp: '2026-04-10T10:00:00.000Z',
          cwd: '/repo',
          title: 'OhMyPi transcript',
        }),
        jsonlLine({
          type: 'message',
          id: 'user-1',
          timestamp: '2026-04-10T10:00:01.000Z',
          message: { role: 'user', content: 'hello' },
        }),
      ].join(''),
      'utf8',
    );

    const adapter = createOhMyPiExternalSessionTranscriptStoreAdapter({ env: {} });
    const key = {
      agentId: 'ohMyPi',
      source: { kind: 'ohMyPiAgentDir', agentDir },
      providerSessionId: 'session-1',
    } as const;

    await expect(adapter.withStore(key, async (store) => ({
      page: await store.pageOlder({ maxBytes: 4096, maxItems: 10 }),
      title: await store.getTitle(),
      workingDirectory: await store.getWorkingDirectory(),
      activity: await store.getActivity(),
    }))).resolves.toMatchObject({
      page: {
        items: [
          {
            raw: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
            },
          },
        ],
        hasMore: false,
      },
      title: 'OhMyPi transcript',
      workingDirectory: '/repo',
      activity: {
        isRunning: false,
        lastActivityAtMs: Date.parse('2026-04-10T10:00:01.000Z'),
      },
    });
  });
});
