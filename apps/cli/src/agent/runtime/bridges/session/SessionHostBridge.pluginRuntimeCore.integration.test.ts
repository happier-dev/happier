import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import axios from 'axios';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createEphemeralPluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  SAMPLE_PLUGIN_BACKEND_ID,
  SAMPLE_PLUGIN_ID,
  materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { Credentials } from '@/persistence';

import { SessionHostBridge } from './SessionHostBridge';
import { createSessionAttachFile } from '@/daemon/sessionAttachFile';
import { createNativeSessionClientTestPort } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import type { HostSessionRuntimeHookRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { DEFAULT_PROVIDER_SETTINGS_V1, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveTeamCredentialModelCompatibility } from '@/providers/broker/teamCredentialModelCompatibility';
import { openSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { PROVIDER_BROKER_ENDPOINT_PATH_HEADER, PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH } from '@/providers/broker/providerBrokerPrivateProtocol';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

async function installSample(params: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  trustPolicy: 'local_trusted' | 'prompt';
}>): Promise<void> {
  await materializeSamplePluginFixture(params.pluginRoot);
  await createPluginStateStore({ happyHomeDir: params.happyHomeDir }).write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [SAMPLE_PLUGIN_ID]: {
        source: {
          kind: 'path',
          locator: params.pluginRoot,
          trustPolicy: params.trustPolicy,
          installPolicy: 'link',
          resolvedPath: params.pluginRoot,
          manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
        },
        compatibility: { status: 'unknown', diagnostics: [] },
        install: {
          mode: 'link',
          manifestVersion: '1.0.0',
          installedPath: null,
        },
        state: { enabled: true },
      },
    },
  });
}

afterEach(() => {
  envScope.restore();
  reloadConfiguration();
});

