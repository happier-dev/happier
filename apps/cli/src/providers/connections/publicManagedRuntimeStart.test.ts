import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import type {
  ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import {
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import {
  createPluginReloadController,
  type PluginReloadController,
} from '@/plugins/runtime/reload/controller';
import type {
  ManagedProviderExplicitStartJoinInput,
  ManagedProviderExplicitStartJoinResult,
  ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { createPublicManagedProviderRuntimeStartOperation } from './publicManagedRuntimeStart';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { createManagedProviderExplicitStartCustody } from './publicManagedRuntimeStart';
import { createProviderConnectionService } from './service';
import { providerBrokerRetainedCurrentnessAffected, type ProviderBrokerRetainedCurrentnessInvalidation } from '@/providers/broker/brokerRetainedCurrentnessInvalidation';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { composeProviderSettingsV1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { logger } from '@/ui/logger';

it('retains the runtime startup cause in the explicit-start refusal log through the real registry', async () => {
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
  onTestFinished(() => diagnostic.mockRestore());
  await withConfiguredDaemonTestHome({ prefix: 'managed-start-cause-' }, async ({ homeDir }) => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir, controller });
    try {
      const start = createPublicManagedProviderRuntimeStartOperation({ machineId: fixture.machineId, happyHomeDir: homeDir, controller });
      await expect(start({ contributionKey: 'acme.managed-run/gateway',
        identity: { pluginId: 'acme.managed-run', localId: 'gateway' },
        request: { reason: 'explicitStartLocal', endpointTemplateIds: ['responses'] },
        purposeBindings: { v: 1, bindings: [] }, isAuthorizationCurrent: () => true,
        revalidateAuthorization: async () => true,
      })).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      expect(diagnostic).toHaveBeenCalledWith('[Provider] Managed runtime start refused', {
        startFailureCode: 'managed_provider_start_failed',
        startupFailure: { phase: 'runtime_start', errorClass: 'Error' },
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Worker must not start');
    } finally { await fixture.cleanup(); }
  });
});

it.each(['cold', 'activated'] as const)('acquires connected-account broker custody from a %s runtime without inventing a Provider Connection gateway', async (activation) => {
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
  onTestFinished(() => diagnostic.mockRestore());
  await withConfiguredDaemonTestHome({ prefix: 'broker-operation-consumer-' }, async ({ homeDir }) => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller, physicalGateway: true });
    const gateway = fixture.gateway!;
    const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: homeDir, controller });
    const request = (sessionId: string) => ({
      identity: gateway.identity,
      contributionKey: `${gateway.identity.pluginId}/${gateway.identity.localId}`,
      request: { reason: 'explicitStartLocal' as const, endpointTemplateIds: ['api'] },
      purposeBindings: gateway.purposeBindings,
      operationClaim: { kind: 'providerBroker' as const, operation: { kind: 'session' as const, sessionId } },
      signal: new AbortController().signal,
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
    });
    try {
      if (activation === 'activated') {
        expect(await fixture.lease.registry.acquireManagedProviderRuntime?.(gateway.identity)).not.toBeNull();
      }
      const first = await custody.acquire(request('team-session-one'));
      expect(first, JSON.stringify(diagnostic.mock.calls)).not.toBeNull();
      if (!first) throw new Error('Expected operation-scoped connected-account custody');
      expect(first.access.endpointUrl('api')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const firstPid = Number(await readFile(join(gateway.directory, 'gateway-started'), 'utf8'));
      const second = await custody.acquire(request('team-session-two'));
      expect(second).not.toBeNull();
      if (!second) throw new Error('Expected independent broker operation custody');
      const secondPid = Number(await readFile(join(gateway.directory, 'gateway-started'), 'utf8'));
      expect(secondPid).not.toBe(firstPid);
      expect(await custody.retire(request('team-session-one'))).toBe(true);
      expect(await waitForProcessExit(firstPid)).toBe(true);
      expect(first.access.endpointUrl('api')).toBeNull();
      const response = await second.access.request({ pathAndQuery: '/v1/models', method: 'GET' });
      expect(response.status).toBe(200);
      await response.body?.cancel();
      expect(process.kill(secondPid, 0)).toBe(true);
      expect(await custody.acquire({ ...request('team-session-two'), revalidateRetainedCurrentness: async () => false })).toBeNull();
      expect(await waitForProcessExit(secondPid)).toBe(true);
      expect(diagnostic).toHaveBeenCalledWith(expect.any(String), {
        reasonCode: 'resource_unavailable', providerCode: 'provider_authorization_changed',
      });
    } finally { await fixture.cleanup(); }
  });
});

