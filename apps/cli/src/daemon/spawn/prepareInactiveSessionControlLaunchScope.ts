import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildInactiveSessionResumeSpawnOptions } from '../sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { readPersistedProviderResumeState } from '@/providers/lifecycle/readPersistedResumeSelection';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { resolveNativeAgentLaunchEnvironment } from '@/agent/runtime/launchEnvironment';
import { bindAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { readAccountLaunchProfiles, readProfileSettingsFromAccountSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveLaunchProfileSavedSecretEnvironment } from '../agentRuntime/resolveForegroundProfileSavedSecretEnvironment';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServices/connectedServiceChildEnvironment';
import { scopeConnectedAccountSessionPurposeBindingLease } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { activateConnectedAccountRequestAuthForSpawn } from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import type { ConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { isLegacyServiceKeyedCompatibilityCatalogAgent } from '@/agent/catalog/registry';
import { prepareDaemonConnectedServices } from './prepareDaemonConnectedServices';
import { prepareDaemonProviderLaunch } from './prepareDaemonProviderLaunch';
import { prepareDaemonSpawnChildEnvironment } from './prepareDaemonSpawnChildEnvironment';
import { resolveSpawnLaunchProfileDefaults } from './resolveSpawnLaunchProfileDefaults';
import type { ResolveInactiveSessionControlLaunchScope, InactiveSessionControlLaunchScope } from './inactiveSessionControlLaunchScope';

type ConnectedAdmission = Parameters<typeof prepareDaemonConnectedServices>[0];
type ProviderAdmission = Parameters<typeof prepareDaemonProviderLaunch>[0];

export type InactiveSessionControlLaunchAdmission = Pick<ConnectedAdmission,
  'credentials' | 'api' | 'activeServerDir' | 'connectedServicesMaterializationBaseDir'
  | 'connectedServiceRefreshCoordinator' | 'qualifiedConnectedAccountApi'
  | 'activatePurposeBindings' | 'processEnv' | 'serverContract' | 'prepareAgentIsolationMember' | 'readAgentIsolationEnabled'
  | 'providerAccountUsageStore' | 'authGroupSwitchCoordinator' | 'predictiveSwitchGuard'> & Pick<ProviderAdmission,
  'savedSecretOperationContext' | 'providerRuntimeHomeDir' | 'resolveProvidersFeatureEnabled'
  | 'resolveManagedPurposeBindingIntent' | 'readModelProjection'> & Readonly<{
    agentIsolation?: import('../agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
    connectedAccountsOwner?: InactiveSessionControlLaunchScope['connectedAccountsOwner'];
    assertCurrent(): Promise<void>;
    readAccountSettingsSnapshot: NonNullable<ProviderAdmission['readAccountSettingsSnapshot']>;
    readAccountLaunchProfiles?: () => ReturnType<typeof readAccountLaunchProfiles>;
    requesterSessionBootstrap?: import('../sessionEncryption/requesterSessionCredentials').AdmittedRequesterSessionBootstrap;
    activateSessionPurposeBindings?: ConnectedAccountPurposeBindingOwner['activateSessionPurposeBindings'];
    connectedAccountRequestAuthRegistry?: Pick<ConnectedAccountRequestAuthSubjectRegistry, 'activate' | 'retire'>;
    connectedAccountRequestAuthHttpPort?: number;
  }>;

function unavailable(cause?: unknown): never {
  throw new PluginError({ code: 'inactive_agent_launch_scope_unavailable', message: 'The Session launch binding could not be admitted' }, { cause });
}

/** A short-lived consumer of ordinary spawn admission; never a Session launcher. */
export async function prepareInactiveSessionControlLaunchScope(
  input: Parameters<ResolveInactiveSessionControlLaunchScope>[0],
  admission: InactiveSessionControlLaunchAdmission,
): Promise<InactiveSessionControlLaunchScope> {
  const { adapterParams, runtimeRegistryLease, agentId, signal } = input;
  const registry = runtimeRegistryLease.registry;
  const resources = createProviderLaunchResourceScope();
  const redaction = createProviderRedactionLease({ values: [] });
  resources.register(redaction.close);
  resources.setSanitizer(redaction.redact);
  const assertCurrent = async () => { signal.throwIfAborted(); await admission.assertCurrent(); signal.throwIfAborted(); };
  try {
    await assertCurrent();
    let options = buildInactiveSessionResumeSpawnOptions(adapterParams);
    const backendTarget = resolveBackendTargetFromSessionMetadata(adapterParams.metadata);
    if (!options || !backendTarget || !adapterParams.cwd
      || resolveAgentIdFromSessionMetadata(adapterParams.metadata) !== agentId) unavailable();
    if (admission.requesterSessionBootstrap) options = { ...options, requesterSessionBootstrap: admission.requesterSessionBootstrap };
    // Malformed stored selections must not disappear into snapshot omission.
    // The same strict ingress used by ordinary spawn validates them below.
    if (adapterParams.metadata.connectedServices !== undefined
      && !ConnectedServiceBindingsV2IngressSchema.safeParse(adapterParams.metadata.connectedServices).success) unavailable();
    const profiles = options.profileId
      ? await (admission.readAccountLaunchProfiles?.() ?? readAccountLaunchProfiles(admission.readAccountSettingsSnapshot()?.settings, admission.credentials))
      : undefined;
    await assertCurrent();
    let snapshot = admission.readAccountSettingsSnapshot();
    const profile = resolveSpawnLaunchProfileDefaults({ options, effectiveBackendTarget: backendTarget,
      rawSettings: readProfileSettingsFromAccountSnapshot(snapshot), profileCatalog: snapshot?.profileCatalog,
      artifactsById: profiles?.artifactsById, profilesSnapshot: profiles });
    if (!profile.ok) unavailable();
    options = profile.options;
    let profileEnvironment = options.environmentVariables ?? {};
    if (options.profileId) {
      const selected = profiles?.visibleProfiles.filter(candidate => candidate.id === options!.profileId);
      if (selected?.length !== 1 || !snapshot) unavailable();
      const secrets = await resolveLaunchProfileSavedSecretEnvironment({ profile: selected[0]!, accountSettings: snapshot.settings,
        expectedScopeKey: snapshot.scopeKey ?? '', operationContext: admission.savedSecretOperationContext, signal,
        settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys, savedSecretResources: snapshot.savedSecretResources,
        foregroundSatisfiedSecretRequirementNames: [], secretReferenceOverlay: options.secretReferenceOverlay });
      snapshot = admission.readAccountSettingsSnapshot();
      redaction.add(Object.values(secrets));
      profileEnvironment = { ...profileEnvironment, ...secrets };
    }
    const catalogEntry = await registry.acquireAgentCatalogEntry?.(agentId);
    if (!catalogEntry) unavailable();
    const daemonSpawnHooks = await catalogEntry.getDaemonSpawnHooks?.() ?? null;
    const persisted = readPersistedProviderResumeState(adapterParams.metadata);
    const provider = await prepareDaemonProviderLaunch({
      ...admission, accountSettingsSnapshot: snapshot ?? undefined,
      options, effectiveBackendTarget: backendTarget, catalogAgentId: agentId,
      modelSelection: persisted.selection ?? options.modelSelection,
      profileEnvironmentVariables: profileEnvironment, launchProfileArtifacts: profiles?.artifactsById,
      daemonSpawnHooks, persistedProviderBinding: persisted.binding, normalizedExistingSessionId: adapterParams.sessionId,
      // The inactive adapter already retains this exact registry through cleanup.
      pluginRuntimeLease: { currentRegistry: registry, acquire: async () => runtimeRegistryLease, async release() {} },
      launchResourceScope: resources, signal,
    });
    if (!provider.ok) unavailable();
    // Managed endpoints are resolved by the running Session's managed-service
    // owner. Without that final scope, a control cannot borrow native defaults.
    if (provider.attempt && !('materializeAfterHooks' in provider.attempt)) unavailable();
    await assertCurrent();
    const connected = await prepareDaemonConnectedServices({
      ...admission, accountSettingsSnapshot: snapshot ?? undefined, options: provider.options,
      normalizedExistingSessionId: adapterParams.sessionId, requestedSessionId: '',
      effectiveResume: options.resume ?? '', catalogAgentId: agentId, pluginRuntimeRegistry: registry,
      isAccountRuntimeCurrent: async () => { await assertCurrent(); return true; },
    });
    if (!connected.ok) unavailable();
    const auth = connected.auth;
    resources.register({ onFailure: async () => { await auth?.cleanupOnFailure?.(); },
      onExit: async () => { await auth?.cleanupOnExit?.(); } });
    resources.register(() => auth?.materializationPurposeLease?.dispose());
    const purposes = connected.qualifiedPurposeBindingSnapshot;
    let exactPurposeBindingSubjectId = auth?.materializationPurposeLease?.subjectId;
    if (purposes?.purposes.length) {
      if (!admission.activateSessionPurposeBindings) unavailable();
      const lease = admission.activateSessionPurposeBindings({ sessionId: adapterParams.sessionId,
        purposes: purposes.purposes, bindings: purposes.bindings,
        ...(purposes.directMaterialOrigins ? { directMaterialOrigins: purposes.directMaterialOrigins } : {}) });
      resources.register(() => lease.dispose());
      exactPurposeBindingSubjectId = lease.subjectId;
      if (purposes.requestAuthUses?.length) {
        const root = auth?.requestAuthMaterializedRoot;
        const port = admission.connectedAccountRequestAuthHttpPort;
        if (!root || !port || !admission.connectedAccountRequestAuthRegistry) unavailable();
        await activateConnectedAccountRequestAuthForSpawn({ materializationId: connected.materializationKey,
          materializedRootDir: root, httpPort: port, registry: admission.connectedAccountRequestAuthRegistry,
          launchResourceScope: resources, subject: scopeConnectedAccountSessionPurposeBindingLease({
            lease, subjectId: lease.subjectId, parentSessionId: adapterParams.sessionId, uses: purposes.requestAuthUses,
            ...(isLegacyServiceKeyedCompatibilityCatalogAgent(catalogEntry) ? { legacyServiceKeyedCompatibility: true } : {}),
            registerRedaction: redaction.add,
          }) });
      }
    }
    const child = await prepareDaemonSpawnChildEnvironment({
      ...(connected.agentLaunchMaterials?.memberIdentity ? { memberAgentCliLaunch: {
        identity: connected.agentLaunchMaterials.memberIdentity,
        installedCli: admission.agentIsolation?.managedHappierBinaryPath ?? '', signal,
      } } : {}),
      savedSecretOperationContext: admission.savedSecretOperationContext,
      options: connected.options, existingSessionMetadata: adapterParams.metadata, resolvedAgentId: agentId,
      effectiveModelSelection: persisted.selection ?? options.modelSelection, terminal: options.terminal,
      profileEnvironmentVariables: profileEnvironment, daemonSpawnHooks, pluginRuntimeRegistry: registry,
      processEnv: admission.processEnv,
      // This scope owns cleanup from materialization onward, including a
      // refusal before child-environment preparation. Avoid double custody.
      connectedServiceAuth: auth ? { ...auth, cleanupOnFailure: null, cleanupOnExit: null } : null,
      connectedServiceMaterializationIdentity: connected.materializationIdentity,
      providerBindingAttempt: provider.attempt, providerAgentTargetKey: provider.agentTargetKey,
      providerDiagnosticRedactionLease: redaction, launchResourceScope: resources,
    });
    if (!child.ok) {
      if (child.result.errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED
        && child.result.errorMessage === 'agent_cli_not_runnable') {
        throw new PluginError({ code: child.result.errorMessage, retryable: false,
          message: readSessionStartupFailurePreview(child.result.errorMessage, resolveAgentDisplayTitle(agentId))!,
          details: { agentId, remedy: 'install_managed_runtime' } });
      }
      unavailable();
    }
    if (provider.attempt && !(await provider.attempt.revalidateBeforeEffect(signal)).ok) unavailable();
    await assertCurrent();
    const selections = readConnectedServiceChildSelectionsFromEnv(child.extraEnvForChild);
    const connectedAccounts = (purposes?.bindings ?? []).map(binding => {
      if (binding.target.kind === 'account') return { purpose: binding.purpose.purpose, account: binding.target.account };
      const service = binding.target.service;
      const selected = selections?.get(buildQualifiedPluginContributionKey(service));
      if (!selected) unavailable();
      return { purpose: binding.purpose.purpose, account: { service,
        accountId: selected.kind === 'group' ? selected.activeProfileId : selected.profileId } };
    });
    const environment = resolveNativeAgentLaunchEnvironment({ processEnv: admission.processEnv,
      environmentVariables: child.extraEnvForChild, unsetEnvironmentVariables: child.spawnEnvironment.unsetEnvKeys }).values;
    const identity = registry.contributes.agentDefinitionsById.get(agentId)?.identity;
    if (!identity) unavailable();
    const agentCliLaunch = child.spawnEnvironment.agentCliLaunchSpec
      ? bindAgentCliLaunchSpec({ localAgentId: identity.localId, spec: child.spawnEnvironment.agentCliLaunchSpec }) : undefined;
    resources.register(provider.attempt?.takeCleanupOnExit());
    const dispose = resources.transfer();
    return { environment, connectedAccounts, ...(exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId } : {}),
      ...(agentCliLaunch ? { agentCliLaunch } : {}), providerBindingActive: provider.attempt !== null,
      ...(admission.connectedAccountsOwner ? { connectedAccountsOwner: admission.connectedAccountsOwner } : {}),
      assertCurrent,
      dispose: async () => { await dispose?.(); } };
  } catch (error) {
    await resources.retire();
    signal.throwIfAborted();
    if (isPluginError(error) && error.code === 'agent_cli_not_runnable') throw error;
    unavailable(error);
  }
}
