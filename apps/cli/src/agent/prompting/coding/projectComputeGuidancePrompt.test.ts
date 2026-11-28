import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatProjectComputeAgentGuidanceV1 } from '@happier-dev/protocol/workspaces/projectAgentGuidanceV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { resolveEffectiveCodingPromptPlan } from './resolveEffectiveCodingPrompt';
import { resolveSessionProjectComputeGuidance } from './resolveProjectComputeGuidance';
import { createSessionProjectPromptStackPreparation } from './sessionProjectPromptStack';
import { createSessionPromptPlanResolver } from './sessionPromptPlan';
import { resolveCodingToolDeliveryBlocks } from './toolDeliveryPromptRegistry';

const workspace = {
  serverId: 'home-1',
  workspaceId: 'ws-1',
  machineId: 'laptop-1',
  rootPath: '/repo',
} as const;

function makePlainCredentials(token = 'test-plain-token'): StoredCredentials {
  return {
    token,
    encryption: null,
  } as unknown as StoredCredentials;
}

afterEach(() => {
  withdrawActiveProjectAccountRowsSnapshot();
});

async function withStubHttpServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind ephemeral HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('project compute guidance coding prompt injection', () => {
  it.each(['native_mcp', 'native_extension', 'shell_bridge'] as const)(
    'injects the canonical project compute guidance block through %s when workers or portable scripts are configured',
    async (toolDelivery) => {
      const guidanceInput = {
        workspace,
        portableScripts: [{ name: 'test', description: 'Run unit tests' }],
        workerPreferences: {
          enabled: true,
          allowAdHoc: true,
          destinationLabel: 'nl1-worker',
        },
      } as const;
      const expected = formatProjectComputeAgentGuidanceV1(guidanceInput);
      expect(expected).not.toBeNull();

      const plan = await resolveEffectiveCodingPromptPlan({
        toolDelivery,
        settings: {},
        profileId: null,
        memoryRecallGuidanceEnabled: false,
        toolDeliverySessionId: 'session-1',
        toolDeliveryDirectory: '/repo',
        projectComputeGuidance: guidanceInput,
      });

      expect(plan.plan.blocks.some((block) => block.id === 'tool_delivery.project_compute_guidance')).toBe(true);
      expect(plan.text).toContain(expected!.promptBlock);
    },
  );

  it.each(['native_mcp', 'native_extension', 'shell_bridge'] as const)(
    'adds zero extra lines through %s when the checkout is unconfigured (no portable scripts and workers disabled)',
    async (toolDelivery) => {
      const baseline = await resolveEffectiveCodingPromptPlan({
        toolDelivery,
        settings: {},
        profileId: null,
        memoryRecallGuidanceEnabled: false,
        toolDeliverySessionId: 'session-1',
        toolDeliveryDirectory: '/repo',
      });
      const unconfigured = await resolveEffectiveCodingPromptPlan({
        toolDelivery,
        settings: {},
        profileId: null,
        memoryRecallGuidanceEnabled: false,
        toolDeliverySessionId: 'session-1',
        toolDeliveryDirectory: '/repo',
        projectComputeGuidance: {
          workspace,
          portableScripts: [],
          workerPreferences: { enabled: false, allowAdHoc: false },
        },
      });

      expect(unconfigured.plan.blocks.some((block) => block.id === 'tool_delivery.project_compute_guidance')).toBe(false);
      expect(unconfigured.text).toBe(baseline.text);
    },
  );

  it('omits compute guidance when Happier tools are disabled on the session', () => {
    const blocks = resolveCodingToolDeliveryBlocks({
      delivery: 'native_mcp',
      sessionId: 'session-1',
      directory: '/repo',
      sessionMetadata: { mcpSelectionV1: { happierToolsEnabled: false } },
      projectComputeGuidance: {
        workspace,
        portableScripts: [{ name: 'test' }],
        workerPreferences: { enabled: true, allowAdHoc: true, destinationLabel: 'nl1' },
      },
    });
    expect(blocks).toEqual([]);
  });

  it('collects portable scripts from a checkout manifest and returns null when unconfigured', async () => {
    const emptyDir = await createTempDir('compute-guidance-empty-');
    const configuredDir = await createTempDir('compute-guidance-configured-');
    try {
      expect(await resolveSessionProjectComputeGuidance({
        directory: emptyDir,
        serverId: 'home-1',
        machineId: 'laptop-1',
      })).toBeNull();

      await mkdir(join(configuredDir, '.happier'), { recursive: true });
      await writeFile(join(configuredDir, '.happier', 'project.json'), JSON.stringify({
        version: 1,
        scripts: {
          test: { source: { kind: 'command', command: 'pnpm test' }, execution: 'portable' },
          lint: { source: { kind: 'command', command: 'pnpm lint' }, execution: 'primary' },
        },
      }));

      const collected = await resolveSessionProjectComputeGuidance({
        directory: configuredDir,
        serverId: 'home-1',
        machineId: 'laptop-1',
        workspaceRef: {
          id: 'ws-1',
          serverId: 'home-1',
          machineId: 'laptop-1',
          rootPath: configuredDir,
          createdAtMs: 1,
          label: null,
          lastOpenedAtMs: null,
        },
      });
      expect(collected).toEqual({
        workspace: {
          serverId: 'home-1',
          workspaceId: 'ws-1',
          machineId: 'laptop-1',
          rootPath: configuredDir,
        },
        portableScripts: [{ name: 'test' }],
        workerPreferences: { enabled: false, allowAdHoc: false },
      });
    } finally {
      await removeTempDir(emptyDir);
      await removeTempDir(configuredDir);
    }
  });

  it('reads worker preferences from Home when available and settles promptly on Home timeout, failure, or abort', async () => {
    const emptyDir = await createTempDir('compute-guidance-home-');
    try {
      // 1. Successful Home read
      await withStubHttpServer((req, res) => {
        if (req.url === '/v1/account/encryption') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
          return;
        }
        if (req.url === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            status: 'present',
            revision: 2,
            content: {
              t: 'plain',
              v: {
                enabled: true,
                destination: { kind: 'machine', machineId: 'nl1-worker' },
                unavailable: 'ask',
                allowAdHoc: true,
                scriptOverrides: {},
                services: {},
              },
            },
          }));
          return;
        }
        res.writeHead(404).end();
      }, async (baseUrl) => {
        const result = await runWithServerHttpBaseUrl(baseUrl, () => resolveSessionProjectComputeGuidance({
          directory: emptyDir,
          serverId: 'home-1',
          machineId: 'laptop-1',
          workspaceId: 'ws-1',
          credentials: makePlainCredentials('token-ok'),
          timeoutMs: 2_000,
        }));
        expect(result).toEqual({
          workspace: {
            serverId: 'home-1',
            workspaceId: 'ws-1',
            machineId: 'laptop-1',
            rootPath: emptyDir,
          },
          portableScripts: [],
          workerPreferences: {
            enabled: true,
            allowAdHoc: true,
            destinationLabel: 'nl1-worker',
            unavailable: 'ask',
          },
        });
      });

      // 2. Hung Home endpoint settles promptly on timeout without throwing or hanging
      await withStubHttpServer((_req, _res) => {
        // Intentionally hang without responding.
      }, async (baseUrl) => {
        const startedAt = Date.now();
        const result = await runWithServerHttpBaseUrl(baseUrl, () => resolveSessionProjectComputeGuidance({
          directory: emptyDir,
          serverId: 'home-1',
          machineId: 'laptop-1',
          workspaceId: 'ws-1',
          credentials: makePlainCredentials('token-hung'),
          timeoutMs: 60,
        }));
        expect(result).toBeNull();
        expect(Date.now() - startedAt).toBeLessThan(1_500);
      });

      // 3. Aborted signal resolves immediately as null without issuing network calls
      const aborted = new AbortController();
      aborted.abort();
      expect(await resolveSessionProjectComputeGuidance({
        directory: emptyDir,
        serverId: 'home-1',
        machineId: 'laptop-1',
        workspaceId: 'ws-1',
        credentials: makePlainCredentials('token-aborted'),
        signal: aborted.signal,
      })).toBeNull();
    } finally {
      await removeTempDir(emptyDir);
    }
  });

  it('integrates with createSessionPromptPlanResolver without blocking startup and omits guidance when tools are disabled', async () => {
    const dir = await createTempDir('compute-guidance-plan-');
    try {
      await mkdir(join(dir, '.happier'), { recursive: true });
      await writeFile(join(dir, '.happier', 'project.json'), JSON.stringify({
        version: 1,
        scripts: {
          test: { source: { kind: 'command', command: 'pnpm test' }, execution: 'portable' },
        },
      }));

      const makeResolver = (happierToolsEnabled: boolean) => createSessionPromptPlanResolver({
        opts: {} as never,
        session: {
          sessionId: 'session-plan-1',
          getMetadataSnapshot: () => ({
            ...(happierToolsEnabled ? {} : { mcpSelectionV1: { happierToolsEnabled: false } }),
          } as never),
          enqueueSessionEventCommitted: async () => undefined as never,
        },
        agentId: 'claude',
        machineId: 'laptop-1',
        directory: dir,
        serverId: 'home-1',
        memoryRecallGuidanceEnabled: false,
        readNativeSessionId: () => null,
        daemonBridge: {
          resolvePrompt: async () => ({
            promptAssetBlocks: [],
            optionalPromptAssetsUnavailable: false,
            toolPromptContributions: [],
          }),
        } as never,
      });

      const enabledPrompt = await makeResolver(true)();
      expect(enabledPrompt).toContain('projects_script_run');
      expect(enabledPrompt).toContain('"test"');

      const disabledPrompt = await makeResolver(false)();
      expect(disabledPrompt).not.toContain('projects_script_run');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('never aliases workspaceRef across two checkouts of the same projectKey in createSessionProjectPromptStackPreparation', async () => {
    const refA = {
      id: 'ws-checkout-a',
      serverId: 'home-1',
      machineId: 'laptop-1',
      rootPath: '/repos/happier-main',
      projectKey: 'proj-shared',
      createdAtMs: 1,
      label: null,
      lastOpenedAtMs: null,
    };
    const refB = {
      id: 'ws-checkout-b',
      serverId: 'home-1',
      machineId: 'laptop-1',
      rootPath: '/repos/happier-worktree',
      projectKey: 'proj-shared',
      createdAtMs: 2,
      label: null,
      lastOpenedAtMs: null,
    };

    await withStubHttpServer((req, res) => {
      if (req.url === '/v1/account/encryption') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
        return;
      }
      if (req.url === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'listed',
          coverage: 'complete',
          rows: [
            createPlainProjectAccountRefRow(refA, 1),
            createPlainProjectAccountRefRow(refB, 1),
          ],
        }));
        return;
      }
      if (req.url === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'absent' }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      await runWithServerHttpBaseUrl(baseUrl, async () => {
        const prep = createSessionProjectPromptStackPreparation({
          credentials: makePlainCredentials('token-prep'),
          serverId: 'home-1',
        });
        const first = await prep.resolve({
          metadata: { workspaceId: refA.id, machineId: 'laptop-1', path: refA.rootPath },
          machineId: 'laptop-1',
          directory: refA.rootPath,
        });
        const second = await prep.resolve({
          metadata: { workspaceId: refB.id, machineId: 'laptop-1', path: refB.rootPath },
          machineId: 'laptop-1',
          directory: refB.rootPath,
        });
        expect(first.projectKey).toBe('proj-shared');
        expect(second.projectKey).toBe('proj-shared');
        expect(first.workspaceRef?.id).toBe(refA.id);
        expect(first.workspaceRef?.rootPath).toBe(refA.rootPath);
        expect(second.workspaceRef?.id).toBe(refB.id);
        expect(second.workspaceRef?.rootPath).toBe(refB.rootPath);
      });
    });
  });
});
