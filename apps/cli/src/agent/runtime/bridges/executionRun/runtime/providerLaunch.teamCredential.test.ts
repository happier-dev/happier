import { describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import { prepareExecutionRunProviderLaunch } from './providerLaunch';
import { prepareExecutionRunRuntimeProviderLaunch } from './providerPreparation';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRunnerExecutionRunProviderLaunchServices } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveProviderSourceFacts } from '@/providers/registry/sourceFacts';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { openSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';

describe('Execution Run Team credential Provider launch', () => {
  it('prepares native delivery through the pinned service and real adapter without entering the runner local opener', async () => {
    const worker = await createManagedRunLaunchFixture();
    const target = readBackendTargetRefV2({ kind: 'backend', backendId: worker.agentId });
    const agent = await resolveRunnerAgentSessionDescriptorForLease({ target, lease: worker.lease });
    const binding = worker.lease.registry.agentRuntimesByAgentId.get(worker.agentId)?.sessionRunnerFactoryBinding;
    if (!agent || !binding) throw new Error('Expected committed fixture Agent');
    const source = resolveProviderSourceFacts(worker.record);
    const endpoint = source.endpointTemplates[0]!;
    const nativeDelivery = { managedId: 'managed-native', controllerInstallationId: 'controller-installation',
      guestInstallationId: 'guest-installation', bindingKey: 'native-binding', placeholderRef: 'placeholder-ref',
      sourceRevision: 'source-v1', providerTicket: 't'.repeat(43) };
    const selection = { kind: 'team_credential_provider_model' as const, resourceId: 'team-resource', teamId: 'team',
      expectedResourceRevision: 1, agentTargetKey: worker.agentTargetKey, modelId: 'model-a',
      deliveryMode: 'vendor-native' as const, nativeDelivery };
    const row = { selection, descriptor: { id: 'model-a', name: 'Model A' }, sourceRevision: 'source-v1', availability: 'available' as const,
      nativeSource: { providerTicket: nativeDelivery.providerTicket },
      application: { agentTargetKey: worker.agentTargetKey, implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
        endpointTemplateId: endpoint.id, protocol: endpoint.protocol },
      sourceFacts: ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: endpoint.id, protocol: endpoint.protocol, capabilities: endpoint.capabilities },
        credential: source.credential, compatibilityOverrides: source.compatibilityOverrides }) };
    const launchReleases: Array<() => void | Promise<void>> = [];
    let nativeBorrowReleases = 0;
    const services = createRunnerExecutionRunProviderLaunchServices({ agent: { descriptor: agent, binding }, backendTarget: target,
      runtimeRegistryLease: worker.lease, retainCleanup: cleanup => { launchReleases.push(cleanup); },
      resolvePreparation: async () => ({ machineId: worker.machineId, featureEnabled: true, happyHomeDir: worker.happyHomeDir,
        accountSettingsSnapshot: worker.snapshot, isCurrent: () => true,
        prepareTeamCredentialProviderBinding: async () => openSessionTeamCredentialProviderBinding({
          sessionId: 'owning-session', consumer: { kind: 'execution_run', executionRunId: 'native-run' },
          machineId: worker.machineId, agentId: worker.agentId, agentTargetKey: worker.agentTargetKey, modelId: selection.modelId,
          binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: selection.resourceId,
            expectedResourceRevision: 1, deliveryMode: selection.deliveryMode, teamId: selection.teamId, nativeDelivery },
          lease: worker.lease, materializationBaseDir: worker.happyHomeDir, signal: new AbortController().signal,
          readCatalog: async () => { throw new Error('Pinned native borrow must not read a controller catalog'); }, openVendorNative: async () => ({ model: row,
            endpoint: { endpointTemplateId: endpoint.id, normalizedUrl: 'https://gateway.example.test/v1', protocol: endpoint.protocol, publicHeaders: {} },
            credentialTransport: source.credential!.transports[0]!, placeholder: 'retained-native-placeholder',
            revalidate: async () => undefined, cleanup: async () => { nativeBorrowReleases++; },
          }),
        }),
      }),
    });
    let localOpens = 0;
    try {
      const prepared = await prepareExecutionRunRuntimeProviderLaunch({ scope: 'session_owned', providerLaunch: services,
        teamCredentialModel: selection, backendTarget: target, agentId: worker.agentId, runId: 'native-run',
        happyHomeDir: worker.happyHomeDir, resolveAccountSettingsSnapshot: async () => worker.snapshot,
        prepareTeamCredentialProviderBinding: async () => { localOpens++; throw new Error('Runner local native preparation reached'); },
      });
      expect(prepared.environment.RUN_PROVIDER_TOKEN).toBe('retained-native-placeholder');
      expect(prepared.providerBinding?.source).toMatchObject({ kind: 'team_resource', resourceId: selection.resourceId });
      expect(localOpens).toBe(0);
      for (const release of launchReleases) await release();
      expect(nativeBorrowReleases).toBe(1);
    } finally {
      for (const release of launchReleases) await release();
      await worker.cleanup();
    }
  });

  it('consumes the parent Session owner with the exact Run identity and retains cleanup', async () => {
    const cleanup = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => ({
      providerBinding: {
        source: { kind: 'team_resource' as const, resourceId: 'resource-1', resourceRevision: 3 },
        model: { id: 'model-1', name: 'Model 1' },
        upstream: { protocol: 'openai-responses' as const, normalizedUrl: 'http://127.0.0.1:43123/v1', credential: 'apiKey' as const },
        materialization: { v: 1 as const, kind: 'spawnEnv' as const },
      },
      environmentOverlay: [{ name: 'OPENAI_API_KEY', value: 'scoped-authority', source: 'provider' as const }],
      additionalRedactionValues: ['scoped-authority'],
      cleanup,
    }));

    const launch = await prepareExecutionRunProviderLaunch({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      agentId: 'codex', runId: 'run-1', featureEnabled: true, happyHomeDir: '/tmp/happier',
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          github: { source: 'connected', selection: 'profile', profileId: 'profile-1' },
        },
      },
      prepareTeamCredentialProviderBinding: prepare,
    });

    expect(prepare).toHaveBeenCalledWith({ runId: 'run-1', agentId: 'codex' });
    expect(launch.providerBinding?.source).toEqual({ kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 3 });
    expect(launch.environment).toEqual({ OPENAI_API_KEY: 'scoped-authority' });
    expect(launch.unsetEnvKeys).toEqual([]);
    expect(launch.connectedServices).toEqual({
      v: 2,
      bindingsByServiceId: {
        github: { source: 'connected', selection: 'profile', profileId: 'profile-1' },
      },
    });
    expect(launch.sanitizeDiagnosticText('scoped-authority failed')).toBe('[REDACTED] failed');
    await launch.cleanupOnExit?.();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('forwards one explicit Team model selection without consulting parent model state', async () => {
    const selection = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-explicit',
      teamId: 'team-explicit',
      expectedResourceRevision: 9,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'model-explicit',
      deliveryMode: 'brokered' as const,
    };
    const prepare = vi.fn(async () => ({
      providerBinding: {
        source: { kind: 'team_resource' as const, resourceId: selection.resourceId, resourceRevision: 9 },
        model: { id: selection.modelId, name: 'Explicit model' },
        upstream: { protocol: 'openai-responses' as const, normalizedUrl: 'http://127.0.0.1:43123/v1', credential: 'apiKey' as const },
        materialization: { v: 1 as const, kind: 'spawnEnv' as const },
      },
      environmentOverlay: [],
      additionalRedactionValues: [],
      cleanup: vi.fn(),
    }));

    await prepareExecutionRunProviderLaunch({
      teamCredentialModel: selection,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      agentId: 'codex',
      runId: 'run-explicit',
      featureEnabled: true,
      happyHomeDir: '/tmp/happier',
      prepareTeamCredentialProviderBinding: prepare,
    });

    expect(prepare).toHaveBeenCalledWith({
      runId: 'run-explicit',
      agentId: 'codex',
      selection,
    });
  });

  it('fails closed when an explicit Team selection has no live preparation owner', async () => {
    await expect(prepareExecutionRunProviderLaunch({
      teamCredentialModel: {
        kind: 'team_credential_provider_model',
        resourceId: 'resource-missing',
        teamId: 'team-missing',
        expectedResourceRevision: 1,
        agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
        modelId: 'model-missing',
        deliveryMode: 'brokered',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      agentId: 'codex',
      runId: 'run-missing',
      featureEnabled: true,
      happyHomeDir: '/tmp/happier',
    })).rejects.toMatchObject({
      code: 'team_credential_provider_selection_not_current',
    });
  });
});
