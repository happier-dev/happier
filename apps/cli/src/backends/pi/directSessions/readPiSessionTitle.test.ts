import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readPiSessionTitle } from './readPiSessionTitle';

function sessionFile(lines: readonly object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-title-'));
  const filePath = join(dir, '2024-12-03T14-00-00-000Z_019f4a42-4617-767a-8e7c-189b454a0352.jsonl');
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

const header = { type: 'session', id: '019f4a42-4617-767a-8e7c-189b454a0352', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/proj', version: 3 };

describe('readPiSessionTitle', () => {
  it('prefers the latest session_info name over the first user message', async () => {
    const filePath = sessionFile([
      header,
      { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'first user prompt' } },
      { type: 'session_info', id: 'sinf0001', parentId: 'a1b2c3d4', timestamp: '2024-12-03T14:00:02.000Z', name: 'Named by user' },
    ]);
    await expect(readPiSessionTitle(filePath)).resolves.toBe('Named by user');
  });

  it('falls back to the first user message text when no session_info name is set', async () => {
    const filePath = sessionFile([
      header,
      { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'array-form user prompt' }] } },
      { type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4', timestamp: '2024-12-03T14:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
    ]);
    await expect(readPiSessionTitle(filePath)).resolves.toBe('array-form user prompt');
  });

  it('returns null when there is no session_info name and no user message text', async () => {
    const filePath = sessionFile([
      header,
      { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'no user yet' }] } },
    ]);
    await expect(readPiSessionTitle(filePath)).resolves.toBeNull();
  });

  it('uses the latest session_info entry when multiple are present', async () => {
    const filePath = sessionFile([
      header,
      { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: 'x' } },
      { type: 'session_info', id: 'sinf0001', parentId: 'a1b2c3d4', timestamp: '2024-12-03T14:00:02.000Z', name: 'old name' },
      { type: 'message', id: 'cccc0001', parentId: 'sinf0001', timestamp: '2024-12-03T14:00:03.000Z', message: { role: 'user', content: 'y' } },
      { type: 'session_info', id: 'sinf0002', parentId: 'cccc0001', timestamp: '2024-12-03T14:00:04.000Z', name: 'newest name' },
    ]);
    await expect(readPiSessionTitle(filePath)).resolves.toBe('newest name');
  });
});
