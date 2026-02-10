import { describe, expect, it, afterEach } from 'vitest';

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildInitializeRequest, createAcpClientFsMethods } from '../AcpBackend';
import type { AcpPermissionHandler } from '../AcpBackend';

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('AcpBackend ACP FS capability experiment', () => {
  const previousNonStackFlag = process.env.HAPPIER_ACP_FS;

  afterEach(() => {
    setEnv('HAPPIER_ACP_FS', previousNonStackFlag);
  });

  it('exposes buildInitializeRequest to allow ACP capabilities to be unit-tested', () => {
    expect(typeof buildInitializeRequest).toBe('function');
  });

  it('advertises fs.readTextFile/fs.writeTextFile when HAPPIER_ACP_FS is enabled', () => {
    setEnv('HAPPIER_ACP_FS', '1');

    const req = buildInitializeRequest({ clientName: 'test', clientVersion: '0.0.0' });
    expect(req.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(req.clientCapabilities?.fs?.writeTextFile).toBe(true);
  });

  it('advertises ACP fs capabilities by default', () => {
    setEnv('HAPPIER_ACP_FS', undefined);

    const req = buildInitializeRequest({ clientName: 'test', clientVersion: '0.0.0' });
    expect(req.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(req.clientCapabilities?.fs?.writeTextFile).toBe(true);
  });

  it('writeTextFile is permission-gated when ACP fs is enabled', async () => {
    setEnv('HAPPIER_ACP_FS', '1');

    const workspace = mkdtempSync(join(tmpdir(), 'happier-acp-fs-'));
    const targetPath = join(workspace, 'a.txt');

    try {
      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'denied' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(
        clientFs.writeTextFile!({ sessionId: 's', path: targetPath, content: 'hi' })
      ).rejects.toThrow(/denied/i);

      expect(existsSync(targetPath)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('readTextFile reads file content when ACP fs is enabled', async () => {
    setEnv('HAPPIER_ACP_FS', '1');

    const workspace = mkdtempSync(join(tmpdir(), 'happier-acp-fs-'));
    const targetPath = join(workspace, 'b.txt');

    try {
      writeFileSync(targetPath, 'line1\nline2\nline3\n', 'utf8');
      const clientFs = createAcpClientFsMethods({ cwd: workspace });

      const res = await clientFs.readTextFile!({ sessionId: 's', path: targetPath, line: 2, limit: 1 });
      expect(res.content).toBe('line2');
      expect(readFileSync(targetPath, 'utf8')).toContain('line3');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('readTextFile rejects paths that escape cwd', async () => {
    setEnv('HAPPIER_ACP_FS', '1');

    const root = mkdtempSync(join(tmpdir(), 'happier-acp-fs-root-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const outsideFile = join(outside, 'outside.txt');

    try {
      // Prepare test files.
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(outsideFile, 'nope', 'utf8');

      const clientFs = createAcpClientFsMethods({ cwd: workspace });
      await expect(clientFs.readTextFile!({ sessionId: 's', path: outsideFile })).rejects.toThrow(/permission denied|traversal/i);
      await expect(clientFs.readTextFile!({ sessionId: 's', path: '../outside/outside.txt' })).rejects.toThrow(/permission denied|traversal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeTextFile rejects paths that escape cwd even when approved', async () => {
    setEnv('HAPPIER_ACP_FS', '1');

    const root = mkdtempSync(join(tmpdir(), 'happier-acp-fs-root-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const outsideFile = join(outside, 'outside.txt');

    try {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });

      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(clientFs.writeTextFile!({ sessionId: 's', path: outsideFile, content: 'nope' })).rejects.toThrow(/permission denied|traversal/i);
      await expect(clientFs.writeTextFile!({ sessionId: 's', path: '../outside/outside.txt', content: 'nope' })).rejects.toThrow(/permission denied|traversal/i);

      expect(existsSync(outsideFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeTextFile rejects writes through symlinks that point outside cwd', async () => {
    setEnv('HAPPIER_ACP_FS', '1');

    const root = mkdtempSync(join(tmpdir(), 'happier-acp-fs-root-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const outsideFile = join(outside, 'outside.txt');
    const linkPath = join(workspace, 'link.txt');

    try {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(outsideFile, 'original', 'utf8');
      symlinkSync(outsideFile, linkPath);

      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(clientFs.writeTextFile!({ sessionId: 's', path: linkPath, content: 'nope' })).rejects.toThrow(/permission denied|traversal/i);
      expect(readFileSync(outsideFile, 'utf8')).toBe('original');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeTextFile rejects writes when a missing child is nested under a symlinked ancestor outside cwd', async () => {
    setEnv('HAPPIER_ACP_FS', '1');

    const root = mkdtempSync(join(tmpdir(), 'happier-acp-fs-root-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const linkDir = join(workspace, 'linkdir');
    const escapedFile = join(outside, 'nested', 'via-symlink.txt');

    try {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, linkDir);

      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' };
          },
        } satisfies AcpPermissionHandler,
      });

      await expect(
        clientFs.writeTextFile!({
          sessionId: 's',
          path: join(linkDir, 'nested', 'via-symlink.txt'),
          content: 'nope',
        })
      ).rejects.toThrow(/permission denied|traversal/i);
      expect(existsSync(escapedFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
