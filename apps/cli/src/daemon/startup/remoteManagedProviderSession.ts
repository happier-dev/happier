import { PluginError } from '@happier-dev/plugin-sdk';
import type { ProviderRuntimeBindingBasisV1 } from '@happier-dev/protocol';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { assessProviderEndpoint } from '@happier-dev/protocol/providers/safety/url';
import type { RunnerManagedProviderCustodyScopeV1 } from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import type { ResolvedExecutablePluginRuntimeRegistry, RetainedManagedProviderRuntimeInvocationScope } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { CapturedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import type { AccountConnectionProviderBrokerAccess, OpenAccountConnectionProviderBrokerAccess } from '@/providers/broker/accountConnectionClient';
import type { TrackedSession } from '@/daemon/types';
import { materializeRunnerManagedProviderAgentBinding } from '../agentRuntime/materializeRunnerManagedProviderAgentBinding';

/** The existing runner bridge consumes one projection for either placement.
 * Remote placement attests the source locally, but never acquires a worker
 * managed-service or request-auth claim. Only the admitted hub owns those. */
export async function createRemoteManagedProviderSessionProjection<TLaunchAuthority>(input: Readonly<{
  sessionId: string;
  machineId: string;
  basis: ProviderRuntimeBindingBasisV1;
  metadata: NonNullable<NonNullable<TrackedSession['spawnOptions']>['providerBindingMetadataV1']>;
  hardRevocationRevision: number;
  registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'prepareManagedProviderSessionBootstrap'>;
  retainedScope?: RetainedManagedProviderRuntimeInvocationScope;
  signal: AbortSignal;
  isBootstrapCurrent(): boolean;
  isCurrent(scope: RunnerManagedProviderCustodyScopeV1): Promise<boolean>;
  openBroker?: OpenAccountConnectionProviderBrokerAccess;
  installConsumerCleanup(cleanup: () => Promise<void>): void;
  cleanup(): Promise<void>;
  readSupervisionLaunchAuthority(serverId: string): TLaunchAuthority | null;
  capturedAgentProviderBinding: CapturedAgentProviderBindingAdapter | null;
  isCapturedAgentRegistrationCurrent(): boolean;
}>) {
  const { basis, signal } = input;
  const unavailable = (message: string) => new PluginError({ code: 'plugin_services_managed_provider_authority_unavailable', message });
  if (basis.deployment.kind !== 'managedLocal'
    || basis.deployment.managedRuntime.sharing !== 'connectionMachine'
    || basis.deployment.gatewayPlacement.kind !== 'machine'
    || basis.deployment.gatewayPlacement.machineId === input.machineId
    || !input.openBroker || !input.registry.prepareManagedProviderSessionBootstrap) {
    throw unavailable('Remote managed gateway authority is unavailable');
  }
  const deployment = basis.deployment;
  const targetMachineId = basis.deployment.gatewayPlacement.machineId;
  const bootstrap = await input.registry.prepareManagedProviderSessionBootstrap({
    sessionId: input.sessionId, runtimeBindingBasis: basis,
    ...(input.retainedScope ? { retainedScope: input.retainedScope } : {}),
    signal, isCurrent: input.isBootstrapCurrent,
  });
  if (!bootstrap) throw unavailable('Remote managed gateway source attestation is unavailable');
  const scope: RunnerManagedProviderCustodyScopeV1 = Object.freeze({
    v: 1, sessionId: input.sessionId, runtimeBindingBasis: basis,
    pluginId: bootstrap.identity.pluginId, providerLocalId: bootstrap.identity.localId,
    occurrenceId: bootstrap.occurrenceId, sourceCustody: bootstrap.sourceCustody,
    manifestAuthority: bootstrap.manifestAuthority, operationClaimId: bootstrap.operationClaimId,
  });
  const isCurrent = async () => !signal.aborted && await input.isCurrent(scope);
  let opened: AccountConnectionProviderBrokerAccess | null = null;
  let startPromise: Promise<void> | null = null;
  input.installConsumerCleanup(async () => { await opened?.cleanup(); });
  const start = () => {
    startPromise ??= (async () => {
      if (!await isCurrent()) throw unavailable('Remote managed gateway selection is not current');
      opened = await input.openBroker!({ connectionId: basis.connectionId, targetMachineId,
        expectedConnectionSecurityFingerprint: basis.credentialAuthorization.connectionSecurityFingerprint,
        expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
          implementationIdentity: deployment.implementationIdentity,
          managedRuntime: deployment.managedRuntime, purposeBindings: deployment.purposeBindings }),
        consumer: { kind: 'session', sessionId: input.sessionId },
        application: { implementationIdentity: deployment.implementationIdentity, agentTargetKey: basis.agentTargetKey,
          endpointTemplateId: basis.endpoint.endpointTemplateId, protocol: basis.endpoint.protocol }, signal });
      if (!await isCurrent()) {
        await opened.cleanup();
        throw unavailable('Remote managed gateway selection changed before publication');
      }
    })();
    return startPromise;
  };
  const readSharedGatewayAccess = async (requestSignal?: AbortSignal) => {
    requestSignal?.throwIfAborted();
    await start();
    if (!opened || !opened.isCurrent() || !await isCurrent()) {
      await input.cleanup();
      throw unavailable('Remote managed gateway consumer is unavailable');
    }
    let access: Awaited<ReturnType<typeof opened.readHttpBinding>>;
    try { access = await opened.readHttpBinding(); }
    catch (error) { await input.cleanup().catch(() => undefined); throw error; }
    requestSignal?.throwIfAborted();
    return access;
  };
  return Object.freeze({
    bootstrap: Object.freeze({ v: 1 as const, custody: 'daemonShared' as const, scope, requestAuth: null,
      providerPluginHardRevocationRevisionAtAdmission: input.hardRevocationRevision, sessionBindingMetadata: input.metadata }),
    connectedAccounts: null, readSupervisionLaunchAuthority: input.readSupervisionLaunchAuthority, start, readSharedGatewayAccess,
    async materializeAgentBinding({ endpointUrl, credentialPlaceholder }: Readonly<{ endpointUrl: string; credentialPlaceholder: string | null }>) {
      const access = await readSharedGatewayAccess();
      let endpoint: ReturnType<typeof assessProviderEndpoint>;
      try { endpoint = assessProviderEndpoint(endpointUrl); }
      catch {
        await input.cleanup();
        throw new PluginError({ code: 'plugin_services_managed_provider_materialization_authority_changed',
          message: 'Remote managed gateway endpoint is invalid' });
      }
      if (!input.capturedAgentProviderBinding || !input.metadata.model || !basis.runtimeCredentialTransport
        || credentialPlaceholder === null || endpoint.locality !== 'loopback'
        || new URL(endpoint.normalizedUrl).hostname !== '127.0.0.1'
        || new URL(endpoint.normalizedUrl).protocol !== 'http:'
        || new URL(endpoint.normalizedUrl).pathname !== new URL(access.endpointUrl).pathname) {
        await input.cleanup();
        throw new PluginError({ code: 'plugin_services_managed_provider_materialization_authority_changed',
          message: 'Remote managed gateway materialization is unavailable' });
      }
      return await materializeRunnerManagedProviderAgentBinding({
        capturedAgentBinding: input.capturedAgentProviderBinding,
        isCapturedAgentRegistrationCurrent: input.isCapturedAgentRegistrationCurrent,
        isManagedProviderCurrent: isCurrent, cleanup: input.cleanup,
        binding: { v: 1, agentTargetKey: basis.agentTargetKey, selection: { connectionId: basis.connectionId, model: input.metadata.model },
          contributionKey: basis.contributionKey, endpoint: { ...basis.endpoint, normalizedUrl: endpoint.normalizedUrl },
          runtimeCredentialTransport: basis.runtimeCredentialTransport, compatibilityFingerprint: input.metadata.compatibilityFingerprint },
        prepared: basis.prepared, credential: { kind: 'apiKey', transport: basis.runtimeCredentialTransport, value: credentialPlaceholder },
      });
    },
    isCurrent,
  });
}
