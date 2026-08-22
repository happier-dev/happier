import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActionIdSchema, createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  preparePluginAuthorDependencies,
  runPluginAuthorToolchain,
  type PluginAuthorToolchainDeps,
  type PluginAuthorToolchainSpawnInput,
} from '@/plugins/authoring/toolchain';
import { runPluginAuthorDoctor } from '@/plugins/authoring/doctor';
import type { requestUserPluginChange } from '@/plugins/daemon/changeClient';

import { executePluginDevLoopAction } from './actions';

type AuthoringActionServices = Readonly<{
  runPluginAuthorToolchain: typeof runPluginAuthorToolchain;
  runPluginAuthorDoctor: typeof runPluginAuthorDoctor;
  readUserPluginChangeStatus: (input: Readonly<{
    pendingChangeId: string;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  requestUserPluginChange?: typeof requestUserPluginChange;
}>;

function createAgentActionExecutor(params: Readonly<{
  workspaceRoot: string;
  services: AuthoringActionServices;
}>) {
  const deps: ActionExecutorDeps = {
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    executionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({ sessions: [] }),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    isActionApprovalRequired: () => false,
    pluginsDevLoopAction: async ({ actionId, input, context }) => await (
      executePluginDevLoopAction as unknown as (
        params: Readonly<{
          actionId: string;
          input: unknown;
          workspaceRoot?: string;
          context: unknown;
        }>,
        services: AuthoringActionServices,
      ) => Promise<unknown>
    )({
      actionId,
      input,
      workspaceRoot: params.workspaceRoot,
      context,
    }, params.services),
  };
  return createActionExecutor(deps);
}

function createToolchainServices(params: Readonly<{
  spawnCalls: PluginAuthorToolchainSpawnInput[];
}>): Pick<AuthoringActionServices, 'runPluginAuthorToolchain' | 'runPluginAuthorDoctor'> {
  const toolchainDeps: PluginAuthorToolchainDeps = {
    ensureManagedPnpmCommand: async () => '/managed/pnpm',
    managedPnpmBinPath: () => '/managed/pnpm',
    buildManagedPnpmEnvironment: (env = {}) => env,
    ensureManagedJavaScriptRuntimeCommand: async () => '/managed/js',
    managedJavaScriptRuntimeBinPath: () => '/managed/js',
    resolveNativeTypeScriptBin: () => '/managed/tsc',
    resolvePluginUiBuildBin: () => null,
    bundlePluginDaemonRuntime: async () => undefined,
    spawn: async (input) => {
      params.spawnCalls.push(input);
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
    processEnv: {},
  };
  return {
    runPluginAuthorToolchain: async (input) => await runPluginAuthorToolchain(input, toolchainDeps),
    runPluginAuthorDoctor: async (input) => await runPluginAuthorDoctor({
      ...input,
      prepareDependencies: async ({ projectRoot }) => await preparePluginAuthorDependencies({ projectRoot }, toolchainDeps),
    }),
  };
}

async function writeDescriptorOnlyPluginManifest(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), `${JSON.stringify({
    schemaVersion: 2,
    id: 'acme.external-author',
    version: '0.1.0',
    displayName: 'External Author',
    description: 'External Action authoring fixture.',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    contributes: {},
  })}\n`, 'utf8');
  await writeFile(join(projectRoot, 'src', 'index.ts'), [
    'export const manifest = {',
    '  schemaVersion: 2,',
    "  id: 'acme.external-author',",
    "  version: '0.1.0',",
    "  displayName: 'External Author',",
    "  description: 'External Action authoring fixture.',",
    "  engines: { happier: '^0.2.0' },",
    '  runtime: { apiVersion: 1 },',
    '  contributes: {},',
    '};',
    'export function activate() {}',
    '',
  ].join('\n'), 'utf8');
}

describe('Plugin authoring Actions', () => {
  it('runs the external scaffold → typecheck/test/doctor journey through the real Agent Action caller', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-authoring-action-'));
    const targetDir = join(workspaceRoot, 'external-plugin');
    const spawnCalls: PluginAuthorToolchainSpawnInput[] = [];
    const requestDevelopmentChange = vi.fn(async () => ({
      kind: 'sourceRootReviewRequired' as const,
      pendingChangeId: 'pending-external-author-1',
      review: { source: { kind: 'path' as const, locator: targetDir } },
    }));
    const services: AuthoringActionServices = {
      ...createToolchainServices({ spawnCalls }),
      readUserPluginChangeStatus: async () => ({ kind: 'expired' }),
      requestUserPluginChange: requestDevelopmentChange as typeof requestUserPluginChange,
    };
    const executor = createAgentActionExecutor({ workspaceRoot, services });

    try {
      await expect(executor.execute('plugins.scaffold', {
        targetDir,
        id: 'acme.external-author',
        name: 'External Author',
      }, { surface: 'agent', bypassApprovals: true })).resolves.toMatchObject({
        ok: true,
        result: {
          ok: true,
          kind: 'plugins_scaffold',
          plugin: { pluginId: 'acme.external-author' },
        },
      });
      await expect(readFile(join(targetDir, 'package.json'), 'utf8')).resolves.toContain('happier-plugin-acme-external-author');

      await expect(executor.execute('plugins.dev' as never, {
        projectRoot: targetDir,
      }, { surface: 'agent', bypassApprovals: true })).resolves.toMatchObject({
        ok: true,
        result: {
          ok: false,
          kind: 'plugins_dev',
          outcome: 'reviewRequired',
          pendingReview: {
            kind: 'sourceRootReviewRequired',
            pendingChangeId: 'pending-external-author-1',
          },
        },
      });
      expect(requestDevelopmentChange).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({
          kind: 'development',
          sourceRootPath: await realpath(targetDir),
        }),
        approval: 'none',
      }));

      // The ordinary author journey edits the external scaffold. This descriptor
      // shape keeps the test focused on the public Action projection; the
      // process boundary below is the only substituted system boundary.
      await writeDescriptorOnlyPluginManifest(targetDir);

      for (const [actionId, input, kind] of [
        ['plugins.author.typecheck', { projectRoot: targetDir }, 'plugins_author_typecheck'],
        ['plugins.author.test', { projectRoot: targetDir }, 'plugins_author_test'],
        ['plugins.doctor', { locator: targetDir }, 'plugins_doctor'],
      ] as const) {
        await expect(executor.execute(actionId as never, input, {
          surface: 'agent',
          bypassApprovals: true,
        })).resolves.toMatchObject({
          ok: true,
          result: { ok: true, kind },
        });
      }

      expect(spawnCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          command: '/managed/pnpm',
          args: expect.arrayContaining(['install', '--ignore-scripts']),
        }),
        expect.objectContaining({
          command: '/managed/js',
          args: expect.arrayContaining(['/managed/tsc', '--noEmit', '-p', 'tsconfig.json']),
        }),
      ]));
      expect(spawnCalls).toContainEqual(expect.objectContaining({
        command: '/managed/js',
        args: ['--test', 'test/index.test.mjs'],
      }));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('preserves daemon-issued pending review status but exposes no Agent decision Action', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-authoring-action-'));
    const services: AuthoringActionServices = {
      ...createToolchainServices({ spawnCalls: [] }),
      readUserPluginChangeStatus: async ({ pendingChangeId }) => ({
        kind: 'sourceRootReviewRequired',
        pendingChangeId,
        review: { source: { kind: 'path', locator: '/external/plugin' } },
      }),
    };
    const executor = createAgentActionExecutor({ workspaceRoot, services });

    try {
      await expect(executor.execute('plugins.change.status' as never, {
        pendingChangeId: 'pending-source-root-1',
      }, { surface: 'agent', bypassApprovals: true })).resolves.toEqual({
        ok: true,
        result: {
          ok: true,
          kind: 'plugins_change_status',
          status: {
            kind: 'sourceRootReviewRequired',
            pendingChangeId: 'pending-source-root-1',
            review: { source: { kind: 'path', locator: '/external/plugin' } },
          },
        },
      });

      expect(ActionIdSchema.safeParse('plugins.change.decision').success).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