it('revalidates only the exact broker claim and Home consumer before retiring its process', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'broker-exact-currentness-' }, async ({ homeDir }) => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller, physicalGateway: true });
    const gateway = fixture.gateway!;
    const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: homeDir, controller });
    const currentConsumers = new Set(['ended', 'unrelated-stale', 'unrelated-live']);
    const homeReads = new Map<string, number>();
    const request = (sessionId: string) => ({
      identity: gateway.identity,
      contributionKey: `${gateway.identity.pluginId}/${gateway.identity.localId}`,
      request: { reason: 'explicitStartLocal' as const, endpointTemplateIds: ['api'] },
      purposeBindings: gateway.purposeBindings,
      operationClaim: { kind: 'providerBroker' as const, operation: { kind: 'session' as const, sessionId } },
      signal: new AbortController().signal,
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      // Home's consumer-binding read is the external currentness boundary.
      revalidateRetainedCurrentness: async (_signal?: AbortSignal, invalidation?: ProviderBrokerRetainedCurrentnessInvalidation) => {
        if (invalidation && !providerBrokerRetainedCurrentnessAffected(invalidation, { facts: ['teams'] })) return true;
        homeReads.set(sessionId, (homeReads.get(sessionId) ?? 0) + 1);
        return currentConsumers.has(sessionId);
      },
    });
    try {
      const claims = new Map<string, { projection: NonNullable<Awaited<ReturnType<typeof custody.acquire>>>; pid: number }>();
      for (const sessionId of currentConsumers) {
        const projection = await custody.acquire(request(sessionId));
        if (!projection) throw new Error('Expected retained operation custody');
        claims.set(sessionId, { projection, pid: Number(await readFile(join(gateway.directory, 'gateway-started'), 'utf8')) });
      }
      currentConsumers.delete('ended');
      currentConsumers.delete('unrelated-stale');
      homeReads.clear();
      expect(await custody.revalidateRetainedClaims(undefined, undefined, { facts: ['saved-secrets'] })).toBe(0);
      expect(homeReads.size).toBe(0);
      for (const claim of claims.values()) expect(process.kill(claim.pid, 0)).toBe(true);
      expect(await custody.revalidateRetainedClaims(undefined, request('ended'))).toBe(1);
      expect(homeReads).toEqual(new Map([['ended', 1]]));
      expect(await waitForProcessExit(claims.get('ended')!.pid)).toBe(true);
      expect(claims.get('ended')!.projection.isCurrent()).toBe(false);
      for (const sessionId of ['unrelated-stale', 'unrelated-live']) {
        const claim = claims.get(sessionId)!;
        expect(claim.projection.isCurrent()).toBe(true);
        expect(process.kill(claim.pid, 0)).toBe(true);
      }
      expect(await custody.revalidateRetainedClaims(undefined, request('missing'))).toBe(0);
      expect(homeReads).toEqual(new Map([['ended', 1]]));
      expect(await custody.revalidateRetainedClaims(undefined, undefined, { facts: ['all'] })).toBe(1);
      expect(homeReads).toEqual(new Map([['ended', 1], ['unrelated-stale', 1], ['unrelated-live', 1]]));
      expect(await waitForProcessExit(claims.get('unrelated-stale')!.pid)).toBe(true);
      expect(process.kill(claims.get('unrelated-live')!.pid, 0)).toBe(true);
    } finally { await fixture.cleanup(); }
  });
});

it('records only closed broker and Provider reasons when source custody acquisition is refused', async ({ onTestFinished }) => {
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
  onTestFinished(() => diagnostic.mockRestore());
  await withConfiguredDaemonTestHome({ prefix: 'broker-acquisition-diagnostic-' }, async ({ homeDir }) => {
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller: createPluginReloadController(), physicalGateway: true });
    const gateway = fixture.gateway!;
    const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: homeDir,
      controller: gateway.controller });
    try {
      expect(await custody.acquire({ identity: gateway.identity,
        contributionKey: `${gateway.identity.pluginId}/${gateway.identity.localId}`,
        request: { reason: 'explicitStartLocal', endpointTemplateIds: ['api'] }, purposeBindings: gateway.purposeBindings,
        operationClaim: { kind: 'providerBroker', operation: { kind: 'session', sessionId: 'private-session-do-not-log' } },
        signal: new AbortController().signal, isAuthorizationCurrent: () => true,
        revalidateAuthorization: async () => { throw new Error('private-upstream-body-and-secret'); },
      })).toBeNull();
      expect(diagnostic).toHaveBeenCalledWith(expect.any(String), {
        reasonCode: 'resource_unavailable', providerCode: 'provider_connection_invalid',
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-');
      await expect(readFile(join(gateway.directory, 'gateway-started'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fixture.cleanup(); }
  });
});

it.each([2, 3])('preserves a transient Home failure at explicit Start purpose read %s and recovers the same connection', async failedRead => {
  await withConfiguredDaemonTestHome({ prefix: 'gateway-start-home-outage-' }, async ({ homeDir }) => {
    let reads = 0;
    let unavailable = true;
    let changePurpose = () => {};
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller: createPluginReloadController(), physicalGateway: true,
      resolveAccountTarget: async target => {
        reads += 1;
        if (unavailable && reads === failedRead) throw new PluginError({
          code: 'project_requester_home_unavailable', retryable: true, message: 'Requester Home unavailable',
        });
        changePurpose();
        return target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null;
      },
    });
    const gateway = fixture.gateway!;
    let settings = fixture.providerSettings;
    const unavailableOperation = async (): Promise<never> => { throw new Error('Unexpected configuration mutation or inspection'); };
    const service = createProviderConnectionService({ machineId: fixture.machineId, featureGate: { isEnabled: () => true },
      loadSnapshot: async () => ({ accountSettings: fixture.snapshot.settings, rawAccountSettings: {}, providerSettings: settings, registry: fixture.contributes }),
      updateProviderSettings: unavailableOperation, collectDnsEvidence: unavailableOperation, runtimeSummary: unavailableOperation, now: () => 1,
      resolveConnection: input => resolveProviderConnectionForMachine({ ...input, dnsEvidenceByEndpointUrl: input.dnsEvidence }),
      resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
      startManagedProviderRuntime: createPublicManagedProviderRuntimeStartOperation({ machineId: fixture.machineId, happyHomeDir: homeDir,
        controller: gateway.controller, resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
          readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) }) }),
    });
    const start = () => service.startLocal({ action: 'startLocal', machineId: fixture.machineId,
      contributionKey: `${gateway.identity.pluginId}/${gateway.identity.localId}`, connectionId: fixture.record.connectionId });
    try {
      expect(await start()).toMatchObject({ status: 'error', error: {
        code: 'provider_catalog_unavailable', retryable: true, action: 'retry',
      } });
      expect(reads).toBe(failedRead);
      await expect(readFile(join(gateway.directory, 'gateway-started'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      unavailable = false;
      expect(await start()).toMatchObject({ status: 'success', phase: 'running' });
      changePurpose = () => {
        changePurpose = () => {};
        settings = ProviderSettingsV1Schema.parse({ ...settings, connections: settings.connections.map(connection => ({
          ...connection, purposeBindingDefaults: { upstream: { kind: 'account', account: {
            service: { pluginId: gateway.pluginId, localId: 'accounts' }, accountId: 'other-account',
          } } },
        })) });
      };
      expect(await start()).toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    } finally { await fixture.cleanup(); }
  });
});

