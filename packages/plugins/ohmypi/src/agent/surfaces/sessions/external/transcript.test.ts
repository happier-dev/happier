import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeJsonlByteCursor } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import { afterEach, describe, expect, it } from 'vitest';

import { readAfterOhMyPiSessionTranscript } from './transcript.js';

const tempDirs = new Set<string>();

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('readAfterOhMyPiSessionTranscript', () => {
  it('reads appended records after a byte cursor', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-transcript-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const header = jsonlLine({
      type: 'session',
      id: 'session-1',
      timestamp: '2026-04-10T10:00:00.000Z',
      cwd: '/repo',
    });
    const existing = jsonlLine({
      type: 'message',
      id: 'old-user',
      timestamp: '2026-04-10T10:00:01.000Z',
      message: { role: 'user', content: 'old' },
    });
    const appended = jsonlLine({
      type: 'message',
      id: 'new-user',
      timestamp: '2026-04-10T10:00:02.000Z',
      message: { role: 'user', content: 'new' },
    });
    await writeFile(join(sessionRoot, '2026-04-10T10-00-00-000Z_session-1.jsonl'), `${header}${existing}${appended}`, 'utf8');
    const cursor = encodeJsonlByteCursor({
      v: 1,
      kind: 'byteOffset',
      offset: Buffer.byteLength(header + existing, 'utf8'),
    });

    const result = await readAfterOhMyPiSessionTranscript({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      providerSessionId: 'session-1',
      cursor,
      maxBytes: 4096,
      maxItems: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      raw: {
        role: 'user',
        content: { type: 'text', text: 'new' },
      },
    });
  });
});
