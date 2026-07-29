import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionHandoffStartRequest, SessionHandoffStatus, SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffWorkspaceReplicationAdapter } from '@/session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';

import { prepareStartedState } from './prepareStartedState';

const execFile = promisify(execFileCallback);
let runtimeRegistry: Awaited<
  ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
> | null = null;
let scmRegistry: ScmBackendRegistry;

beforeAll(async () => {
  runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
    pluginIds: ['happier.scm.backend.git'],
  });
  scmRegistry = await resolveDefaultScmBackendRegistry({
    pluginRuntimeRegistry: runtimeRegistry,
  });
});

afterAll(async () => {
  await runtimeRegistry?.dispose();
});

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', [...args], { cwd });
}

async function configureGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['config', 'user.email', 'test@example.com']);
  await runGit(cwd, ['config', 'user.name', 'Happier Test']);
}

describe('prepareStartedState media continuity', () => {
  it('includes replay fork media continuity paths in the handoff workspace manifest', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-start-media-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-handoff-start-source-'));

    try {
      const referencedPath = '.happier/uploads/generated/sess_parent/msg-2/fork-image.png';
      const unrelatedPath = '.happier/uploads/generated/sess_parent/msg-3/unrelated.png';

      await mkdir(join(sourceRootPath, '.happier', 'uploads', 'generated', 'sess_parent', 'msg-2'), { recursive: true });
      await mkdir(join(sourceRootPath, '.happier', 'uploads', 'generated', 'sess_parent', 'msg-3'), { recursive: true });
      await writeFile(join(sourceRootPath, '.gitignore'), '.happier/uploads/**\n');
      await writeFile(join(sourceRootPath, 'README.md'), 'hello\n');
      await writeFile(join(sourceRootPath, referencedPath), 'referenced media\n');
      await writeFile(join(sourceRootPath, unrelatedPath), 'unrelated media\n');
      await runGit(sourceRootPath, ['init']);
      await configureGitRepo(sourceRootPath);
      await runGit(sourceRootPath, ['add', 'README.md', '.gitignore']);
      await runGit(sourceRootPath, ['commit', '-m', 'initial']);

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };
      const handoffId = 'handoff_media_continuity_1';
      const request: SessionHandoffStartRequest = {
        sessionId: 'sess_child',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        agent: 'codex',
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
      };
      const workspaceReplicationAdapter =
        createSessionHandoffWorkspaceReplicationAdapter();

      const result = await prepareStartedState({
        callInput: {
          handoffId,
          request,
          sourceStopState: 'stopped',
          metadata: {
            path: sourceRootPath,
            sessionMediaContinuityV1: {
              v: 1,
              sourceSessionId: 'sess_parent',
              sourceCutoffSeqInclusive: 3,
              referencedWorkspacePaths: [referencedPath],
            },
          },
        },
        activeServerDir,
        exportSessionBundle: async () => ({
          targetPath: sourceRootPath,
          agentBundle: {
            agentId: 'codex',
            remoteSessionId: 'codex_child',
            files: [],
          },
        }),
        sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
        workspaceReplicationAdapter: {
          ...workspaceReplicationAdapter,
          prepareSourceWorkspaceTransfer: (input) =>
            workspaceReplicationAdapter.prepareSourceWorkspaceTransfer({
              ...input,
              scmRegistry,
            }),
        },
        resolveWorkspaceReplicationHandoffBackTargetRootPath: () => null,
        buildStartPendingStatus: ({ handoffId }): SessionHandoffStatus => ({
          status: 'pending',
          handoffId,
          phase: 'preparing',
          recoveryActions: [],
        }),
      });

      const manifestPaths =
        result.nextState.workspaceReplicationMetadata?.manifest.entries.map((entry) => entry.relativePath) ?? [];
      expect(manifestPaths).toContain(referencedPath);
      expect(manifestPaths).not.toContain(unrelatedPath);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });
});