it('G1 releases only the deleted connection explicit Start claim through retained custody', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'gateway-delete-retention-' }, async ({ homeDir }) => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller, physicalGateway: true });
    const gateway = fixture.gateway!;
    const connectionId = fixture.record.connectionId;
    const otherConnectionId = 'independent-gateway';
    let providerSettings = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings,
      connections: [...fixture.providerSettings.connections, { ...fixture.providerSettings.connections[0],
        id: otherConnectionId, role: 'named', displayNameMode: 'custom', displayName: 'Independent Gateway' }] });
    let catalogRevision = 1;
    let catalogAvailable = true;
    // The Account catalog's persistent read/write boundary is in memory; its
    // Action semantics, service, executable registry and process custody are real.
    const accountExecute = createAccountProviderActionExecuteV1({ assertCurrent() {},
      readCatalog: async () => ({ status: 'ready', revision: catalogRevision, catalog: splitProviderSettingsV1(providerSettings).catalog }),
      writeCatalog: async value => {
        expect(value.expectedRevision).toBe(catalogRevision);
        providerSettings = composeProviderSettingsV1(value.catalog, splitProviderSettingsV1(providerSettings).defaults);
        catalogRevision += 1;
        return { status: 'updated' };
      },
      readDefinitions: async () => [...fixture.contributes.providersByContributionKey].map(([contributionKey, contribution]) => ({
        contributionKey, definition: contribution.definition, provenance: contribution.provenance })), now: () => 2 });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected machine operation'); };
    const service = createProviderConnectionService({ machineId: fixture.machineId, featureGate: { isEnabled: () => true },
      accountProviderActionExecute: request => accountExecute(request, { surface: 'cli' }),
      loadSnapshot: async () => {
        if (!catalogAvailable) throw new Error('Account catalog temporarily unavailable');
        return { accountSettings: fixture.snapshot.settings, rawAccountSettings: {}, providerSettings, registry: fixture.contributes };
      }, updateProviderSettings: unavailable, collectDnsEvidence: unavailable, runtimeSummary: unavailable, now: () => 2,
      resolveConnection: input => resolveProviderConnectionForMachine({ ...input, dnsEvidenceByEndpointUrl: input.dnsEvidence }),
      resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
      startManagedProviderRuntime: createPublicManagedProviderRuntimeStartOperation({ machineId: fixture.machineId, happyHomeDir: homeDir,
        controller, resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
          readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) }) }),
    });
    const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: homeDir, controller });
    const start = (id: string) => service.startLocal({ action: 'startLocal', machineId: fixture.machineId,
      contributionKey: `${gateway.identity.pluginId}/${gateway.identity.localId}`, connectionId: id });
    try {
      expect(await start(connectionId)).toMatchObject({ status: 'success', phase: 'running' });
      const deletedPid = Number(await readFile(join(gateway.directory, 'gateway-started'), 'utf8'));
      expect(await start(otherConnectionId)).toMatchObject({ status: 'success', phase: 'running' });
      const retainedPid = Number(await readFile(join(gateway.directory, 'gateway-started'), 'utf8'));
      expect(retainedPid).not.toBe(deletedPid);
      catalogAvailable = false;
      expect(await custody.revalidateRetainedClaims()).toBe(0);
      expect(process.kill(deletedPid, 0)).toBe(true);
      catalogAvailable = true;
      expect(await service.delete({ action: 'delete', machineId: fixture.machineId, connectionId })).toEqual({ status: 'success', connectionId });
      expect(providerSettings.connections.map(connection => connection.id)).toEqual([otherConnectionId]);
      expect(await custody.revalidateRetainedClaims()).toBe(1);
      expect(await waitForProcessExit(deletedPid)).toBe(true);
      expect(process.kill(retainedPid, 0)).toBe(true);
      expect(await custody.revalidateRetainedClaims()).toBe(0);
    } finally { await fixture.cleanup(); }
  });
});

