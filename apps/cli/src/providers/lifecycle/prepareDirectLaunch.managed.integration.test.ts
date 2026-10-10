import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { prepareDirectProviderLaunch } from './prepareDirectLaunch';
import { createManagedRunLaunchFixture } from './managedRunLaunch.testkit';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { projectProviderRuntimeBindingBasis } from '@/providers/spawn/runtimeBindingBasis';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import type { ProviderSpawnAuthorization } from '@/providers/spawn/resolve';
import { ProviderConnectionIdSchema, type PluginExecutionScopeV1 } from '@happier-dev/protocol';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

describe('managed execution-run Provider launch', () => {
  it('revalidates the applied remote binding through the owning hub observation rather than the worker catalog', async () => {
    const fixture = await createManagedRunLaunchFixture({ remote: true, probeCatalog: true });
    try {
      const selection = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'model-a' } };
      const projection = DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'success', agentTargetKey: fixture.agentTargetKey, groups: [{ connectionId: 'run-gateway', providerName: 'Gateway',
          connectionName: 'Gateway', connectionRole: 'default', connectionDisplayNameMode: 'automatic', connectionRevision: 1,
          sourceAuthority: { provider: { identity: { pluginId: 'acme.managed-run', localId: 'gateway' }, definitionRevision: 1 },
            connectionSecurityFingerprint: fixture.connectionSecurityFingerprint },
          authorization: { authorized: true }, modelLoadAction: 'descriptor_absent', manualModelPolicy: 'catalog-only',
          supportsFreeformModelIds: false, suppressedConnectedServiceIds: [], rows: [{ ref: selection.ref,
            descriptor: { id: 'model-a', name: 'Model A' }, application: { agentTargetKey: fixture.agentTargetKey,
              implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
            sources: { manual: false, static: false, probe: true }, confidence: 'probe', compatibility: {
              result: { status: 'verified', selectedProtocol: 'openai-responses', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-09' } },
              compatibilityFingerprint: 'compatibility:v1:fixture', confirmed: false }, endpointHealth: 'not_checked',
            catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
          }] }],
      });
      const readModelProjection = async () => projection;
      const purposeResolver = async (): Promise<never> => { throw new Error('No declared purpose'); };
      const admitted = await createRuntimeProviderSpawnAuthorizationAttempt({ selection, machineId: 'worker',
        agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId, lease: fixture.lease,
        getAccountSettingsSnapshot: () => fixture.snapshot, materializationBaseDir: fixture.happyHomeDir,
        resolveManagedPurposeBindingIntent: purposeResolver, readModelProjection });
      expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
      if (!admitted.ok) throw new Error(admitted.error.code);
      const dependencies = { machineId: 'worker', happyHomeDir: fixture.happyHomeDir,
        featureGate: { isEnabled: () => true }, registry: fixture.contributes, getAccountSettingsSnapshot: () => fixture.snapshot,
        acquireRuntimeLease: async () => fixture.lease, resolveManagedPurposeBindingIntent: purposeResolver,
        modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutation'); }, readModelProjection };
      const services = createRuntimeProviderModelManagementServices(dependencies);
      await expect(services.resolveBindingStatus({ machineId: 'worker', agentTargetKey: fixture.agentTargetKey,
        selection, launchBinding: admitted.attempt.authorization.sessionBindingMetadata })).resolves.toMatchObject({ status: 'current' });
      admitted.attempt.cleanupOnFailure();
    } finally { await fixture.cleanup(); }
  });
  it.each(['current', 'during_materialization', 'before_acquisition'] as const)('materializes one admitted Run endpoint and preserves source refusal (%s)', async state => {
    const revoked = state === 'during_materialization';
    let enteredMaterialization = () => {};
    let releaseMaterialization = () => {};
    const entered = new Promise<void>(resolve => { enteredMaterialization = resolve; });
    const materialization = createServer((_request, response) => {
      releaseMaterialization = () => response.end('ready');
      enteredMaterialization();
    });
    await new Promise<void>(resolve => materialization.listen(0, '127.0.0.1', resolve));
    const address = materialization.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback materialization transport');
    const fixture = await createManagedRunLaunchFixture({ physicalGateway: true,
      ...(revoked ? { materializationUrl: `http://127.0.0.1:${address.port}` } : {}) });
    let currentRun = state !== 'before_acquisition';
    let endpointRetired = false;
    let localSourceRefused = false;
    let authorizationFailure: string | null = null;
    let endpointFailure: string | null = null;
    try {
      const selection = { v: 1 as const, updatedAt: 1, ref: {
        agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example',
      } };
      const dependencies = {
        resolvePrerequisites: async () => ({ ok: true as const }),
        createAuthorizationAttempt: async () => {
          try { return await createRuntimeProviderSpawnAuthorizationAttempt({
          selection, machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId,
          lease: fixture.lease, getAccountSettingsSnapshot: () => fixture.snapshot,
          materializationBaseDir: fixture.happyHomeDir, scope: { kind: 'execution_run', executionRunId: 'run-1' },
          resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
          }); } catch (error) { authorizationFailure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
        },
        prepareManagedEndpoint: async ({ scope, authorization }: Readonly<{ scope: PluginExecutionScopeV1;
          authorization: Extract<ProviderSpawnAuthorization, { deployment: { kind: 'managedLocal' } }> }>) => {
          try {
          if (scope.kind !== 'execution_run') throw new Error('Expected exact Run');
          const basis = projectProviderRuntimeBindingBasis(authorization);
          if (basis.deployment.kind !== 'managedLocal') throw new Error('Expected managed source');
          const privateRequest = { v: 1, context: { token: 'a'.repeat(43), sessionId: 'parent-session' }, operation: {
            kind: 'provider_managed.binding.open', requestId: 'request', executionRunId: scope.executionRunId,
            executionRunOccurrenceId: 'run-occurrence', agentId: fixture.agentId, modelId: selection.ref.modelId,
            runtimeBindingBasis: basis, expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey,
          } };
          expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(privateRequest).success).toBe(true);
          expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse({ ...privateRequest,
            operation: { ...privateRequest.operation, teamId: 'unrelated-team' } }).success).toBe(false);
          const application = { agentTargetKey: basis.agentTargetKey, implementationIdentity: basis.deployment.implementationIdentity,
            endpointTemplateId: basis.endpoint.endpointTemplateId, protocol: basis.endpoint.protocol };
          const source = { kind: 'account_connection' as const, connectionId: basis.connectionId,
            expectedConnectionSecurityFingerprint: basis.credentialAuthorization.connectionSecurityFingerprint,
            expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
              implementationIdentity: basis.deployment.implementationIdentity, managedRuntime: basis.deployment.managedRuntime,
              purposeBindings: basis.deployment.purposeBindings }) };
          const signal = new AbortController().signal;
          const models = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
            happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
            acquireRuntimeLease: async () => {
              const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
              if (!lease) throw new Error('Expected canonical registry lease');
              return lease;
            }, resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
            modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutation'); } });
          const open = createAccountConnectionManagedConsumerSourceOpen({ homeId: 'home', accountId: 'account', machineId: fixture.machineId,
            expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey!, getAccountSettingsSnapshot: () => fixture.snapshot,
            custody: createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
              controller: fixture.gateway!.controller }), withRegistry: async read => {
                const contributes = fixture.lease.registry.contributes;
                if (!contributes.providersByContributionKey) throw new Error('Missing committed Provider projection');
                return await read({ ...contributes, providersByContributionKey: contributes.providersByContributionKey });
              },
            resolveBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
            // Exact Run currentness is an authenticated RPC boundary. The
            // host integration separately exercises its real controller.
            admitConsumer: async () => currentRun,
            projectModels: request => models.projectModelsForAccount(request, { getAccountSettingsSnapshot: () => fixture.snapshot,
              resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
              signal, isCurrent: () => currentRun }) });
          const opened = await open({ source, application, consumer: { kind: 'execution_run', executionRunId: scope.executionRunId },
            executionRunOccurrenceId: 'run-occurrence', consumerMachineId: fixture.machineId, signal });
          if (!opened) {
            localSourceRefused = true;
            throw createProviderErrorV1('provider_endpoint_unavailable', { connectionId: basis.connectionId });
          }
          const endpointUrl = opened.access.endpointUrl(application.endpointTemplateId);
          if (!endpointUrl) { await opened.retire(); throw new Error('Expected acquired endpoint projection'); }
          const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl,
            credentialTransport: basis.runtimeCredentialTransport,
            request: async request => await opened.revalidate(request.signal)
              ? { ok: true, response: await opened.access.request(request) } : { ok: false, reasonCode: 'resource_forbidden' } });
          return { normalizedUrl: consumer.endpointUrl, downstreamBearer: consumer.credential,
            revalidateBeforeCommit: async () => await opened.revalidate(signal)
              ? { ok: true as const } : { ok: false as const, error: createProviderErrorV1('provider_endpoint_unavailable', { connectionId: basis.connectionId }) },
            cleanup: async () => { await consumer.cleanup(); await opened.retire(); await opened.cleanup(); endpointRetired = true; } };
          } catch (error) { endpointFailure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
        },
      };
      const pending = prepareDirectProviderLaunch({ selection,
        backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
        machineId: fixture.machineId, agentId: fixture.agentId, scope: { kind: 'execution_run', executionRunId: 'run-1' },
        previousBinding: null, confirmation: null, connectedServices: null, featureEnabled: true,
      }, dependencies);
      if (revoked) {
        await Promise.race([entered, pending.then(result => { throw new Error(`Launch settled before materialization transport: ${JSON.stringify({ result, endpointFailure })}`); })]);
        currentRun = false;
        releaseMaterialization();
      }
      const result = await pending;
      expect(localSourceRefused).toBe(state === 'before_acquisition');
      if (state !== 'current') {
        expect(result).toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
        expect(endpointRetired).toBe(revoked);
        if (state === 'before_acquisition') {
          await expect(access(join(fixture.gateway!.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        return;
      }
      expect(result, JSON.stringify({ result,
        authorizationFailure,
        endpointFailure,
        activated: [...fixture.lease.registry.activatedPluginIds],
        diagnostics: fixture.lease.registry.pluginDiagnosticsByPluginId,
        agentRuntime: fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId),
      })).toMatchObject({ ok: true, kind: 'provider', environment: { RUN_PROVIDER_TOKEN: expect.any(String) } });
      expect(endpointRetired).toBe(false);
      if (!result.ok || result.kind !== 'provider') throw new Error('Expected admitted managed Run endpoint');
      expect(result.bindingMetadata.runtimeBindingBasis?.deployment.kind).toBe('managedLocal');
      await result.cleanupOnExit?.();
      await result.cleanupOnExit?.();
      expect(endpointRetired).toBe(true);
    } finally {
      releaseMaterialization();
      materialization.closeAllConnections();
      await new Promise<void>((resolve, reject) => materialization.close(error => error ? reject(error) : resolve()));
      await fixture.cleanup();
    }
  });
});
