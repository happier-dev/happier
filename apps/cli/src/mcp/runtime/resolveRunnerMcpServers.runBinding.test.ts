import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  accountSettingsParse,
  FeaturesResponseSchema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createExecutionRunOccurrenceWitnessRegistry } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { SessionActionConfirmationRuntimeBinding } from '@/session/actions/approvals/sessionActionConfirmation';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';

const persistenceMocks = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceMocks.readStoredCredentials,
}));
vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: vi.fn(async () => ({
    status: 'ready' as const,
    features: {
      features: { teams: { enabled: true, credentialResources: { enabled: true } } },
      capabilities: {},
    },
  })),
}));

// The daemon catalog is a transport boundary; the MCP server and Action execution stay real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  resetActiveAccountSettingsSnapshotForTests();
});

describe('Session-owned Run MCP binding', () => {
  it('refreshes selected shared Saved Secrets before composing an Execution Run MCP profile', async () => {
    const token = 'runtime-test-token';
    const resourceId = 'revoked-run-mcp-resource';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const accountSettings = accountSettingsParse({
      mcpServersSettingsV1: {
        v: 1,
        strictMode: true,
        servers: [{
          id: 'shared-run-server',
          name: 'shared-run-server',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: { API_KEY: { t: 'savedSecret', secretId: ref } },
          createdAt: 1,
          updatedAt: 1,
        }],
        bindings: [{
          id: 'shared-run-binding',
          serverId: 'shared-run-server',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    const staleResource = {
      resourceId,
      ownerAccountId: 'owner-account',
      displayName: 'Revoked run key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 4,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1, name: 'Revoked run key', kind: 'apiKey', value: 'stale-value' },
      }),
      materialStatus: 'ready' as const,
    };
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettings,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [staleResource],
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });

    await expect(resolveRunnerMcpServers({
      session: {} as HappyMcpSessionClient,
      credentials: { token, encryption: null },
      accountSettings,
      savedSecretResources: [staleResource],
      machineId: 'machine-a',
      directory: '/run/a',
      env: {},
      tmpDir: null,
      executionRun: {
        runId: 'run-a',
        workDepth: 0,
        cwd: '/run/a',
        signal: new AbortController().signal,
        isCurrent: () => true,
        readActiveTurnAdmissionWitness: () => null,
        readCurrentRunOccurrence: () => null,
      },
    })).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed',
      status: 'forbidden',
      reference: ref,
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the parent profile but binds confirmation to this Run occurrence and admitted turn', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const lifetime = new AbortController();
    const parentLifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = {
      inputId: 'input-run-a', turnId: 'turn-run-a', userMessageSeq: 3, userMessageSeqs: [3],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    };
    const controller = {
      kind: 'backend',
      controllerOccurrenceId: 'run-a-occurrence-1',
    } as ExecutionRunController;
    const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['run-a', controller]]));
    const occurrence = registry.register({
      runId: 'run-a', sidechainId: 'sidechain-a', runtimeLifetimeSignal: lifetime.signal,
      controller: controller as Extract<ExecutionRunController, { kind: 'backend' }>,
      readActiveTurnAdmissionWitness: () => witness,
    });
    // A holder, not a `let`: narrowing across the MCP request boundary would
    // otherwise collapse the captured binding to `null` for the assertions below.
    const captured: { binding: SessionActionConfirmationRuntimeBinding | null } = { binding: null };
    const parent: HappyMcpSessionClient = {
      sessionId: 'session-a',
      getServerBinding: () => ({
        serverId: 'test-home',
        serverUrl: 'https://test-home.example.test',
      }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session-a', encryptionMode: 'plain' }),
      updateMetadata: () => undefined,
      getPermissionMode: () => 'yolo',
      getRuntimeLifetimeSignal: () => parentLifetime.signal,
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({
          features: {
            sharing: {
              enabled: true,
              session: { enabled: true },
            },
            sessions: {
              enabled: true,
              conversations: { enabled: true },
            },
          },
          capabilities: {},
        }),
      }),
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn-parent',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      }),
      confirmSessionAction: async (_request, binding) => {
        captured.binding = binding;
        return { decision: 'reject', isCurrent: () => true };
      },
    };
    const binding = await resolveRunnerMcpServers({
      session: parent,
      credentials: { token: 'runtime-test-token', encryption: null },
      accountSettings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: { 'session.activity.get': { approvalRequiredSurfaces: ['agent'] } },
      } }),
      machineId: 'machine-a', directory: '/run/a',
      resolvedMcpServers: { extra: { command: 'authorized-tool', env: { SECRET: 'already-resolved' } } },
      executionRun: {
        runId: 'run-a', workDepth: 4, cwd: '/run/a', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted,
        getPermissionMode: () => 'default',
        readActiveTurnAdmissionWitness: () => witness,
        readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence,
      },
    });
    const client = new Client({ name: 'run-binding-test', version: '1' }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
      const result = await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.activity.get', input: { sessionId: 'session-a' } } });
      expect(captured.binding, JSON.stringify(result)).toMatchObject({
        turnId: 'turn-run-a',
        run: { runId: 'run-a', sidechainId: 'sidechain-a', occurrenceId: occurrence.occurrence.occurrenceId },
      });
      expect(binding.mcpServers.extra).toEqual({ command: 'authorized-tool', env: { SECRET: 'already-resolved' } });
      expect(binding.happierMcpServer.supportedSessionReadActions).toEqual([
        'session.transcript.get',
        'session.discussion.list',
        'session.discussion.get',
        'session.discussion.read',
      ]);
      expect(binding.happierMcpServer.supportedSessionReadActions).not.toContain('session.discussion.post');
      expect(parent.getActiveTurnPermissionWitness?.()?.turnId).toBe('turn-parent');
      expect(captured.binding?.isCurrent()).toBe(true);
      occurrence.dispose();
      expect(captured.binding?.isCurrent()).toBe(false);
    } finally {
      await client.close();
      binding.happierMcpServer.stop();
    }
  });
});