it.each(['Start', 'next-request', 'new-stream'] as const)('G1 recovers retained consumers through %s custody without changing native access or replaying input', async recovery => {
  await withConfiguredDaemonTestHome({ prefix: 'gateway-outage-recovery-' }, async ({ homeDir }) => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller, physicalGateway: true, holdResponseForInput: 'interrupted input' });
    const gateway = fixture.gateway!;
    const identity = gateway.identity;
    const contributionKey = `${identity.pluginId}/${identity.localId}`;
    const declaration = fixture.contributes.providersByContributionKey.get(contributionKey)!.definition;
    const managedRuntime = declaration.managedRuntime!;
    const purposeBindings = gateway.purposeBindings;
    let admitted = true;
    const signal = new AbortController().signal;
    const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: homeDir, controller });
    const models = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId, happyHomeDir: homeDir,
      featureGate: { isEnabled: () => true }, registry: fixture.contributes, getAccountSettingsSnapshot: () => fixture.snapshot,
      acquireRuntimeLease: async () => {
        const lease = controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected serving fixture registry');
        return lease;
      }, resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutation'); },
    });
    const application = { agentTargetKey: fixture.agentTargetKey, implementationIdentity: identity,
      endpointTemplateId: 'api', protocol: 'openai-responses' as const };
    const source = { kind: 'account_connection' as const, connectionId: fixture.record.connectionId,
      expectedConnectionSecurityFingerprint: fixture.record.connectionSecurityFingerprint,
      expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({ implementationIdentity: identity,
        managedRuntime, purposeBindings }) };
    const open = createAccountConnectionManagedConsumerSourceOpen({ homeId: 'home', accountId: 'account', machineId: fixture.machineId,
      custody, expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey!, getAccountSettingsSnapshot: () => fixture.snapshot,
      withRegistry: async read => await read(fixture.contributes), resolveBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
      // Authenticated Home Session liveness is the system boundary.
      admitConsumer: async () => admitted,
      projectModels: request => models.projectModelsForAccount(request, { getAccountSettingsSnapshot: () => fixture.snapshot,
        resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent, signal, isCurrent: () => admitted }),
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected configuration mutation or runtime inspection'); };
    const service = createProviderConnectionService({ machineId: fixture.machineId, featureGate: { isEnabled: () => true },
      loadSnapshot: async () => ({ accountSettings: fixture.snapshot.settings, rawAccountSettings: {},
        providerSettings: fixture.providerSettings, registry: fixture.contributes }),
      updateProviderSettings: unavailable, collectDnsEvidence: unavailable, runtimeSummary: unavailable, now: () => 1,
      resolveConnection: input => resolveProviderConnectionForMachine({ ...input, dnsEvidenceByEndpointUrl: input.dnsEvidence }),
      resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
      startManagedProviderRuntime: createPublicManagedProviderRuntimeStartOperation({ machineId: fixture.machineId, happyHomeDir: homeDir,
        controller, resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
          readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) }) }),
    });
    const consumers: { cleanup(): Promise<void> }[] = [];
    const opened: NonNullable<Awaited<ReturnType<typeof open>>>[] = [];
    try {
      const attach = async (sessionId: string, sourceSignal = signal) => {
        const request = { source, application, consumer: { kind: 'session' as const, sessionId }, consumerMachineId: fixture.machineId };
        let access = await open({ ...request, signal: sourceSignal });
        if (!access) throw new Error('Expected admitted gateway consumer');
        opened.push(access);
        const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl: access.access.endpointUrl('api')!,
          credentialTransport: declaration.credential!.transports[0]!, request: async request => access && await access.revalidate(request.signal)
            ? { ok: true, response: await access.access.request(request) } : { ok: false, reasonCode: 'resource_forbidden' } });
        consumers.push(consumer);
        return { ...consumer, source: access, async reopen() {
          access = await open({ ...request, signal });
          if (!access) throw new Error('Expected fresh admitted stream source');
          opened.push(access);
        } };
      };
      const firstStream = new AbortController();
      const [first, survivor] = await Promise.all([attach('session-one'), attach('session-two',
        recovery === 'new-stream' ? firstStream.signal : signal)]);
      const read = async (text: string) => {
        const response = await fetch(`${survivor.endpointUrl}/responses`, { method: 'POST',
          headers: { authorization: survivor.renderedCredential, 'content-type': 'application/json' }, body: JSON.stringify({ input: text }) });
        return { status: response.status, body: await response.text() };
      };
      const processFile = join(gateway.directory, 'gateway-started');
      const originalPid = Number(await readFile(processFile, 'utf8'));
      expect((await read('first input')).status).toBe(200);
      if (recovery === 'new-stream') {
        await survivor.source.cleanup();
        firstStream.abort();
        await survivor.reopen();
      }
      const startLocal = () => service.startLocal({ action: 'startLocal' as const, machineId: fixture.machineId, contributionKey,
        connectionId: fixture.record.connectionId });
      if (recovery === 'Start') expect(await startLocal()).toMatchObject({ status: 'success', phase: 'running' });
      await first.cleanup(); await first.source.retire();
      const interrupted = read('interrupted input');
      await vi.waitFor(async () => expect(await readFile(join(gateway.directory, 'gateway-inputs'), 'utf8')).toContain('interrupted input\n'));
      process.kill(originalPid, 'SIGTERM');
      expect(await waitForProcessExit(originalPid)).toBe(true);
      const interruptedResponse = await interrupted;
      expect(interruptedResponse.status).toBe(403);
      expect(JSON.parse(interruptedResponse.body)).toMatchObject({
        error: { type: 'permission_error', code: 'broker_unavailable' },
      });
      await vi.waitFor(() => expect(survivor.source.access.endpointUrl('api')).toBeNull());
      if (recovery === 'new-stream') {
        // The carrier closes only this stream's join, then supplies a fresh
        // source opening for the same retained operation on its next stream.
        await survivor.reopen();
      }
      // The real repair Action reaches this exact service owner. Its public
      // claim must not replace the Session or the runner's local URL/token.
      if (recovery === 'Start') expect(await startLocal()).toMatchObject({ status: 'success', phase: 'running' });
      const recovered = await Promise.all([read('fresh input one'), read('fresh input two')]);
      expect(recovered).toEqual([{ status: 200, body: 'ok' }, { status: 200, body: 'ok' }]);
      const replacementPid = Number(await readFile(processFile, 'utf8'));
      expect(replacementPid).not.toBe(originalPid);
      expect(await readFile(processFile, 'utf8')).toBe(String(replacementPid));
      expect((await readFile(join(gateway.directory, 'gateway-starts'), 'utf8')).trim().split('\n')).toEqual([
        String(originalPid), String(replacementPid),
      ]);
      expect((await readFile(join(gateway.directory, 'gateway-inputs'), 'utf8')).trim().split('\n').sort()).toEqual([
        'first input', 'fresh input one', 'fresh input two', 'interrupted input',
      ]);
      admitted = false;
      expect((await read('withdrawn input')).status).toBe(403);
      expect(await readFile(processFile, 'utf8')).toBe(String(replacementPid));
    } finally {
      await Promise.all(consumers.map(consumer => consumer.cleanup()));
      await Promise.all(opened.map(access => access.retire()));
      await fixture.cleanup();
    }
  });
});

