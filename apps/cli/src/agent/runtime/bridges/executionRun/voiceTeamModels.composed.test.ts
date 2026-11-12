import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2, type TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveProviderSourceFacts } from '@/providers/registry/sourceFacts';
import { openSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { PROVIDER_BROKER_ENDPOINT_PATH_HEADER, PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH } from '@/providers/broker/providerBrokerPrivateProtocol';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { createExecutionRunRuntime } from './runtime/create';
import { startExecutionRun } from './startExecutionRun';
import { projectRetainedExecutionRunState } from './retainedState';
import type { ExecutionRunState } from './executionRunTypes';

describe('Voice Team model launch composition', () => {
  it('opens independent brokered chat and commit bindings and retains both exact selections', async () => {
    const worker = await createManagedRunLaunchFixture();
    const endpoint = createServer((request, response) => {
      if (request.url === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
        response.writeHead(204, { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' });
        response.end();
      } else response.end('{}');
    });
    await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Expected broker listener');
    const backendTarget = convertBackendTargetRefV2ToV1(readBackendTargetRefV2({ kind: 'backend', backendId: worker.agentId }));
    const source = resolveProviderSourceFacts(worker.record);
    const template = source.endpointTemplates[0]!;
    const chat: TeamCredentialProviderModelSelectionV1 = { kind: 'team_credential_provider_model',
      resourceId: 'chat-resource', teamId: 'team', expectedResourceRevision: 3,
      agentTargetKey: worker.agentTargetKey, modelId: 'model-a', deliveryMode: 'brokered' };
    const commit: TeamCredentialProviderModelSelectionV1 = { ...chat, resourceId: 'commit-resource' };
    const application = { agentTargetKey: worker.agentTargetKey,
      implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
      endpointTemplateId: template.id, protocol: template.protocol };
    const rows = [chat, commit].map(selection => ({ selection, descriptor: { id: selection.modelId, name: 'Team model' },
      sourceRevision: 'source-v1', availability: 'available' as const, application,
      sourceFacts: ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: template.id, protocol: template.protocol, capabilities: template.capabilities },
        credential: source.credential, compatibilityOverrides: source.compatibilityOverrides }) }));
    const opened: string[] = [];
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const manager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Expected launch-bound factory'); } });
    try {
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: worker.lease.registry });
      const session = createMutableApiSessionClientFixture({ sessionId: 'parent', metadata: createTestMetadata({ path: worker.happyHomeDir }),
        overrides: { enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
          enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }) } });
      const permissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Voice Team fixture]' });
      permissionHandler.setPermissionMode('read-only');
      const createRuntime: Parameters<typeof startExecutionRun>[0]['createRuntime'] = options => createExecutionRunRuntime({
        ...options, backendTarget, engineRegistry, scope: 'session_owned', cwd: worker.happyHomeDir,
        happierSessionId: 'parent',
        sessionInteractionHost: { session, machineId: worker.machineId, permissionHandler,
          prepareRunTeamCredentialProviderBinding: async () => null },
        happyHomeDir: worker.happyHomeDir, machineId: worker.machineId,
        resolveProvidersFeatureEnabled: () => true, resolveAccountSettingsSnapshot: async () => worker.snapshot,
        prepareRunTeamCredentialProviderBinding: async input => {
          const selection = input.selection;
          if (!selection) throw new Error('Explicit Voice role selection was lost');
          opened.push(selection.resourceId);
          return openSessionTeamCredentialProviderBinding({
            sessionId: 'parent', consumer: { kind: 'execution_run', executionRunId: input.runId },
            machineId: worker.machineId, agentId: worker.agentId, agentTargetKey: selection.agentTargetKey,
            modelId: selection.modelId, binding: { v: 1, slot: { kind: 'provider_model' },
              resourceId: selection.resourceId, expectedResourceRevision: selection.expectedResourceRevision,
              deliveryMode: selection.deliveryMode, teamId: selection.teamId },
            lease: worker.lease, materializationBaseDir: worker.happyHomeDir,
            signal: new AbortController().signal,
            // Home and the machine carrier are network boundaries. The real
            // selection admission, adapter and native Agent remain composed.
            readCatalog: async () => rows,
            openBroker: async request => ({ ok: true, authority: { payload: {
              v: 1, grantId: 'grant', aud: 'happier-provider-broker-route-v1', issuedAt: 1, expiresAt: 2,
              teamId: 'team', resourceId: request.resourceId, sourceRevision: 'source-v1',
              brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
              initiator: { accountId: 'member', machineId: worker.machineId, endpointId: 'a'.repeat(64) },
              target: { custodianAccountId: 'owner', machineId: 'broker', endpointId: 'b'.repeat(64) },
              consumer: request.consumer, application,
            }, signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) } },
              target: { custodianAccountId: 'owner', brokerMachineId: 'broker', endpointId: 'b'.repeat(64),
                endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
            openTunnel: async () => ({ localPort: address.port, localCapability: 'c'.repeat(64), observedPath: 'relay',
              retire: async () => {}, close: async () => {} }),
          });
        },
      });
      const request = ExecutionRunStartRequestSchema.parse({ intent: 'voice_agent', backendTarget,
          chatModelId: chat.modelId, commitModelId: commit.modelId,
          teamCredentialModel: chat, intentInput: { commitTeamCredentialModel: commit }, connectedServices: null,
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
          bootstrapMode: 'none', commitIsolation: false });
      const started = await startExecutionRun({
        params: { ...request, sessionId: 'parent',
          backendTarget: convertBackendTargetRefV2ToV1(readBackendTargetRefV2(request.backendTarget)) },
        parentProvider: worker.agentId, sendAcp: async () => {}, streamedTranscriptSession: null, createRuntime,
        getNowMs: () => 1, budgetRegistry: null, runs, controllers, enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {}, finishRun: async (id, patch) => {
          const run = runs.get(id);
          if (run) runs.set(id, { ...run, ...patch });
        }, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager: manager,
      });
      expect(runs.get(started.runId)?.error).toBeUndefined();
      expect(opened).toEqual(['chat-resource']);
      expect(await manager.sendTurn({ voiceAgentId: started.runId, userText: 'Hello' })).toMatchObject({ assistantText: 'Managed Run completed' });
      expect(await manager.commit({ voiceAgentId: started.runId })).toMatchObject({ commitText: 'Managed Run completed' });
      expect(opened).toEqual(['chat-resource', 'commit-resource']);
      const resumeHandle = manager.getResumeHandle(started.runId);
      await manager.stop({ voiceAgentId: started.runId });
      const retained = projectRetainedExecutionRunState({ ...runs.get(started.runId)!, status: 'cancelled', resumeHandle });
      expect(retained.voiceAgentConfig).toMatchObject({ chatTeamCredentialModel: chat, commitTeamCredentialModel: commit });
    } finally {
      await manager.dispose();
      await worker.cleanup();
      await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    }
  });
});