describe('SessionHostBridge current custom Agent (integration)', () => {
  it('uses an explicitly held Runner-local registry lease without consulting the daemon singleton', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-runner-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-runner-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'local_trusted' });
      const lease = createEphemeralPluginRuntimeRegistryLease(
        await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, generation: 1 }),
      );
      try {
        const plan = await new SessionHostBridge().createSessionRuntime(
          SAMPLE_PLUGIN_BACKEND_ID,
          {
            credentials: createTestCredentials(),
            directory: pluginRoot,
            happyHomeDir,
          },
          { pluginRuntimeRegistryLease: lease },
        );
        expect(plan.agentId).toBe(SAMPLE_PLUGIN_BACKEND_ID);
        expect(plan.config.createSessionRuntime).toBeTypeOf('function');
      } finally {
        await lease.release();
      }
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('creates and opens a native session through the generation-bound Agent runtime lease', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-current-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-current-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'local_trusted' });
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir, PATH: process.env.PATH ?? '' });
      reloadConfiguration();

      const plan = await new SessionHostBridge().createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      });
      expect(plan.agentId).toBe(SAMPLE_PLUGIN_BACKEND_ID);
      expect(plan.config.createSessionRuntime).toBeTypeOf('function');

      const runtime = await plan.config.createSessionRuntime?.({
        directory: pluginRoot,
        metadata: {},
        machineId: 'machine-plugin',
        session: { sessionId: 'happy-session-1' },
        transcriptSession: {},
        messageBuffer: {},
        mcpServers: {},
        permissionHandler: {},
        getPermissionMode: () => 'default',
        memoryRecallGuidanceEnabled: false,
      } as never);
      expect(runtime).toMatchObject({
        operations: {
          sendTurnPrompt: expect.any(Function),
          subscribeRuntimeEvents: expect.any(Function),
          resetOrDisposeRuntime: expect.any(Function),
        },
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it.each([false, true])('opens an experimental Team native model without recipient catalog hydration (ambient ready=%s)', async ambientReady => {
    const upstreamRequests: unknown[] = [];
    const upstream = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
        response.writeHead(204, { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' });
        response.end();
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.headers[MACHINE_HTTP_LOCAL_CAPABILITY_HEADER] !== 'synthetic-consumer-token') {
        response.writeHead(403);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output_text: 'RECIPIENT_TEAM_SENTINEL' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing controlled upstream address');
    const fixture = await createManagedRunLaunchFixture({ runtimeCredentialHeader: { name: MACHINE_HTTP_LOCAL_CAPABILITY_HEADER, format: 'raw' } });
    let disposeRuntime: (() => Promise<void>) | undefined;
    try {
      envScope.patch({ HAPPIER_HOME_DIR: fixture.happyHomeDir });
      reloadConfiguration();
      const recipient = { token: 'recipient-team-account', encryption: null };
      const snapshot = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKey(recipient),
        rawSettings: {}, providerConnectionsCatalog: undefined };
      const account = createInvocationSavedSecretOperationContextV1({ credentials: recipient, snapshot,
        serverHttpBaseUrl: 'https://recipient-team-home.invalid', isCurrent: async () => true });
      const ambient = { ...snapshot, scopeKey: 'unrelated-daemon-account', providerConnectionsCatalog: ambientReady ? {
        status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog } : undefined };
      setActiveAccountSettingsSnapshot(ambient);
      const model = {
        selection: { kind: 'team_credential_provider_model' as const, resourceId: 'resource-1', teamId: 'team-1',
          expectedResourceRevision: 3, deliveryMode: 'brokered' as const, agentTargetKey: fixture.agentTargetKey, modelId: 'gpt-5.6-luna' },
        descriptor: { id: 'gpt-5.6-luna', name: 'Team model' },
        application: { agentTargetKey: fixture.agentTargetKey,
          implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
          endpointTemplateId: 'responses', protocol: 'openai-responses' },
        sourceRevision: 'source-3', availability: 'available' as const,
        sourceFacts: ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: 'responses', protocol: 'openai-responses',
          capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } },
          compatibilityOverrides: [{ agentTargetKey: fixture.agentTargetKey, protocol: 'openai-responses', status: 'experimental',
            reason: 'Experimental Agent pairing' }] }),
      };
      const compatibility = await resolveTeamCredentialModelCompatibility({ lease: fixture.lease, agentId: fixture.agentId,
        model: { ...model, deliveryMode: 'brokered' } });
      expect(compatibility).toMatchObject({ result: { status: 'experimental' }, confirmed: true });
      // Only the authenticated Home HTTP boundary is substituted. Catalog loading,
      // own-Account custody and materialization stay real.
      let providerCatalogReads = 0;
      vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        expect(new URL(String(url)).origin).toBe(account.serverHttpBaseUrl);
        expect(options?.headers?.Authorization).toBe(`Bearer ${recipient.token}`);
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/entity-rows/provider-connections') {
          providerCatalogReads++;
          return { status: 200, data: { status: 'present', revision: 2,
            content: { t: 'plain', v: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog } } };
        }
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        const history = emptyAccountSettingsHistoryCaptureResponse(path);
        if (history) return history;
        throw new Error(`Unexpected Home read: ${path}`);
      });
      const prepareTeamCredentialProviderBinding = async (input: Readonly<{ signal: AbortSignal }>) => {
        const opened = await openSessionTeamCredentialProviderBinding({
          sessionId: 'recipient-team-session', machineId: 'worker', agentId: fixture.agentId,
          agentTargetKey: fixture.agentTargetKey, modelId: model.descriptor.id,
          binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3,
            deliveryMode: 'brokered', teamId: 'team-1' },
          lease: fixture.lease, materializationBaseDir: join(fixture.happyHomeDir, 'materialized'), signal: input.signal,
          readCatalog: async () => [model],
          openBroker: async request => ({ ok: true, target: { custodianAccountId: 'custodian', brokerMachineId: 'broker',
            endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } },
            authority: { payload: { v: 1, aud: 'happier-provider-broker-route-v1', grantId: 'grant', issuedAt: 1, expiresAt: 2,
              teamId: 'team-1', resourceId: request.resourceId, sourceRevision: request.sourceRevision,
              brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
              initiator: { accountId: 'recipient', machineId: 'worker', endpointId: 'a'.repeat(64) },
              target: { custodianAccountId: 'custodian', machineId: 'broker', endpointId: 'b'.repeat(64) },
              consumer: request.consumer, application: request.application },
              signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) } } }),
          openTunnel: async () => {
            return { localPort: address.port, localCapability: 'synthetic-consumer-token', observedPath: 'direct',
              retire: async () => undefined, close: async () => undefined };
          },
        });
        if (!opened) throw new Error('Expected Team binding');
        return opened;
      };
      const identity = fixture.contributes.agentDefinitionsById.get(fixture.agentId)?.identity;
      if (!identity) throw new Error('Missing admitted Agent identity');
      const plan = await new SessionHostBridge().createSessionRuntime(fixture.agentId, {
        credentials: recipient, directory: fixture.happyHomeDir, happyHomeDir: fixture.happyHomeDir,
        backendTarget: { kind: 'agent', identity },
        teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3,
          deliveryMode: 'brokered', teamId: 'team-1' }],
        modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: null, modelId: model.descriptor.id } },
      }, { pluginRuntimeRegistryLease: fixture.lease, prepareTeamCredentialProviderBinding });
      const session = createNativeSessionClientTestPort('recipient-team-session');
      const presentationLifetime = new AbortController();
      onTestFinished(() => presentationLifetime.abort());
      const presentation = createCurrentSessionPresentationHost({ session, signal: presentationLifetime.signal });
      const created = await plan.config.createSessionRuntime?.({ directory: fixture.happyHomeDir, metadata: {}, machineId: 'worker', session,
        currentSessionPresentation: presentation.bindCurrentSession, transcriptSession: {}, messageBuffer: {}, mcpServers: {},
        permissionHandler: { cancelByPluginTurn: async () => undefined }, getPermissionMode: () => 'safe-yolo', memoryRecallGuidanceEnabled: false } as never);
      if (!created) throw new Error('Expected native runtime');
      const operations = created.operations;
      disposeRuntime = operations.resetOrDisposeRuntime;
      await operations.sendTurnPrompt('recipient catalog admitted', { turnId: 'recipient-turn', localId: 'recipient-input', userMessageSeq: 1 });
      expect(upstreamRequests).toEqual([{ model: model.descriptor.id, input: 'recipient catalog admitted' }]);
      expect(account.readSnapshot()?.providerConnectionsCatalog).toBeUndefined();
      expect(providerCatalogReads).toBe(0);
      expect(getActiveAccountSettingsSnapshot()).toEqual(ambient);
      expect(upstreamRequests).toHaveLength(1);
    } finally {
      await disposeRuntime?.();
      vi.restoreAllMocks();
      resetActiveAccountSettingsSnapshotForTests();
      await fixture.cleanup();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([false, true])('uses the host-owned Team credential preparation callback for a pinned plugin runtime (committed attach=%s)', async attached => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-team-credential-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-team-credential-plugin-'));
    const upstreamRequests: unknown[] = [];
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output_text: 'TEAM_BINDING_SENTINEL' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing controlled upstream address');
    const upstreamUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
      reloadConfiguration();
      const fixture = await createManagedRunLaunchFixture({ directory: pluginRoot, happyHomeDir });
      const lease = fixture.lease;
      const agentId = fixture.agentId;
      const identity = fixture.contributes.agentDefinitionsById.get(agentId)?.identity;
      if (!identity) throw new Error('Missing admitted external Agent identity');
      const prepareTeamCredentialProviderBinding = vi.fn(async () => ({
        providerBinding: {
          source: {
            kind: 'team_resource' as const,
            resourceId: 'resource-1',
            resourceRevision: 3,
          },
          model: { id: 'gpt-5.5', name: 'Team model' },
          upstream: {
            protocol: 'openai-responses',
            normalizedUrl: upstreamUrl,
            credential: 'apiKey' as const,
          },
          materialization: { v: 1 as const, kind: 'spawnEnv' as const },
        },
        environmentOverlay: [{
          name: 'RUN_PROVIDER_TOKEN',
          value: 'synthetic-consumer-token',
          source: 'provider' as const,
        }],
        additionalRedactionValues: ['synthetic-consumer-token'],
        cleanup: async () => {},
      }));
      const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource-1',
        expectedResourceRevision: 3, deliveryMode: 'brokered' as const, teamId: 'team-1' };
      const attachFile = attached ? await createSessionAttachFile({ happySessionId: 'runner-session-1',
        payload: { v: 2, encryptionMode: 'plain', snapshot: { metadata: {}, metadataVersion: 0,
          agentState: null, agentStateVersion: 0, acceptedTeamCredentialBinding: binding } },
      }) : null;
      try {
        const plan = await new SessionHostBridge().createSessionRuntime(
          agentId,
          {
            credentials: createTestCredentials(),
            directory: pluginRoot,
            happyHomeDir,
            backendTarget: {
              kind: 'agent',
              identity,
            },
            ...(attachFile ? { existingSessionId: 'runner-session-1', sessionAttachFilePath: attachFile.filePath }
              : { teamCredentialBindings: [binding] }),
            modelSelection: {
              v: 1,
              updatedAt: 1,
              ref: {
                agentTargetKey: fixture.agentTargetKey,
                providerConnectionId: null,
                modelId: 'gpt-5.5',
              },
            },
          },
          {
            pluginRuntimeRegistryLease: lease,
            prepareTeamCredentialProviderBinding,
          },
        );

        const session = createNativeSessionClientTestPort('runner-session-1');
        const presentationLifetime = new AbortController();
        onTestFinished(() => presentationLifetime.abort());
        const presentation = createCurrentSessionPresentationHost({ session, signal: presentationLifetime.signal });
        const runtime = await plan.config.createSessionRuntime?.({
          directory: pluginRoot,
          metadata: {},
          machineId: 'runner-machine-1',
          session,
          currentSessionPresentation: presentation.bindCurrentSession,
          transcriptSession: {},
          messageBuffer: {},
          mcpServers: {},
          permissionHandler: { cancelByPluginTurn: async () => undefined },
          getPermissionMode: () => 'safe-yolo',
          memoryRecallGuidanceEnabled: false,
        } as never);

        expect(runtime).toMatchObject({
          operations: {
            sendTurnPrompt: expect.any(Function),
            resetOrDisposeRuntime: expect.any(Function),
          },
        });
        if (!runtime) throw new Error('Expected the created host runtime');
        const resolved = resolveHostSessionRuntimeFactoryResult(runtime);
        const hookRuntime = (resolved.nativeRuntime ?? resolved.runtime) as HostSessionRuntimeHookRuntime;
        const operations = (runtime as Readonly<{ operations: Readonly<{
          sendTurnPrompt(prompt: string, input: Readonly<{
            turnId: string;
            localId: string;
            userMessageSeq: number;
          }>): Promise<void>;
          subscribeRuntimeEvents(listener: (event: Readonly<{ kind?: string; turnId?: string }>) => void): (() => void) | void;
          resetOrDisposeRuntime(): Promise<void>;
        }> }>).operations;
        const events: Readonly<{ kind?: string; turnId?: string }>[] = [];
        const unsubscribe = operations.subscribeRuntimeEvents((event) => events.push(event));
        await operations.sendTurnPrompt('brokered turn through external plugin', {
          turnId: 'runner-external-turn-1',
          localId: 'runner-external-input-1',
          userMessageSeq: 1,
        });
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'input-accepted',
          delivery: { kind: 'newTurn', turnId: 'runner-external-turn-1' },
        }));
        expect(upstreamRequests).toEqual([{ model: 'gpt-5.5', input: 'brokered turn through external plugin' }]);
        await expect(hookRuntime.prepareRunTeamCredentialProviderBinding?.({
          runId: 'run-1',
          agentId,
          resourceId: 'resource-1',
          modelId: 'gpt-5.5',
        })).resolves.toMatchObject({
          providerBinding: {
            source: { kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 3 },
          },
        });
        expect(prepareTeamCredentialProviderBinding).toHaveBeenLastCalledWith({
          sessionId: 'runner-session-1',
          resourceId: 'resource-1',
          expectedResourceRevision: 3,
          agentTargetKey: fixture.agentTargetKey,
          modelId: 'gpt-5.5',
          consumer: { kind: 'execution_run', executionRunId: 'run-1' },
          executionRunAgentId: agentId,
          signal: expect.any(AbortSignal),
        });
        // An attached Run that independently selected a direct resource for
        // another Agent opens its own selection for its own Agent.
        await hookRuntime.prepareRunTeamCredentialProviderBinding?.({
          runId: 'run-direct',
          agentId: 'run-agent',
          resourceId: 'resource-direct',
          modelId: 'direct-model',
          selection: {
            kind: 'team_credential_provider_model',
            resourceId: 'resource-direct',
            teamId: 'team-direct',
            expectedResourceRevision: 9,
            deliveryMode: 'direct',
            agentTargetKey: 'agent:other.plugin/run-agent' as never,
            modelId: 'direct-model' as never,
          },
        });
        expect(prepareTeamCredentialProviderBinding).toHaveBeenLastCalledWith({
          sessionId: 'runner-session-1',
          resourceId: 'resource-direct',
          expectedResourceRevision: 9,
          agentTargetKey: 'agent:other.plugin/run-agent',
          modelId: 'direct-model',
          consumer: { kind: 'execution_run', executionRunId: 'run-direct' },
          executionRunSelection: { teamId: 'team-direct', deliveryMode: 'direct' },
          executionRunAgentId: 'run-agent',
          signal: expect.any(AbortSignal),
        });
        unsubscribe?.();
        await operations.resetOrDisposeRuntime();
        presentationLifetime.abort();
        expect(prepareTeamCredentialProviderBinding).toHaveBeenCalledWith({
          sessionId: 'runner-session-1',
          resourceId: 'resource-1',
          expectedResourceRevision: 3,
          agentTargetKey: fixture.agentTargetKey,
          modelId: 'gpt-5.5',
          signal: expect.any(AbortSignal),
        });
        if (attachFile) await expect(import('node:fs/promises').then(fs => fs.stat(attachFile.filePath))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await attachFile?.cleanup();
        await fixture.cleanup();
      }
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('fails before runtime creation when the current Agent plugin still requires trust approval', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-prompt-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-prompt-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'prompt' });
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir, PATH: process.env.PATH ?? '' });
      reloadConfiguration();

      await expect(new SessionHostBridge().createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      })).rejects.toThrow(/trust approval/i);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
