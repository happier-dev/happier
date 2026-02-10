import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAcpClientFsMethods, type AcpPermissionHandler } from '../AcpBackend';

describe('createAcpClientFsMethods', () => {
  it('reports UTF-8 byte length for writeTextFile permission metadata', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-acp-fs-'));

    try {
      const observed: unknown[] = [];
      const permissionHandler: AcpPermissionHandler = {
        async handleToolCall(_toolCallId, _toolName, input) {
          observed.push(input);
          return { decision: 'approved' };
        },
      };

      const fsMethods = createAcpClientFsMethods({ cwd, permissionHandler });

      const content = '🙂é';
      await fsMethods.writeTextFile!({ sessionId: 's', path: 'out.txt', content });

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ bytes: Buffer.byteLength(content, 'utf8') });
      expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe(content);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('treats explicit zero line/limit as an empty range', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-acp-fs-'));

    try {
      const fsMethods = createAcpClientFsMethods({ cwd });
      await fsMethods.writeTextFile!({
        sessionId: 's',
        path: 'range.txt',
        content: ['first', 'second', 'third'].join('\n'),
      });

      const result = await fsMethods.readTextFile!({
        sessionId: 's',
        path: 'range.txt',
        line: 0,
        limit: 0,
      });

      expect(result.content).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
