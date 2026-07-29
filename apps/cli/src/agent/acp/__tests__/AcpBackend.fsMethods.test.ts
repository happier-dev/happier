import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { createAcpClientFsMethods } from '../fs/acpClientFsMethods';
import type { AcpPermissionHandler } from '../permissions/acpPermissionHandler';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('createAcpClientFsMethods', () => {
  it('reports UTF-8 byte length for writeTextFile permission metadata', async () => {
    await withTempDir('happier-acp-fs-', async (cwd) => {
      const observed: unknown[] = [];
      const permissionHandler: AcpPermissionHandler = {
        async handleToolCall(toolCallId, toolName, input, context) {
          observed.push({ toolCallId, toolName, input, context });
          return { decision: 'approved' };
        },
      };

      const fsMethods = createAcpClientFsMethods({ cwd, permissionHandler });

      const content = '🙂é';
      await fsMethods.writeTextFile!({ sessionId: 's', path: 'out.txt', content });

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        toolCallId: expect.stringMatching(/^acp-fs-write:/),
        toolName: 'writeTextFile',
        input: { bytes: Buffer.byteLength(content, 'utf8') },
        context: { origin: 'host_acp_fs_write' },
      });
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

  it('revalidates workspace containment after permission handling before the final write', async () => {
    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const targetDirectory = join(workspace, 'target');
      const displacedDirectory = join(workspace, 'target-authorized');
      const escapedFile = join(outside, 'escaped.txt');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });

      const fsMethods = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' };
          },
          getImmediateDecision() {
            renameSync(targetDirectory, displacedDirectory);
            symlinkSync(outside, targetDirectory);
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(fsMethods.writeTextFile!({
        sessionId: 's',
        path: join(targetDirectory, 'escaped.txt'),
        content: 'must remain in the workspace',
      })).rejects.toThrow(/permission denied|traversal/i);
      expect(existsSync(escapedFile)).toBe(false);
    });
  });
});
