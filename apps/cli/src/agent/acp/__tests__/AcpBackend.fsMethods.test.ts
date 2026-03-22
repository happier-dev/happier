import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAcpClientFsMethods, type AcpPermissionHandler } from '../AcpBackend';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('createAcpClientFsMethods', () => {
  it('reports UTF-8 byte length for writeTextFile permission metadata', async () => {
    await withTempDir('happier-acp-fs-', async (cwd) => {
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
    });
  });

  it('treats explicit zero line/limit as an empty range', async () => {
    await withTempDir('happier-acp-fs-', async (cwd) => {
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
    });
  });
});
