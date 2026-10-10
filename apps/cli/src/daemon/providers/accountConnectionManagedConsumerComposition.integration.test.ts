import { expect, it } from 'vitest';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { projectProviderBrokerApplication } from '@/providers/broker/applicationProjection';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { resolveProviderContributionRegistryView } from '@/providers/registry';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { projectProviderRuntimeBindingBasis } from '@/providers/spawn/runtimeBindingBasis';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDaemonAccountConnectionManagedConsumerOpen } from './accountConnectionManagedConsumerComposition';

it('composes the real owned Run source and withdraws it when its issued Account reader disappears', async () => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
  const gateway = fixture.gateway;
  if (!gateway || fixture.record.deployment.kind !== 'managedLocal') throw new Error('Expected real managed source');
  const acquireRuntimeLease = () => gateway.controller.acquireRuntimeRegistry({
    resolveRuntimeRegistry: () => gateway.createRegistry(new Set()),
  });
  const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
    happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true }, acquireRuntimeLease,
    // Deliberately retain a valid ambient source after the issued reader ends.
    getAccountSettingsSnapshot: () => fixture.snapshot,
    resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
    modelSettingsMutation: async (): Promise<never> => { throw new Error('Read-only source'); },
  });
  const application = projectProviderBrokerApplication({ connection: fixture.record,
    agentTargetKey: fixture.agentTargetKey, protocol: 'openai-responses' });
  if (!application) throw new Error('Expected real declared application');
  const source = { kind: 'account_connection' as const, connectionId: fixture.record.connectionId,
    expectedConnectionSecurityFingerprint: fixture.record.connectionSecurityFingerprint,
    expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
      implementationIdentity: fixture.record.deployment.implementationIdentity,
      managedRuntime: fixture.record.deployment.managedRuntime, purposeBindings: gateway.purposeBindings }) };
  const authorization = await createRuntimeProviderSpawnAuthorizationAttempt({
    selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
      providerConnectionId: fixture.record.connectionId, modelId: 'example' } },
    machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId,
    lease: fixture.lease, getAccountSettingsSnapshot: () => fixture.snapshot,
    materializationBaseDir: fixture.happyHomeDir, scope: { kind: 'execution_run', executionRunId: 'owned-run' },
    resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
  });
  if (!authorization.ok) { await fixture.cleanup(); throw new Error(authorization.error.code); }
  const open = createDaemonAccountConnectionManagedConsumerOpen({ homeId: 'home', accountId: 'account',
    machineId: () => fixture.machineId,
    isHomeCurrent: () => true,
    custody: machineId => createManagedProviderExplicitStartCustody({ machineId,
      happyHomeDir: fixture.happyHomeDir, controller: gateway.controller }),
    withRegistry: async read => {
      const lease = await acquireRuntimeLease();
      try { return await read(resolveProviderContributionRegistryView(lease.registry.contributes,
        lease.durableRevision, lease.registry.readPluginOccurrenceId)); }
      finally { await lease.release(); }
    },
    projectModelsForAccount: services.projectModelsForAccount,
    openRemote: async (): Promise<never> => { throw new Error('A local source cannot contact another machine'); },
  });
  let issuedSnapshot: ActiveAccountSettingsSnapshot | null = fixture.snapshot;
  const context = { accountId: 'account', targetMachineId: fixture.machineId, expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey!,
    runtimeBindingBasis: projectProviderRuntimeBindingBasis(authorization.attempt.authorization),
    agentId: fixture.agentId, modelId: authorization.attempt.authorization.binding.selection.model.id,
    // The issued Account catalog reader is the persistent-data boundary.
    readAccountSettingsSnapshot: async () => issuedSnapshot,
    resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
    signal: new AbortController().signal, isCurrent: async () => true,
    request: { source, application, consumer: { kind: 'execution_run' as const, executionRunId: 'owned-run' },
      executionRunOccurrenceId: 'owned-occurrence', consumerMachineId: fixture.machineId } };
  let opened: Awaited<ReturnType<typeof open>> = null;
  let issuedOpened: Awaited<ReturnType<typeof open>> = null;
  try {
    opened = await open(context);
    expect(opened).not.toBeNull();
    if (!opened) throw new Error('Expected real canonical source acquisition');
    expect(await opened.revalidate()).toBe(true);
    // Transported credentials may name the same Account without being the
    // daemon's token. The canonical cache scope is token-bound, not Account id.
    const issuedToken = `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.issued`;
    const issuedScope = resolveAccountSettingsScopeKeyForToken(issuedToken);
    issuedSnapshot = { ...fixture.snapshot, scopeKey: issuedScope };
    const issuedContext = { ...context, expectedAccountSettingsScopeKey: issuedScope,
      request: { ...context.request, consumer: { kind: 'execution_run' as const, executionRunId: 'issued-run' },
        executionRunOccurrenceId: 'issued-occurrence' } };
    issuedOpened = await open(issuedContext);
    expect(issuedOpened).not.toBeNull();
    if (!issuedOpened) throw new Error('Expected same-Account issued credentials to acquire their own source');
    expect(await issuedOpened.revalidate()).toBe(true);
    await expect(open({ ...issuedContext, accountId: 'another-account' })).resolves.toBeNull();
    issuedSnapshot = null;
    expect(await opened.revalidate()).toBe(false);
    expect(await issuedOpened.revalidate()).toBe(false);
    await expect(open({ ...context, request: { ...context.request,
      consumer: { kind: 'execution_run', executionRunId: 'after-withdrawal' },
      executionRunOccurrenceId: 'after-withdrawal-occurrence' } })).resolves.toBeNull();
  } finally {
    await issuedOpened?.retire(); await issuedOpened?.cleanup();
    await opened?.retire(); await opened?.cleanup();
    await authorization.attempt.cleanupOnFailure();
    await fixture.cleanup();
  }
});