function managedServiceHandle(dispose: () => Promise<void>): ManagedServiceHandle {
  const snapshot = Object.freeze({
    id: 'managed-provider',
    state: 'healthy' as const,
    mode: 'spawn' as const,
    baseUrl: 'http://127.0.0.1:45123',
    startedAtMs: 10,
    lastHealthyAtMs: 11,
    diagnostics: Object.freeze([]),
    diagnosticsTruncated: false,
  });
  return Object.freeze({
    snapshot: () => snapshot,
    observe(listener: Parameters<ManagedServiceHandle['observe']>[0]) {
      listener(snapshot);
      return Object.freeze({ dispose() {} });
    },
    async waitUntilHealthy() { return snapshot; },
    async request() { throw new Error('Unexpected managed service request'); },
    async stop() { return Object.freeze({ status: 'stopped' as const }); },
    dispose,
  });
}

function connectedAccounts(): ConnectedAccountsService {
  return Object.freeze({
    async getBinding() { return null; },
    async requestSelection() { throw new Error('selection unavailable'); },
    async materialize() { throw new Error('materialization unavailable'); },
    listAccounts: async () => {
        throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
        throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch() { return Object.freeze({ dispose() {} }); },
  });
}

function managedServices(): ManagedServices {
  const unavailable = async (): Promise<never> => {
    throw new Error('not used by the fixture runtime');
  };
  return Object.freeze({
    dependencies: Object.freeze({
      status: unavailable,
      ensure: unavailable,
      update: unavailable,
      remove: unavailable,
    }),
    supervise: unavailable,
  });
}

async function runtimeRegistry(input: Readonly<{
  pluginId: string;
  localId: string;
  runtime: ManagedProviderRuntime;
  invocationCleanup: () => void;
  projectEndpointAccess: ReturnType<typeof vi.fn>;
  acquireRuntime: ReturnType<typeof vi.fn>;
  createInvocationServices: ReturnType<typeof vi.fn>;
  addRuntimeDisposable: ReturnType<typeof vi.fn>;
  settleRetiredBackgroundServices: ReturnType<typeof vi.fn>;
  disposeRegistry: ReturnType<typeof vi.fn>;
  runManagedProviderExplicitStart?: (
    operation: ManagedProviderExplicitStartJoinInput,
  ) => Promise<ManagedProviderExplicitStartJoinResult>;
}>): Promise<ResolvedExecutablePluginRuntimeRegistry> {
  const base = await resolveExecutablePluginRuntimeRegistry({ pluginIds: [], contributes: createResolvedContributionRegistry({}) });
  onTestFinished(() => base.dispose());
  return {
    ...base,
    declarationContributes: createResolvedContributionRegistry({}),
    claimReleaseLessDeclarations: async () => undefined,
    projectManagedServices: createManagedServicesOwner({
      processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
      dependencies: createUnavailablePluginServices().managedServices.dependencies,
      resolveScope: () => null,
    }),
    contributes: {
      backupDestinations: [],
      agents: Object.freeze([]),
      voiceProviders: Object.freeze([]),
      connectedAccountDescriptorsById: new Map(),
      providersByContributionKey: new Map(),
      actions: Object.freeze([]),
      resources: Object.freeze([]),
      uiViewsV2: Object.freeze([]),
      uiRenderersV2: Object.freeze([]),
      uiTranslationsV2: Object.freeze([]),
      activationTargets: Object.freeze([]),
      catalogEntriesById: Object.freeze({}),
      agentDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: Object.freeze({}),
    },
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set([input.pluginId]),
    activateContributionsOnDemand: async () => [],
    acquireManagedProviderRuntime: input.acquireRuntime,
    createManagedProviderRuntimeInvocationServices: input.createInvocationServices,
    ...(input.runManagedProviderExplicitStart
      ? { runManagedProviderExplicitStart: input.runManagedProviderExplicitStart }
      : {}),
    resolveCaptureSource: unexpectedCaptureSourceResolution,
    resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
    resolvePromptAssetBlocks: async () => [],
    addRuntimeDisposable: input.addRuntimeDisposable,
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    retirePluginConsumers: async () => undefined,
    settleRetiredBackgroundServices: input.settleRetiredBackgroundServices,
    retireConsumers: () => {},
    dispose: input.disposeRegistry,
  };
}

async function establishManagedProviderExplicitStart(
  operation: ManagedProviderExplicitStartJoinInput,
): Promise<ManagedProviderExplicitStartJoinResult> {
  const controller = new AbortController();
  return Object.freeze({
    status: 'established' as const,
    value: await operation.establish(Object.freeze({
      signal: controller.signal,
      async release() {
        controller.abort('managed Provider explicit-start retired');
      },
    })),
  });
}

describe('public managed Provider explicit-start production operation', () => {
  it.each([
    ['bundled', 'happier.provider.ollama'],
    ['external', 'acme.provider.external'],
    ['development', 'acme.provider.development'],
  ] as const)('uses the same public runtime and SVC09 path for %s plugins', async (_provenance, pluginId) => {
    const localId = 'managed';
    const purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: {
          consumer: { pluginId, localId },
          purpose: 'upstream',
        },
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            accountId: 'work',
          },
        },
      }],
    };
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async (request) => {
      expect(request).toEqual({
        reason: 'explicitStartLocal',
        endpointTemplateIds: ['chat'],
      });
      return Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'chat',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      });
    });
    const runtime = Object.freeze({ start });
    const acquiredRuntime = Object.freeze({
      runtime,
      activationOccurrenceId: 'activation-7',
      sourceCustody: createManagedPluginSourceCustody('immutable-7'),
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn();
    const projectionCleanup = vi.fn();
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const accounts = connectedAccounts();
    const services = managedServices();
    let operationSignal: AbortSignal | undefined;
    const createInvocationServices = vi.fn(async (input: Readonly<{ signal: AbortSignal }>) => {
      operationSignal = input.signal;
      return Object.freeze({
        connectedAccounts: accounts,
        managedServices: services,
        projectEndpointAccess,
        cleanup: invocationCleanup,
      });
    });
    const runtimeDisposables: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      return disposable;
    });
    const disposeRegistry = vi.fn(async () => {
      for (const disposable of runtimeDisposables.splice(0).reverse()) {
        await disposable.dispose();
      }
    });
    const settleRetiredBackgroundServices = vi.fn(async () => {
      for (const disposable of runtimeDisposables.splice(0).reverse()) {
        await disposable.dispose();
      }
    });
    const registry = await runtimeRegistry({
      pluginId,
      localId,
      runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices,
      disposeRegistry,
    });
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings,
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async (signal) => operationSignal === undefined
        || (signal === operationSignal && !signal.aborted),
    })).resolves.toEqual({ status: 'running' });

    expect(start).toHaveBeenCalledOnce();
    expect(acquireRuntime).toHaveBeenCalledTimes(2);
    expect(createInvocationServices).toHaveBeenCalledWith(expect.objectContaining({
      identity: { pluginId, localId },
      purposeBindings,
      operationClaim: {
        kind: 'explicitStart',
        machineId: 'machine-a',
      },
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));
    expect(projectEndpointAccess).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledWith(
      pluginId,
      expect.objectContaining({ dispose: expect.any(Function) }),
    );
    expect(serviceDispose).not.toHaveBeenCalled();
    expect(invocationCleanup).not.toHaveBeenCalled();

    const replacementDispose = vi.fn(async () => undefined);
    const replacementRegistry: ResolvedExecutablePluginRuntimeRegistry = {
      ...registry,
      contributes: registry.contributes,
      dispose: replacementDispose,
    };
    await controller.adoptPreparedRuntimeRegistry({
      registry: replacementRegistry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 2,
      runningSessionDisposition: 'retainRunningSessions',
    });

    expect(settleRetiredBackgroundServices).toHaveBeenCalledWith([pluginId]);
    expect(projectionCleanup).toHaveBeenCalledOnce();
    expect(serviceDispose).toHaveBeenCalledOnce();
    expect(invocationCleanup).toHaveBeenCalledOnce();

    await controller.shutdown({ timeoutMs: 0 });
    expect(replacementDispose).toHaveBeenCalledOnce();
  });

  it('joins exact pending and settled explicit starts before invocation authority is created', async () => {
    const pluginId = 'acme.provider.exact-start';
    const localId = 'managed';
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async () => {
      await startGate;
      return Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'chat',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      });
    });
    const acquiredRuntime = Object.freeze({
      runtime: Object.freeze({ start }),
      activationOccurrenceId: 'activation-7',
      sourceCustody: createManagedPluginSourceCustody('immutable-7'),
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn(async () => undefined);
    const projectionCleanup = vi.fn(async () => undefined);
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const createInvocationServices = vi.fn(async () => Object.freeze({
      connectedAccounts: connectedAccounts(),
      managedServices: managedServices(),
      projectEndpointAccess,
      cleanup: invocationCleanup,
    }));
    const pendingByOperation = new Map<string, Promise<
      Awaited<ReturnType<ManagedProviderExplicitStartJoinInput['establish']>>
    >>();
    const runManagedProviderExplicitStart = vi.fn(async (
      operation: ManagedProviderExplicitStartJoinInput,
    ): Promise<ManagedProviderExplicitStartJoinResult> => {
      if (!operation.isCurrent()) {
        return Object.freeze({ status: 'not_current' as const });
      }
      const key = JSON.stringify([
        operation.machineId,
        operation.identity.pluginId,
        operation.identity.localId,
        operation.purposeBindings,
      ]);
      let pending = pendingByOperation.get(key);
      if (!pending) {
        const controller = new AbortController();
        pending = operation.establish(Object.freeze({
          signal: controller.signal,
          async release() {
            controller.abort('managed Provider explicit-start retired');
          },
        }));
        pendingByOperation.set(key, pending);
      }
      try {
        return Object.freeze({
          status: 'established' as const,
          value: await pending,
        });
      } catch (error) {
        pendingByOperation.delete(key);
        throw error;
      }
    });
    const runtimeDisposables: Array<Readonly<{
      dispose(): void | Promise<void>;
    }>> = [];
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      return disposable;
    });
    const registry = await runtimeRegistry({
      pluginId,
      localId,
      runtime: acquiredRuntime.runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices: vi.fn(async () => undefined),
      disposeRegistry: vi.fn(async () => undefined),
    });
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });
    const purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [],
    };
    const request = () => Object.freeze({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings,
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
    });

    const first = startExplicit(request());
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const concurrentRetry = startExplicit(request());
    releaseStart();

    await expect(Promise.all([first, concurrentRetry])).resolves.toEqual([
      { status: 'running' },
      { status: 'running' },
    ]);
    await expect(startExplicit(request())).resolves.toEqual({ status: 'running' });

    expect(runManagedProviderExplicitStart).toHaveBeenCalledTimes(3);
    expect(createInvocationServices).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledOnce();

    await Promise.all(runtimeDisposables.map(async (disposable) => {
      await disposable.dispose();
    }));
    await controller.shutdown({ timeoutMs: 0 });
  });

  it('settles a registered live effect even when the operation lease release rejects', async () => {
    const pluginId = 'acme.provider.release-failure';
    const localId = 'managed';
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async () => Object.freeze({
      service,
      endpoints: Object.freeze([Object.freeze({
        endpointTemplateId: 'chat',
        endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
      })]),
    }));
    const acquiredRuntime = Object.freeze({
      runtime: Object.freeze({ start }),
      activationOccurrenceId: 'activation-7',
      sourceCustody: createManagedPluginSourceCustody('immutable-7'),
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn();
    const projectionCleanup = vi.fn();
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const createInvocationServices = vi.fn(async () => Object.freeze({
      connectedAccounts: connectedAccounts(),
      managedServices: managedServices(),
      projectEndpointAccess,
      cleanup: invocationCleanup,
    }));
    const runtimeDisposables: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      return disposable;
    });
    const registry = await runtimeRegistry({
      pluginId,
      localId,
      runtime: acquiredRuntime.runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices: vi.fn(async () => undefined),
      disposeRegistry: vi.fn(async () => undefined),
    });
    const release = vi.fn(async () => {
      throw new Error('lease release acknowledgement failed');
    });
    const baseController = createPluginReloadController();
    const controller: PluginReloadController = Object.freeze({
      ...baseController,
      tryAcquireRuntimeRegistry: () => Object.freeze({
        registry,
        source: 'active' as const,
        durableRevision: registry.durableRevision ?? -1,
        release,
      }),
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings: { v: 1, bindings: [] },
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
    })).resolves.toEqual({ status: 'running' });

    expect(release).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledOnce();
    expect(serviceDispose).not.toHaveBeenCalled();

    await runtimeDisposables[0]!.dispose();
    expect(projectionCleanup).toHaveBeenCalledOnce();
    expect(serviceDispose).toHaveBeenCalledOnce();
    expect(invocationCleanup).toHaveBeenCalledOnce();
    await baseController.shutdown({ timeoutMs: 0 });
  });

  it('uses the admitted registry lease instead of reacquiring a replacement generation', async () => {
    const pluginId = 'acme.provider.generation-atomic';
    const localId = 'managed';
    const createGeneration = async (generation: string) => {
      const serviceDispose = vi.fn(async () => undefined);
      const service = managedServiceHandle(serviceDispose);
      const start = vi.fn<ManagedProviderRuntime['start']>(async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'chat',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }));
      const runtime = Object.freeze({ start });
      const acquiredRuntime = Object.freeze({
        runtime,
        activationOccurrenceId: generation,
        sourceCustody: createManagedPluginSourceCustody(`immutable-${generation}`),
        isCurrent: () => true,
      });
      const acquireRuntime = vi.fn(async () => acquiredRuntime);
      const invocationCleanup = vi.fn(async () => undefined);
      const projectionCleanup = vi.fn(async () => undefined);
      const projectEndpointAccess = vi.fn(async () => Object.freeze({
        access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
        isCurrent: () => true,
        cleanup: projectionCleanup,
      }));
      const createInvocationServices = vi.fn(async () => Object.freeze({
        connectedAccounts: connectedAccounts(),
        managedServices: managedServices(),
        projectEndpointAccess,
        cleanup: invocationCleanup,
      }));
      const disposables: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];
      const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
        disposables.push(disposable);
        return disposable;
      });
      const registry = await runtimeRegistry({
        pluginId,
        localId,
        runtime,
        invocationCleanup,
        projectEndpointAccess,
        acquireRuntime,
        createInvocationServices,
        runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
        addRuntimeDisposable,
        settleRetiredBackgroundServices: vi.fn(async () => undefined),
        disposeRegistry: vi.fn(async () => {
          for (const disposable of disposables.splice(0).reverse()) {
            await disposable.dispose();
          }
        }),
      });
      return { registry, start };
    };

    const admitted = await createGeneration('G');
    const replacement = await createGeneration('H');
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry: admitted.registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const admittedLease = controller.tryAcquireRuntimeRegistry();
    if (!admittedLease) throw new Error('Expected the admitted registry lease');

    await controller.adoptPreparedRuntimeRegistry({
      registry: replacement.registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 2,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings: { v: 1, bindings: [] },
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      runtimeRegistryLease: admittedLease,
    })).resolves.toEqual({ status: 'running' });

    expect(admitted.start).toHaveBeenCalledOnce();
    expect(replacement.start).not.toHaveBeenCalled();

    await admittedLease.release();
    await controller.shutdown({ timeoutMs: 0 });
  });

  it('maps a permanently unavailable managed runtime to the existing restore-plugin Provider outcome', async () => {
    const pluginId = 'acme.provider.missing-runtime';
    const localId = 'managed';
    const registry = await runtimeRegistry({
      pluginId,
      localId,
      runtime: Object.freeze({ start: vi.fn() }),
      invocationCleanup: vi.fn(),
      projectEndpointAccess: vi.fn(),
      acquireRuntime: vi.fn(async () => null),
      createInvocationServices: vi.fn(async () => Object.freeze({
        connectedAccounts: connectedAccounts(),
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
        cleanup: vi.fn(),
      })),
      runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
      addRuntimeDisposable: vi.fn(),
      settleRetiredBackgroundServices: vi.fn(async () => undefined),
      disposeRegistry: vi.fn(async () => undefined),
    });
    const controller: PluginReloadController = Object.freeze({
      ...createPluginReloadController(),
      tryAcquireRuntimeRegistry: () => Object.freeze({
        registry,
        source: 'active' as const,
        durableRevision: -1,
        release: async () => undefined,
      }),
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings: { v: 1, bindings: [] },
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
    })).rejects.toMatchObject({
      code: 'provider_contribution_unavailable',
      action: 'restore_plugin',
      retryable: false,
    });
  });

  it('never orphans a transferred live effect when authority changes at the transfer boundary', async () => {
    const pluginId = 'acme.provider.transfer-race';
    const localId = 'managed';
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async () => Object.freeze({
      service,
      endpoints: Object.freeze([Object.freeze({
        endpointTemplateId: 'chat',
        endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
      })]),
    }));
    const acquiredRuntime = Object.freeze({
      runtime: Object.freeze({ start }),
      activationOccurrenceId: 'activation-7',
      sourceCustody: createManagedPluginSourceCustody('immutable-7'),
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn();
    const projectionCleanup = vi.fn();
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const createInvocationServices = vi.fn(async () => Object.freeze({
      connectedAccounts: connectedAccounts(),
      managedServices: managedServices(),
      projectEndpointAccess,
      cleanup: invocationCleanup,
    }));
    const runtimeDisposables: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];
    // The account authority changes in the exact tick the launch resources stop
    // being the caller's and become the runtime disposable registry's.
    let authorizationCurrent = true;
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      authorizationCurrent = false;
      return disposable;
    });
    const registry = await runtimeRegistry({
      pluginId,
      localId,
      runtime: acquiredRuntime.runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices: vi.fn(async () => undefined),
      disposeRegistry: vi.fn(async () => undefined),
    });
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });
    const revalidateAuthorization = vi.fn(async () => authorizationCurrent);

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings: { v: 1, bindings: [] },
      isAuthorizationCurrent: () => authorizationCurrent,
      revalidateAuthorization,
    })).resolves.toEqual({ status: 'running' });

    expect(addRuntimeDisposable).toHaveBeenCalledOnce();
    expect(serviceDispose).not.toHaveBeenCalled();
    expect(invocationCleanup).not.toHaveBeenCalled();
    expect(projectionCleanup).not.toHaveBeenCalled();

    await runtimeDisposables[0]!.dispose();
    expect(projectionCleanup).toHaveBeenCalledOnce();
    expect(serviceDispose).toHaveBeenCalledOnce();
    expect(invocationCleanup).toHaveBeenCalledOnce();
    await controller.shutdown({ timeoutMs: 0 });
  });
});
