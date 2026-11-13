import { expect, it } from 'vitest';
import { ProviderRuntimeBindingBasisV1Schema, SessionProviderBindingMetadataV1Schema, resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { RunnerDaemonManagedProviderBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createRemoteManagedProviderSessionProjection } from './remoteManagedProviderSession';

it('attests the current development Gateway source for a peer without acquiring local gateway custody', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'peer-gateway-source-' }, async ({ homeDir }) => {
    const identity = { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' };
    const fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: homeDir,
      runtimeOptions: { pluginIds: [identity.pluginId] } });
    try {
      const contribution = (fixture.registry.contributes.providers ?? []).find(entry =>
        entry.identity.pluginId === identity.pluginId && entry.identity.localId === identity.localId);
      if (!contribution?.definition.managedRuntime) throw new Error('Expected the real Gateway declaration');
      const runtime = await fixture.registry.acquireManagedProviderRuntime?.(identity);
      expect(runtime).not.toBeNull();
      if (!runtime) throw new Error('Expected the admitted Gateway source');
      expect(runtime.sourceCustody.kind).toBe('development');
      expect(runtime.isCurrent()).toBe(true);
      const basis = ProviderRuntimeBindingBasisV1Schema.parse({
        v: 1, agentTargetKey: 'agent:happier.agent.claude/claude', connectionId: 'pc_peer_fixture',
        contributionKey: `${identity.pluginId}/${identity.localId}`,
        deployment: { kind: 'managedLocal', gatewayPlacement: { kind: 'machine', machineId: 'hub' },
          implementationIdentity: identity,
          managedRuntime: resolveProviderManagedRuntimeDeclarationV1({ implementationIdentity: identity,
            managedRuntime: contribution.definition.managedRuntime }),
          purposeBindings: { v: 1, bindings: [{ purpose: { consumer: identity, purpose: 'openai-upstream' },
            target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'fixture-account' } } }] },
        },
        endpoint: { endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses', publicHeaders: {} },
        credentialAuthorization: { connectionSecurityFingerprint: 'fixture-security', grantFingerprint: 'fixture-grant' },
        runtimeCredentialTransport: null, prepared: { v: 1, materialization: 'spawnEnv' }, adapterVersion: 1,
        agentSupport: { acceptsProtocols: ['openai-responses'], required: { streaming: true },
          credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: false },
      });
      const metadata = SessionProviderBindingMetadataV1Schema.parse({ v: 1, connectionId: basis.connectionId,
        contributionKey: basis.contributionKey, connectionRevision: 1, protocol: basis.endpoint.protocol,
        materialization: basis.prepared.materialization, compatibilityFingerprint: 'fixture-compatibility',
        bindingSecurityFingerprint: 'fixture-binding', runtimeBindingBasis: basis,
        displaySnapshot: { providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
      });
      const input = {
        sessionId: 'peer-session', machineId: 'peer', basis, metadata, hardRevocationRevision: 0,
        registry: fixture.registry, signal: new AbortController().signal,
        isBootstrapCurrent: runtime.isCurrent,
        isCurrent: async scope =>
          runtime.isCurrent() && scope.occurrenceId === runtime.activationOccurrenceId
            && pluginSourceCustodyV1Equal(scope.sourceCustody, runtime.sourceCustody),
        // Admission revalidation is the caller's live-authority boundary; this fixture keeps it current.
        revalidateAdmission: async () => true,
        // Home/carrier transport must not be opened just to attest the source.
        openBroker: async (): Promise<never> => { throw new Error('Unexpected broker effect during preparation'); },
        installConsumerCleanup: () => {}, cleanup: async () => {}, readSupervisionLaunchAuthority: () => null,
        capturedAgentProviderBinding: null, isCapturedAgentRegistrationCurrent: () => true,
      } satisfies Parameters<typeof createRemoteManagedProviderSessionProjection>[0];
      const projection = await createRemoteManagedProviderSessionProjection(input);
      expect(RunnerDaemonManagedProviderBootstrapV1Schema.parse(projection.bootstrap)).toMatchObject({
        custody: 'daemonShared', requestAuth: null, scope: { sourceCustody: runtime.sourceCustody },
      });
      // One admission opens the broker and the next read decides again; a
      // withdrawn selection is refused and cleaned up at that next read.
      let selectionCurrent = true;
      let currentnessReads = 0;
      let cleanups = 0;
      const opened = await createRemoteManagedProviderSessionProjection({ ...input,
        isCurrent: async () => { currentnessReads += 1; return selectionCurrent; },
        openBroker: async () => ({ isCurrent: () => true, cleanup: async () => {},
          readHttpBinding: async () => ({ endpointUrl: 'http://127.0.0.1:1/gateway' }) }) as never,
        cleanup: async () => { cleanups += 1; },
      });
      await opened.readSharedGatewayAccess();
      expect(currentnessReads).toBe(2);
      await opened.readSharedGatewayAccess();
      await opened.readSharedGatewayAccess();
      selectionCurrent = false;
      await expect(opened.readSharedGatewayAccess())
        .rejects.toMatchObject({ code: 'plugin_services_managed_provider_authority_unavailable' });
      expect(cleanups).toBe(1);
      // A missing broker binding is a wiring defect even with current source.
      await expect(createRemoteManagedProviderSessionProjection({ ...input, openBroker: undefined }))
        .rejects.toMatchObject({ code: 'plugin_services_managed_provider_authority_unavailable' });
      await fixture.dispose();
      expect(await projection.isCurrent()).toBe(false);
      await expect(createRemoteManagedProviderSessionProjection(input))
        .rejects.toMatchObject({ code: 'plugin_services_managed_provider_authority_unavailable' });
    } finally { await fixture.dispose(); }
  });
});
