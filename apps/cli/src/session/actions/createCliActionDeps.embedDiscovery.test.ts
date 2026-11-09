import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliCapabilitiesService } from '@/rpc/handlers/capabilities';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { configuration } from '@/configuration';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('spawn-only frame model discovery', () => {
  it.each([
    ['modelSelection', 'current'], ['modelSelection', 'revoked_during_discovery'], ['configuration', 'current'],
  ] as const)('retains %s / %s admission for no-Session options without borrowing Account HTTP', async (fieldPath, admission) => {
    const pluginId = 'acme.embed-discovery';
    const identity = { pluginId, localId: 'assistant' };
    const agentId = `${pluginId}/${identity.localId}`;
    const agentTargetKey = `agent:${agentId}`;
    const capabilityId = `cli.${agentId}` as const;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      happyHomeDir: configuration.happyHomeDir, plugins: [{
        replaceExisting: true,
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { agents: [{ id: identity.localId,
          title: 'Frame assistant', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }] } }),
        files: { 'runtime.mjs': `export async function createRuntime() { return { sessions: {
          open: async () => ({ send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'requested' }),
            watch: () => ({ dispose() {} }), dispose() {} })
        } }; }`, 'daemon.mjs': `import { createRuntime } from './runtime.mjs';
        export function activate(api) {
          api.agents.register('assistant', createRuntime, {
            sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            preflightSessionControls: {
              probeModels: async () => [{ id: 'small', name: 'Small' }],
              probeConfigOptions: async () => [{ id: 'format', name: 'Format', type: 'select',
                currentValue: 'private-current', options: [{ value: 'text', name: 'Text' }] }]
            }
          });
        }` },
      }] });
    try {
      await fixture.registry.activateContributionsOnDemand([{ pluginId, family: 'agents', localId: identity.localId }]);
      const capabilities = await createCliCapabilitiesService();
      const nativeAdmission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ custodianAccountId: 'owner', machineId: 'bound-machine', installationId: 'installation' }) });
      const target = { kind: 'machine', machineId: 'bound-machine' } as const;
      const grant = ApiTokenGrantV1Schema.parse({ v: 1,
        actions: { families: [], ids: ['session.spawn_new'] }, targets: { sessions: [], machines: [target.machineId] },
        approve: false, origins: ['https://crm.example'], permissionModes: null,
        models: [{ agentTargetKey, providerConnectionId: null, modelId: 'small' }],
        create: { machineId: target.machineId, agentTargetKey, directory: 'managed', placement: { folderId: null, tagIds: [] } },
      });
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'frame-options', target,
        input: { actionId: 'session.spawn_new', fieldPath, draftInput: {
          agentTarget: { kind: 'agent', identity }, executionTarget: { machineId: target.machineId },
          ...(fieldPath === 'configuration' ? { modelSelection: { v: 1,
            ref: { agentTargetKey, providerConnectionId: null, modelId: 'small' }, updatedAt: 1 } } : {}),
        } },
      });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-proof', binding: {
        accountId: 'owner', principalId: 'owner', credentialId: 'spawn-child', grant,
        serverIdentityId: 'home', machineId: target.machineId, custodianAccountId: 'owner', installationId: 'installation',
        actionId: 'action.options.resolve', requestId: envelope.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
      // Home HTTP and installed native invocation are system boundaries. The
      // original Action ingress, grant, inventory and capability producer stay real.
      const network = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Account HTTP is unavailable to this frame'));
      let nativeReads = 0;
      const executor = createActionExecutor(createCliActionDeps({
        token: 'daemon-bearer', credentials: { token: 'daemon-bearer', encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
        externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation',
        machineActionDirectTargetTransport: { machineId: target.machineId, invoke: async (method, request, options) => {
          expect(method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
          const refusal = await nativeAdmission.rpc({ ...options?.rpcContext,
            signal: options?.signal ?? new AbortController().signal, localActionContext: options?.localActionContext });
          if (refusal) return { ok: false, error: { code: refusal.errorCode, message: refusal.error } };
          const parsed = z.object({ id: z.literal(capabilityId), method: z.string(),
            params: z.optional(z.record(z.string(), z.unknown())) }).parse(request);
          nativeReads += 1;
          return capabilities.invoke(parsed, { signal: options?.signal });
        } },
      }));
      let currentnessReads = 0;
      const result = await executeExternalAction({ actionId: 'action.options.resolve', envelope,
        principal: { accountId: 'owner', principalId: 'owner', credentialId: 'spawn-child', authority: 'account_automation', grant },
        currentMachineId: target.machineId, currentServerId: 'home', currentAccountId: 'owner', currentInstallationId: 'installation',
        executionAuthorization: authorization, externalActionMachineRequestPrivateKey: keys.secretKey,
        verifyExecutionAuthorization: async () => ++currentnessReads === 1 || admission === 'current',
        machineAdmission: { machineId: target.machineId, actorAccountId: 'owner', custodianAccountId: 'owner',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        resolveTarget: async () => target, executor,
      });
      const failureCode = result.kind === 'response' && result.response.v === 1 && !result.response.execution.ok
        ? result.response.execution.errorCode : null;
      const httpPaths = network.mock.calls.map(([url]) => new URL(String(url)).pathname);
      if (admission !== 'current') {
        expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: false } } });
        expect(nativeReads).toBe(0);
        return;
      }
      const nativeModels = [{ value: 'default', label: 'Default' }, { value: 'small', label: 'Small' }];
      const expected = fieldPath === 'modelSelection'
        ? { options: nativeModels, modelCatalog: { nativeModels } }
        : { options: [{ value: 'format', label: 'Format' }] };
      expect(result, JSON.stringify({ failureCode, nativeReads, httpPaths })).toMatchObject({ kind: 'response',
        response: { v: 1, execution: { ok: true, result: expected } } });
      if (result.kind !== 'response' || result.response.v !== 1 || !result.response.execution.ok) throw new Error('Discovery failed');
      expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].safeParse(result.response.execution.result).success).toBe(true);
      if (fieldPath === 'modelSelection') expect(nativeReads).toBe(1);
      expect(network).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });
});
