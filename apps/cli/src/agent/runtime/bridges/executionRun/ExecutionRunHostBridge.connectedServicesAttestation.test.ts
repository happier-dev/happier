import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionExecutionRunBrokerAuthorityResponseV1 } from '@happier-dev/protocol';

import { findCatalogEntry } from '@/agent/catalog/registry';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';

/**
 * An Execution Run's own direct Team connected-service material is opened
 * DURING its connected-services materialization: the daemon asks the Home,
 * and the Home asks this Run's owner whether the Run currently selects that
 * exact direct resource (`expectedDirectMaterialUse`). The Run owner must be
 * able to attest its own resolved selection at that moment, before the
 * materialization it is part of has returned a registration.
 *
 * The Run owner (`ExecutionRunHostBridge`) and the Run runtime
 * (`createExecutionRunRuntime`) are real. Only true boundaries are doubled:
 * the plugin runtime's engine resolution, and the runner→daemon control
 * bridge — whose materialization double makes the Home's Run-owner query
 * exactly as the daemon relays it.
 */

const CODEX_SERVICE = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const CODEX_SERVICE_ID = 'happier.agent.codex/openai-codex';
const CODEX_AGENT = { pluginId: 'happier.agent.codex', localId: 'codex' } as const;
const DISCLOSED_MEMBER = { service: CODEX_SERVICE, accountId: 'member-account-1' } as const;

const boundaries = vi.hoisted(() => ({
  resolveBackendEngineAdapterResolution: vi.fn(),
  requestExecutionRunConnectedServicesMaterialization: vi.fn(),
  releaseExecutionRunConnectedServices: vi.fn(async () => ({ ok: true as const, released: true })),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/agent/runtime/registry/engineRegistry')>(),
  resolveBackendEngineAdapterResolution: boundaries.resolveBackendEngineAdapterResolution,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestExecutionRunConnectedServicesMaterialization:
    boundaries.requestExecutionRunConnectedServicesMaterialization,
  releaseExecutionRunConnectedServices: boundaries.releaseExecutionRunConnectedServices,
}));

const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');

let cwd = '';

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'happier-run-cs-attestation-'));
  runGit(cwd, ['init', '--initial-branch=main']);
});

afterAll(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('Execution Run direct Team connected-service material', () => {
  it('attests the Run\'s own resolved selection to the Home during its own materialization', async () => {
    const runtime = createTestExecutionRunHostRuntime({ onWaitForTurnCompletion: async () => {} });
    const workflowRunId = 'review-workflow-run';
    boundaries.resolveBackendEngineAdapterResolution.mockResolvedValue({
      backendId: 'codex',
      agentId: 'codex',
      provenance: 'built_in',
      runtimeOwner: { backendId: 'codex', selected: null, candidates: [] },
      backend: {
        id: 'codex',
        agentId: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
        runtimeKind: 'acp',
        capabilities: { executionRun: true },
      },
      agent: {
        id: 'codex',
        identity: CODEX_AGENT,
        catalogEntry: findCatalogEntry('codex'),
        provenance: 'built_in',
        source: { kind: 'built_in' },
      },
      engineAdapter: { runtimeCore: { createExecutionRunBackend: () => runtime } },
      executionSurfaces: {},
      diagnostics: [],
    });

    let bridge!: InstanceType<typeof ExecutionRunHostBridge>;
    const homeQueries: SessionExecutionRunBrokerAuthorityResponseV1[] = [];
    const materialization = Promise.withResolvers<void>();
    boundaries.requestExecutionRunConnectedServicesMaterialization.mockImplementation(async (
      request: { runId: string; connectedServices: unknown },
    ) => {
      // The Home's direct-material open asks the Run owner, relayed by the daemon.
      homeQueries.push(bridge.resolveLiveBrokerAuthority({
        v: 1,
        executionRunId: request.runId,
        expectedOccurrenceId: null,
        expectedDirectMaterialUse: {
          resourceId: 'resource-direct',
          slot: {
            kind: 'connected_service_purpose',
            purpose: { consumer: CODEX_AGENT, purpose: 'primary' },
          },
          disclosedMember: DISCLOSED_MEMBER,
        },
      }));
      materialization.resolve();
      return {
        ok: true,
        result: {
          activationId: '11111111-1111-4111-8111-111111111111',
          env: {},
          connectedServicesBindings: request.connectedServices,
          registration: {
            v: 1,
            activationId: '11111111-1111-4111-8111-111111111111',
            runKey: request.runId,
            agentId: 'codex',
            materializationKey: request.runId,
            connectedServicesBindings: request.connectedServices,
            connectedServiceSelectionsEnv: {},
            sessionDirectory: cwd,
            materializedRoot: null,
          },
        },
      };
    });

    const pluginRuntime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: [CODEX_AGENT.pluginId] },
    });
    bridge = new ExecutionRunHostBridge({
      parentProvider: 'codex' as never,
      cwd,
      sendAcp: async () => {},
      getNowMs: () => 1_700_000_000_000,
    });
    try {
      const started = await bridge.start({
        sessionId: null,
        workflowRunId,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' as never },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            [CODEX_SERVICE_ID]: {
              source: 'team_resource',
              resourceId: 'resource-direct',
              deliveryMode: 'direct',
              disclosedMember: DISCLOSED_MEMBER,
            },
          },
        },
      });
      await Promise.race([
        materialization.promise,
        bridge.waitForTerminal(started.runId).then(() => {
          const errorCode = bridge.get(started.runId)?.error?.code ?? 'unknown';
          throw new Error('Run ended before Direct material acquisition (' + errorCode + ')');
        }),
      ]);
      expect(homeQueries).toEqual([expect.objectContaining({
        status: 'current',
        parentSessionId: null,
        workflowRunId,
      })]);
    } finally {
      try {
        await bridge.dispose();
      } finally {
        await pluginRuntime.dispose();
      }
    }
  });
});
