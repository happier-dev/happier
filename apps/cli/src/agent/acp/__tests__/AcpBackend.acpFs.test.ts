import { describe, expect, it, afterEach, vi } from 'vitest';

import { writeFileSync, readFileSync, existsSync, mkdirSync, promises as fsPromises, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { buildInitializeRequest, createAcpClientFsMethods } from '../AcpBackend';
import type { AcpPermissionHandler } from '../permissions/acpPermissionHandler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const envScope = createEnvKeyScope(['HAPPIER_ACP_FS']);

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: unknown) => unknown>();

  registerHandler(name: string, handler: (payload: unknown) => unknown) {
    this.handlers.set(name, handler);
  }
}

class FakePermissionSession {
  sessionId = 'acp-fs-permission-test';
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
  } = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: (current: typeof this.agentState) => typeof this.agentState) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  getMetadataSnapshot() {
    return null;
  }
}

describe('AcpBackend ACP FS capability experiment', () => {
  afterEach(() => {
    envScope.restore();
    vi.restoreAllMocks();
  });

  it('exposes buildInitializeRequest to allow ACP capabilities to be unit-tested', () => {
    expect(typeof buildInitializeRequest).toBe('function');
  });

  it('advertises fs.readTextFile/fs.writeTextFile when HAPPIER_ACP_FS is enabled', () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    const req = buildInitializeRequest({ clientName: 'test', clientVersion: '0.0.0' });
    expect(req.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(req.clientCapabilities?.fs?.writeTextFile).toBe(true);
  });

  it('advertises ACP fs capabilities by default', () => {
    envScope.patch({ HAPPIER_ACP_FS: undefined });

    const req = buildInitializeRequest({ clientName: 'test', clientVersion: '0.0.0' });
    expect(req.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(req.clientCapabilities?.fs?.writeTextFile).toBe(true);
  });

  it('lets runtime definitions disable ACP fs per backend without mutating global env', () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    const req = buildInitializeRequest({
      clientName: 'test',
      clientVersion: '0.0.0',
      fsEnabled: false,
    });

    expect(req.clientCapabilities?.fs?.readTextFile).toBe(false);
    expect(req.clientCapabilities?.fs?.writeTextFile).toBe(false);
    expect(process.env.HAPPIER_ACP_FS).toBe('1');
  });

  it('writeTextFile is permission-gated when ACP fs is enabled', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-', async (workspace) => {
      const targetPath = join(workspace, 'a.txt');
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
    });
  });

  it('fails closed before an ACP filesystem write in provider-enforced Read Only and Plan modes', async () => {
    await withTempDir('happier-acp-fs-low-privilege-', async (workspace) => {
      for (const permissionMode of ['read-only', 'plan'] as const) {
        const targetPath = join(workspace, `${permissionMode}-must-not-exist.txt`);
        const toolCallId = `safe-looking-think-${permissionMode}`;
        const session = new FakePermissionSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(
          session as unknown as ApiSessionClient,
          { logPrefix: '[AcpFsLowPrivilegeTest]' },
        );
        permissionHandler.setPermissionMode(permissionMode);
        const clientFs = createAcpClientFsMethods({
          cwd: workspace,
          permissionHandler,
        });

        await expect(
          clientFs.writeTextFile!({
            sessionId: 's',
            path: permissionMode === 'read-only' ? targetPath : `${permissionMode}-must-not-exist.txt`,
            content: 'must not be written',
            _meta: { toolCallId },
          }),
        ).rejects.toThrow(/denied/i);
        expect(existsSync(targetPath)).toBe(false);
        expect(session.agentState.completedRequests[toolCallId]).toMatchObject({
          tool: 'writeTextFile',
          status: 'denied',
          decision: 'denied',
        });
      }
    });
  });

  it('revalidates provider-enforced mode at the final ACP filesystem write boundary', async () => {
    await withTempDir('happier-acp-fs-mode-transition-', async (workspace) => {
      let releaseMkdir!: () => void;
      let observeMkdir!: () => void;
      const mkdirEntered = new Promise<void>((resolve) => {
        observeMkdir = resolve;
      });
      const mkdirReleased = new Promise<void>((resolve) => {
        releaseMkdir = resolve;
      });
      vi.spyOn(fsPromises, 'mkdir').mockImplementation(async () => {
        observeMkdir();
        await mkdirReleased;
        return undefined;
      });

      const targetPath = join(workspace, 'mode-transition-must-not-exist.txt');
      const permissionHandler = new ProviderEnforcedPermissionHandler(
        new FakePermissionSession() as unknown as ApiSessionClient,
        { logPrefix: '[AcpFsModeTransitionTest]' },
      );
      const clientFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler,
      });

      const write = clientFs.writeTextFile!({
        sessionId: 's',
        path: targetPath,
        content: 'must not be written',
      });
      await mkdirEntered;
      permissionHandler.setPermissionMode('read-only');
      releaseMkdir();

      await expect(write).rejects.toThrow(/denied/i);
      expect(existsSync(targetPath)).toBe(false);
    });
  });

  it('keeps ACP reads available in Read Only mode and writes available in every non-low-privilege mode alias', async () => {
    await withTempDir('happier-acp-fs-mode-semantics-', async (workspace) => {
      const readablePath = join(workspace, 'readable.txt');
      writeFileSync(readablePath, 'readable in every mode', 'utf8');

      const readOnlyHandler = new ProviderEnforcedPermissionHandler(
        new FakePermissionSession() as unknown as ApiSessionClient,
        { logPrefix: '[AcpFsReadOnlyTest]' },
      );
      readOnlyHandler.setPermissionMode('read-only');
      const readOnlyFs = createAcpClientFsMethods({
        cwd: workspace,
        permissionHandler: readOnlyHandler,
      });
      await expect(
        readOnlyFs.readTextFile!({ sessionId: 's', path: readablePath }),
      ).resolves.toEqual({ content: 'readable in every mode' });

      for (const permissionMode of [
        'default',
        'acceptEdits',
        'safe-yolo',
        'yolo',
        'bypassPermissions',
      ] as const) {
        const handler = new ProviderEnforcedPermissionHandler(
          new FakePermissionSession() as unknown as ApiSessionClient,
          { logPrefix: `[AcpFs${permissionMode}Test]` },
        );
        handler.setPermissionMode(permissionMode);
        const clientFs = createAcpClientFsMethods({
          cwd: workspace,
          permissionHandler: handler,
        });
        const fileName = `${permissionMode}-write.txt`;
        await expect(
          clientFs.writeTextFile!({
            sessionId: 's',
            path: fileName,
            content: `${permissionMode} write`,
          }),
        ).resolves.toEqual({});
        expect(readFileSync(join(workspace, fileName), 'utf8')).toBe(`${permissionMode} write`);
      }
    });
  });

  it('readTextFile reads file content when ACP fs is enabled', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-', async (workspace) => {
      const targetPath = join(workspace, 'b.txt');
      writeFileSync(targetPath, 'line1\nline2\nline3\n', 'utf8');
      const clientFs = createAcpClientFsMethods({ cwd: workspace });

      const res = await clientFs.readTextFile!({ sessionId: 's', path: targetPath, line: 2, limit: 1 });
      expect(res.content).toBe('line2');
      expect(readFileSync(targetPath, 'utf8')).toContain('line3');
    });
  });

  it('readTextFile accepts an absolute alias whose canonical path is inside cwd', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspaceReal = join(root, 'workspace-real');
      const workspaceAlias = join(root, 'workspace-alias');
      const targetReal = join(workspaceReal, 'bridge-sentinel.txt');
      const targetAlias = join(workspaceAlias, 'bridge-sentinel.txt');
      mkdirSync(workspaceReal, { recursive: true });
      writeFileSync(targetReal, 'canonical workspace content', 'utf8');
      symlinkSync(workspaceReal, workspaceAlias);

      const clientFs = createAcpClientFsMethods({ cwd: workspaceReal });

      await expect(
        clientFs.readTextFile!({ sessionId: 's', path: targetAlias }),
      ).resolves.toEqual({ content: 'canonical workspace content' });
    });
  });

  it('does not treat missing files under a symlinked cwd as path traversal (reports ENOENT instead)', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspaceReal = join(root, 'workspace-real');
      const workspaceLink = join(root, 'workspace-link');
      mkdirSync(workspaceReal, { recursive: true });
      symlinkSync(workspaceReal, workspaceLink);

      const clientFs = createAcpClientFsMethods({ cwd: workspaceLink });
      const missing = join(workspaceLink, 'missing.txt');

      await expect(clientFs.readTextFile!({ sessionId: 's', path: missing })).rejects.toThrow(/ENOENT/i);
    });
  });

  it('readTextFile rejects paths that escape cwd', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const outsideFile = join(outside, 'outside.txt');
      const sibling = join(root, 'workspace-sibling');
      const siblingFile = join(sibling, 'sibling.txt');
      const outsideLink = join(workspace, 'outside-link.txt');
      // Prepare test files.
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(outsideFile, 'nope', 'utf8');
      writeFileSync(siblingFile, 'also nope', 'utf8');
      symlinkSync(outsideFile, outsideLink);

      const clientFs = createAcpClientFsMethods({ cwd: workspace });
      await expect(clientFs.readTextFile!({ sessionId: 's', path: outsideFile })).rejects.toThrow(/permission denied|traversal/i);
      await expect(clientFs.readTextFile!({ sessionId: 's', path: '../outside/outside.txt' })).rejects.toThrow(/permission denied|traversal/i);
      await expect(clientFs.readTextFile!({ sessionId: 's', path: siblingFile })).rejects.toThrow(/permission denied|traversal/i);
      await expect(clientFs.readTextFile!({ sessionId: 's', path: outsideLink })).rejects.toThrow(/permission denied|traversal/i);
    });
  });

  it('writeTextFile rejects paths that escape cwd even when approved', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const outsideFile = join(outside, 'outside.txt');
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
    });
  });

  it('writeTextFile rejects writes through symlinks that point outside cwd', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const outsideFile = join(outside, 'outside.txt');
      const linkPath = join(workspace, 'link.txt');
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
    });
  });

  it('writeTextFile rejects writes when a missing child is nested under a symlinked ancestor outside cwd', async () => {
    envScope.patch({ HAPPIER_ACP_FS: '1' });

    await withTempDir('happier-acp-fs-root-', async (root) => {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const linkDir = join(workspace, 'linkdir');
      const escapedFile = join(outside, 'nested', 'via-symlink.txt');
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
    });
  });
});
