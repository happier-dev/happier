import { isRetainedManagedProviderInvocationCurrent, isManagedProviderSessionInvocationCurrent } from "@/providers/broker/invocationCurrentness";
import { createAgentIsolationSessionContext } from "@/daemon/agentIsolation/agentIsolationSessionContext";
import { isDeepStrictEqual } from "node:util";
import { createSharedManagedProviderSessionAccess, createSharedManagedProviderSessionStart } from "@/daemon/startup/sharedManagedProviderSessionAccess";
import { createRemoteManagedProviderSessionProjection } from "@/daemon/startup/remoteManagedProviderSession";
import { isRemoteProviderGatewayPlacement } from "@/providers/managed/gatewayPlacement";
import type { ApiMachineClient } from "@/api/apiMachine";
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from "@/configuration";
import type { RequesterSessionRuntimeContext, RequesterSessionRuntimeContextPorts } from "@/daemon/sessionEncryption/requesterSessionCredentials";
import { sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { createRunnerIsolationIdentity } from '@/daemon/agentRuntime/runnerIsolationIdentity';
import { createRunnerAgentProjectLaunchInvocation } from "@/daemon/agentRuntime/runnerAgentProjectLaunch";
import { ExecutionRunGetResponseSchema, ExecutionRunStopResponseSchema } from "@happier-dev/protocol/execution/runs/responseSchemas";
import { getActiveAccountSettingsSnapshot } from "@/settings/accountSettings/activeAccountSettingsSnapshot";
import { SESSION_RPC_METHODS } from "@happier-dev/protocol/rpc/methods";
import type { RunnerDaemonPluginServicesPreparationCauseV1 } from "@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol";
import { logger } from "@/ui/logger";
import { assessProviderEndpoint } from "@happier-dev/protocol/providers/safety/url";
import type { ProviderRuntimeBindingBasisV1 } from "@happier-dev/protocol";
import { pluginSourceCustodyV1Equal } from "@happier-dev/protocol/plugins/runtime/sourceCustody";
import { acquireAuthoritativePluginRuntimeRegistryLease } from "@/plugins/runtime/reload/runtimeLease";
import { authorizeSessionModelTransitionProviderTargetWithLease, resolveDaemonSessionModelTransitionAuthority } from "@/providers/sessions/authorizeSessionModelTransitionTarget";
import { sameProviderRuntimeBindingBasis } from "@/providers/sessions/providerAuthorizationApplyPolicy";
import { isRetainedManagedProviderSettingsGrantCurrent } from "@/providers/sessions/retainedManagedProviderPolicy";
import { readProviderSettingsForCli } from "@/providers/settings/read";
import type { CurrentMachineExecutionOriginContext } from "@/api/machine/resolveCurrentMachineExecutionOriginContext";
import { createRunnerExecutionRunSnapshots } from "@/daemon/agentRuntime/runnerExecutionRunSnapshots";
import { createRunnerManagedServicesClient, type RunnerManagedServicesCustodyDispatchV1, type RunnerManagedProviderCustodyScopeV1 } from "@/agent/runtime/session/process/runnerManagedServicesCustody";
import { resolveSessionTransportContext } from "@/session/services/resolveSessionTransportContext";
import { callSessionRpc } from "@/session/transport/rpc/sessionRpc";
import { startPublicManagedProviderRuntime } from "@/providers/lifecycle/publicManagedProviderRuntimeStart";
import { createProviderLaunchResourceScope } from "@/providers/lifecycle/resourceScope";
import { createDaemonShutdownCancellationDomains } from "@/daemon/startup/shutdownCancellationDomains";
import { resolveTrackedSessionCatalogAgentId } from "@/daemon/sessions/resolveTrackedSessionCatalogAgentId";
import { currentAgentBindingMatchesRetainedRunner } from "@/plugins/runtime/retainedPluginSourceAttestation";
import { createRunnerDaemonPluginServicesHost, createRunnerDaemonPluginServicesPreparationError, type RunnerDaemonCurrentGlobalActionExecutor, type RunnerDaemonCurrentGlobalExternalSessionsOwner, type RunnerDaemonCurrentGlobalMcpOwner } from "@/daemon/agentRuntime/runnerDaemonPluginServicesHost";
import { materializeRunnerManagedProviderAgentBinding } from "@/daemon/agentRuntime/materializeRunnerManagedProviderAgentBinding";
import { authorizeTrackedRunnerAgentDaemonServiceOperation } from "@/daemon/agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation";
import { readLeasedAgentProviderBindingAdapter } from "@/plugins/runtime/providerBindings/adapter";
import { resolvePluginStorePaths } from "@/plugins/store/paths";
import { readCurrentPluginHardRevocationRevision, readCurrentPluginImmutableGenerationIntegrityCurrentness } from "@/plugins/store/registry/generationStore";
import { projectRunnerManagedProviderServerLaunchAuthority, type RunnerManagedProviderServerLaunchAuthority } from "@/plugins/runtime/invocation/services/runnerManagedServiceSupervisionAuthorization";
import { isPluginError, PluginError } from "@happier-dev/plugin-sdk";
import type { ManagedServiceSpec } from "@happier-dev/plugin-sdk/managed-services";
import type { TrackedSession } from "@/daemon/types";
import { ConnectedServiceRuntimeRegistry } from "@/daemon/connectedServices/runtimeRegistry/registry";

export function createDaemonRunnerInvocationServices({
  params, findTrackedSessionByHappySessionId, runnerExecutionRunSnapshots, acquireDaemonPluginRuntimeRegistryLease, createSessionManagedProviderCustodyDispatch, createSessionManagedProviderCustodyClient, resolveSessionAccountContext, withSessionAccountHome, shutdownCancellationDomains, releaseSessionAccountContext, connectedServiceRuntimeRegistry,
}: Readonly<{
  params: Readonly<{
agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
machineId: string;
serverId: string;
serverBaseUrl: string;
credentials: StoredCredentials;
externalActionAccountId?: string | null;
openAccountConnectionProviderBrokerAccess?: import('@/providers/broker/accountConnectionClient').OpenAccountConnectionProviderBrokerAccess;
resolveCurrentMachineExecutionOriginContext?: (
      signal?: AbortSignal,
    ) => Promise<CurrentMachineExecutionOriginContext | null>;
pidToTrackedSession: Map<number, TrackedSession>;
getApiMachineForSessions: () => ApiMachineClient | null;
}> & Pick<RequesterSessionRuntimeContextPorts, 'resolveRequesterSessionRuntimeContext'>;
  findTrackedSessionByHappySessionId: (trackedSessions: Iterable<TrackedSession>, sessionIdRaw: string) => TrackedSession | null;
  runnerExecutionRunSnapshots: ReturnType<typeof createRunnerExecutionRunSnapshots>;
  acquireDaemonPluginRuntimeRegistryLease: () => ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>;
  createSessionManagedProviderCustodyDispatch: (scope: RunnerManagedProviderCustodyScopeV1) => Promise<RunnerManagedServicesCustodyDispatchV1>;
  createSessionManagedProviderCustodyClient: (scope: RunnerManagedProviderCustodyScopeV1, dependencies: Parameters<
      typeof createRunnerManagedServicesClient
    >[0]['dependencies']) => Promise<ReturnType<typeof createRunnerManagedServicesClient>>;
  resolveSessionAccountContext: (sessionId: string | null, retainedAttribution?: TrackedSession['requesterWorkAttributionV1'], signal?: AbortSignal) => Promise<RequesterSessionRuntimeContext | null>;
  withSessionAccountHome: <T>(context: RequesterSessionRuntimeContext | null, operation: () => Promise<T>) => Promise<T>;
  shutdownCancellationDomains: ReturnType<typeof createDaemonShutdownCancellationDomains>;
  releaseSessionAccountContext: (context: RequesterSessionRuntimeContext | null) => Promise<void>;
  connectedServiceRuntimeRegistry: ConnectedServiceRuntimeRegistry;
}>): ReturnType<typeof createRunnerDaemonPluginServicesHost> {
  return createRunnerDaemonPluginServicesHost({
    createInvocation: async ({
      sessionId,
      runner,
      retainedAgent,
      executionRunSnapshotId,
      runnerRetainedAgent,
      invocationId,
      executionRunCwd,
      witness,
      managedProviderRetention,
      signal,
    }) => {
      let preparationStage: RunnerDaemonPluginServicesPreparationCauseV1['stage'] = 'runner_authority';
      try {
        const tracked = findTrackedSessionByHappySessionId(
          params.pidToTrackedSession.values(),
          sessionId,
        );
        const runSnapshot = executionRunSnapshotId && runnerRetainedAgent
          ? runnerExecutionRunSnapshots.read(executionRunSnapshotId, { sessionId, runner, retainedAgent: runnerRetainedAgent })
          : null;
        const admittedRunnerAgent = runSnapshot ? runnerRetainedAgent! : retainedAgent;
        if (executionRunSnapshotId && (!runSnapshot || !isDeepStrictEqual(runSnapshot.projection.agent?.binding, retainedAgent))) {
          throw new PluginError({ code: 'execution_run_contribution_snapshot_unavailable',
            message: 'Execution Run executable snapshot is unavailable' });
        }
        if (
          !tracked ||
          !authorizeTrackedRunnerAgentDaemonServiceOperation({
            tracked,
            sessionId,
            runner,
            retainedAgent: admittedRunnerAgent,
            witness: undefined,
            allowIdleCurrentGeneration: true,
          })
        ) {
          throw new PluginError({
            code: 'plugin_services_runner_authority_unavailable',
            message:
              'Runner PluginServices exact runner authority is unavailable',
          });
        }
        preparationStage = 'invocation_context';
        const trackedInvocationContext = tracked.runnerAgentInvocationContext;
        // The tracked context owns ordinary Session launch. A snapshot-backed
        // child Run has its own host-authored cwd, supplied by the runner's
        // invocation constructor, before Project membership or Exec resolution.
        if (runSnapshot ? !executionRunCwd?.trim() : executionRunCwd !== undefined) {
          throw new PluginError({ code: 'plugin_services_invocation_context_unavailable',
            message: 'Runner PluginServices invocation context is unavailable' });
        }
        const invocationContext = trackedInvocationContext
          ? Object.freeze({
              cwd: runSnapshot ? executionRunCwd! : trackedInvocationContext.cwd,
              ...(trackedInvocationContext.profileId ? { profileId: trackedInvocationContext.profileId } : {}),
              ...(trackedInvocationContext.secretReferenceOverlay ? { secretReferenceOverlay: trackedInvocationContext.secretReferenceOverlay } : {}),
              environment: Object.freeze({}),
              ...(!runSnapshot && trackedInvocationContext.agentCliLaunch
                ? {
                    agentCliLaunch: trackedInvocationContext.agentCliLaunch,
                  }
                : {}),
              providerBindingActive:
                runSnapshot ? false : trackedInvocationContext.providerBindingActive,
            })
          : null;
        if (!invocationContext) {
          throw new PluginError({
            code: 'plugin_services_invocation_context_unavailable',
            message: 'Runner PluginServices invocation context is unavailable',
          });
        }
        preparationStage = 'registry_acquisition';
        const lease = runSnapshot ? { ...runSnapshot.snapshot.runtimeRegistryLease, release: async () => {} }
          : await acquireDaemonPluginRuntimeRegistryLease();
        let releaseLease = true;
        const supervisionLaunchAuthorities = new Map<
          string,
          RunnerManagedProviderServerLaunchAuthority
        >();
        const readSupervisionLaunchAuthority = (
          serverId: string,
        ): RunnerManagedProviderServerLaunchAuthority | null =>
          supervisionLaunchAuthorities.get(serverId) ?? null;
        const stampSupervisionLaunchAuthority = (
          spec: ManagedServiceSpec,
        ): void => {
          const expected =
            projectRunnerManagedProviderServerLaunchAuthority(spec);
          if (!expected) return;
          const existing = supervisionLaunchAuthorities.get(expected.serverId);
          if (existing) {
            if (!isDeepStrictEqual(existing, expected)) {
              throw new PluginError({
                code: 'plugin_managed_service_spec_conflict',
                message:
                  'A different managed-service specification already owns this exact lifecycle scope',
              });
            }
            return;
          }
          supervisionLaunchAuthorities.set(expected.serverId, expected);
        };
        const managedProviderCleanup: {
          current: (() => void | Promise<void>) | null;
        } = { current: null };
        const cleanupManagedProvider = async () => {
          supervisionLaunchAuthorities.clear();
          const cleanup = managedProviderCleanup.current;
          managedProviderCleanup.current = null;
          await cleanup?.();
        };
        let releaseManagedProviderInvocation = true;
        try {
          preparationStage = 'current_registration';
          const registration = lease.registry.agentRuntimesByAgentId.get(
            retainedAgent.agentId,
          );
          let isCurrent = false;
          try {
            isCurrent = registration?.isCurrent() === true;
          } catch {
            isCurrent = false;
          }
          const binding =
            registration?.hasPrimaryRuntime === true
              ? registration.sessionRunnerFactoryBinding
              : undefined;
          const currentRegistrationIsExact = Boolean(
            registration &&
            registration.hasPrimaryRuntime &&
            binding &&
            isCurrent &&
            registration.pluginId === retainedAgent.pluginId &&
            registration.agentId === retainedAgent.agentId &&
            registration.sourceCustody &&
            pluginSourceCustodyV1Equal(
              registration.sourceCustody,
              binding.sourceCustody,
            ) &&
            currentAgentBindingMatchesRetainedRunner({
              runnerSnapshotIdentity: runner.snapshotIdentity,
              currentBinding: binding,
              retainedBinding: retainedAgent,
            }),
          );
          const capturedAgentRegistration = currentRegistrationIsExact
            ? registration!
            : null;
          const capturedAgentProviderBinding = capturedAgentRegistration
            ? readLeasedAgentProviderBindingAdapter({
                lease,
                agentId: capturedAgentRegistration.agentId,
              })
            : null;
          const isCapturedAgentRegistrationPreOpen = (): boolean => {
            if (
              !capturedAgentRegistration ||
              !capturedAgentProviderBinding ||
              capturedAgentRegistration.providerBinding !==
                capturedAgentProviderBinding.adapter ||
              capturedAgentRegistration.pluginId !==
                capturedAgentProviderBinding.pluginId ||
              tracked.agentRuntimeDaemonServiceSessionOpenAttestation !==
                undefined ||
              tracked.agentRuntimeDaemonServiceAdmittedTurnId !== undefined
            ) {
              return false;
            }
            try {
              return capturedAgentRegistration.isCurrent() === true;
            } catch {
              return false;
            }
          };
          const authorizeOperation = (
            operationWitness: typeof witness,
            options?: Readonly<{
              requireActiveTurn?: boolean;
              recordRefusal?: boolean;
            }>,
          ): boolean =>
            authorizeTrackedRunnerAgentDaemonServiceOperation({
              runSnapshotCurrent: !runSnapshot || runnerExecutionRunSnapshots.read(executionRunSnapshotId!, {
                sessionId, runner, retainedAgent: admittedRunnerAgent }) === runSnapshot,
              tracked,
              sessionId,
              runner,
              retainedAgent: admittedRunnerAgent,
              witness: runSnapshot ? undefined : operationWitness,
              allowIdleCurrentGeneration: runSnapshot ? true : options?.requireActiveTurn !== true,
              onRefused: options?.recordRefusal ? predicate => logger.debug(
                '[PluginExec] Native launch runner authority refusal', { predicate, sessionId,
                  ...(runSnapshot ? { executionRunId: invocationId } : {}) }) : undefined,
            });
          preparationStage = 'turn_authority';
          if (!authorizeOperation(witness)) {
            throw new PluginError({
              code: 'plugin_services_turn_authority_unavailable',
              message: 'Runner PluginServices turn authority is unavailable',
            });
          }
          preparationStage = 'managed_provider';
          const revalidateAdoptedManagedProviderPolicy = async (
            runtimeBindingBasis: ProviderRuntimeBindingBasisV1,
          ): Promise<boolean> => {
            const trackedSelection =
              tracked.spawnOptions?.modelSelection?.ref ?? null;
            const trackedMetadata =
              tracked.spawnOptions?.providerBindingMetadataV1 ?? null;
            if (
              !trackedSelection ||
              trackedSelection.providerConnectionId === null ||
              !trackedMetadata
            )
              return false;
            try {
              resolveDaemonSessionModelTransitionAuthority({
                trackedAgentId: resolveTrackedSessionCatalogAgentId(tracked),
                authorizedAgentId: retainedAgent.agentId,
                trackedSelection,
                trackedSessionBindingMetadata: trackedMetadata,
                requestAgentId: retainedAgent.agentId,
                requestedSelection: {
                  ...trackedSelection,
                  providerConnectionId: trackedSelection.providerConnectionId,
                },
              });
              const accountSnapshot = getActiveAccountSettingsSnapshot();
              if (!accountSnapshot) return false;
              const providerSettings = readProviderSettingsForCli(
                accountSnapshot,
              ).settings;
              return isRetainedManagedProviderSettingsGrantCurrent({
                machineId: params.machineId,
                providerSettings,
                runtimeBindingBasis,
              });
            } catch {
              return false;
            }
          };
          const resolveSharedGatewayBinding = async (
            basis: ProviderRuntimeBindingBasisV1,
          ) => {
            const origin = await params.resolveCurrentMachineExecutionOriginContext?.(signal);
            if (!origin || origin.machineId !== params.machineId || !params.externalActionAccountId) {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message: 'Managed gateway execution identity is unavailable',
              });
            }
            return Object.freeze({
              homeId: origin.serverIdentityId,
              accountId: params.externalActionAccountId,
              connectionId: basis.connectionId,
              machineId: params.machineId,
              consumerId: sessionId,
            });
          };
          const createSharedManagedProjection = (
            created: import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry').ResolvedManagedProviderRuntimeInvocationServices,
            basis: ProviderRuntimeBindingBasisV1,
            metadata: NonNullable<NonNullable<typeof tracked.spawnOptions>['providerBindingMetadataV1']>,
            revalidate: () => Promise<boolean>,
          ) => {
            if (basis.deployment.kind !== 'managedLocal' || created.lifetime !== 'sharedConsumer') {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message: 'Managed gateway shared custody is unavailable',
              });
            }
            const deployment = basis.deployment;
            const lifetimeScope = createProviderLaunchResourceScope();
            lifetimeScope.register(created.cleanup);
            let currentLaunchScope: ReturnType<typeof createProviderLaunchResourceScope> | null = null;
            lifetimeScope.register(async () => await currentLaunchScope?.retire());
            managedProviderCleanup.current = () => lifetimeScope.release();
            let captured: Pick<Parameters<NonNullable<typeof created.materializeManagedProviderAgentBinding>>[0], 'service' | 'projection'> | null = null;
            const start = createSharedManagedProviderSessionStart({
              readProjection: () => captured,
              start: async () => {
                // Failure retires only this establishment attempt. The
                // Session's admitted invocation remains available to retry.
                await currentLaunchScope?.retire();
                const launchScope = createProviderLaunchResourceScope();
                currentLaunchScope = launchScope;
                const started = await startPublicManagedProviderRuntime({
                  identity: created.bootstrap.identity,
                  request: {
                    reason: 'sessionDemand',
                    connectionId: basis.connectionId,
                    connectionRevision: metadata.connectionRevision,
                    endpointTemplateIds: deployment.managedRuntime.endpointTemplateIds,
                  },
                  acquireRuntime: async identity => {
                    const runtime = await lease.registry.acquireManagedProviderRuntime?.(identity);
                    return runtime && runtime.activationOccurrenceId === created.bootstrap.occurrenceId
                      && pluginSourceCustodyV1Equal(runtime.sourceCustody, created.bootstrap.sourceCustody)
                      ? runtime : null;
                  },
                  connectedAccounts: created.connectedAccounts,
                  custody: {
                    ...created,
                    async projectEndpointAccess(input) {
                      const projection = await created.projectEndpointAccess(input);
                      if (projection) captured = { service: input.service, projection };
                      return projection;
                    },
                  },
                  isAuthorizationCurrent: () => !signal.aborted && authorizeOperation(undefined),
                  revalidateAuthorization: revalidate,
                  signal,
                  launchResourceScope: launchScope,
                });
                if (!started.ok) throw new PluginError({
                  code: started.code,
                  message: 'Managed gateway Session runtime start failed',
                });
                launchScope.transfer();
              },
            });
            return Object.freeze({
              start,
              readSharedGatewayAccess: createSharedManagedProviderSessionAccess({
                start,
                readProjection: () => captured,
                ...(created.materializeManagedProviderAgentBinding ? { materialize: created.materializeManagedProviderAgentBinding } : {}),
                endpointTemplateId: basis.endpoint.endpointTemplateId,
                revalidate,
              }),
            });
          };
          const createRemoteManagedProjection = async (
            basis: ProviderRuntimeBindingBasisV1,
            metadata: NonNullable<NonNullable<typeof tracked.spawnOptions>['providerBindingMetadataV1']>,
            hardRevocationRevision: number,
            revalidate: () => Promise<boolean>,
            retainedScope?: import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry').RetainedManagedProviderRuntimeInvocationScope,
          ) => await createRemoteManagedProviderSessionProjection({
            sessionId, machineId: params.machineId, basis, metadata, hardRevocationRevision,
            registry: lease.registry, ...(retainedScope ? { retainedScope } : {}), signal,
            isBootstrapCurrent: () => !signal.aborted && authorizeOperation(undefined),
            isCurrent: async scope => !signal.aborted && authorizeOperation(undefined) && await revalidate()
              && await readCurrentPluginHardRevocationRevision({
                paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }), pluginId: scope.pluginId,
              }) === hardRevocationRevision
              && (scope.sourceCustody.kind !== 'managed' || await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }),
                pluginId: scope.pluginId, immutableGenerationId: scope.sourceCustody.immutableGenerationId,
              })),
            openBroker: params.openAccountConnectionProviderBrokerAccess,
            installConsumerCleanup: cleanup => { managedProviderCleanup.current = cleanup; },
            cleanup: cleanupManagedProvider, readSupervisionLaunchAuthority,
            capturedAgentProviderBinding, isCapturedAgentRegistrationCurrent: isCapturedAgentRegistrationPreOpen,
          });
          let managedProvider = await (async () => {
            // Snapshot-backed Runs prepare their own Provider binding through
            // execution_run.provider.prepare_v1. The tracked Session's binding
            // belongs to its parent and cannot supply a second Run authority.
            if (runSnapshot) return null;
            if (managedProviderRetention) {
              const retained = managedProviderRetention;
              const scope = retained.scope;
              if (scope.sessionId !== sessionId) {
                throw new PluginError({
                  code: 'plugin_services_managed_provider_retention_mismatch',
                  message:
                    'Retained managed Provider authority belongs to another Session',
                });
              }
              const createRetainedInvocation =
                lease.registry
                  .createRetainedManagedProviderRuntimeInvocationServices;
              if (!createRetainedInvocation) {
                throw new PluginError({
                  code: 'plugin_services_managed_provider_authority_unavailable',
                  message:
                    'Retained managed Provider invocation services are unavailable',
                });
              }
              const storePaths = resolvePluginStorePaths({
                happyHomeDir: configuration.happyHomeDir,
              });
              const readsRetainedAuthorityCurrent = (): boolean => {
                const currentBasis =
                  tracked.spawnOptions?.providerBindingMetadataV1
                    ?.runtimeBindingBasis;
                return (
                  !signal.aborted &&
                  authorizeTrackedRunnerAgentDaemonServiceOperation({
                    tracked,
                    sessionId,
                    runner,
                    retainedAgent,
                    witness: undefined,
                    allowIdleCurrentGeneration: true,
                  }) &&
                  currentBasis !== undefined &&
                  sameProviderRuntimeBindingBasis(
                    currentBasis,
                    scope.runtimeBindingBasis,
                  )
                );
              };
              const retainedCustodyDispatch =
                retained.custody === 'daemonShared' ? null
                  : await createSessionManagedProviderCustodyDispatch(scope);
              let retainedProviderPolicyFence: Promise<void> | null = null;
              let retainedProviderPolicyFenced = false;
              const fenceRetainedProviderPolicy = async () => {
                if (!retainedCustodyDispatch) return await cleanupManagedProvider();
                if (retainedProviderPolicyFenced) return;
                if (!retainedProviderPolicyFence) {
                  const fenceAttempt = (async () => {
                    const result = await retainedCustodyDispatch({
                      v: 1,
                      kind: 'fenceRetainedProviderPolicy',
                      claim: scope,
                    });
                    if (result.kind !== 'retainedProviderPolicyFenced') {
                      throw new PluginError({
                        code: 'plugin_services_managed_provider_custody_unavailable',
                        message:
                          'Runner returned an invalid retained Provider policy-fence result',
                      });
                    }
                  })();
                  retainedProviderPolicyFence = fenceAttempt;
                  try {
                    await fenceAttempt;
                    retainedProviderPolicyFenced = true;
                  } finally {
                    if (retainedProviderPolicyFence === fenceAttempt) {
                      retainedProviderPolicyFence = null;
                    }
                  }
                  return;
                }
                await retainedProviderPolicyFence;
              };
              const revalidateRetainedProviderPolicy =
                async (): Promise<boolean> =>
                  await revalidateAdoptedManagedProviderPolicy(
                    scope.runtimeBindingBasis,
                  );
              const readAdoptedPublicOutcome = async () => {
                if (!retainedCustodyDispatch) return null;
                const outcome = await retainedCustodyDispatch({
                  v: 1,
                  kind: 'readAdoptedPublicOutcome',
                  claim: scope,
                });
                return outcome.kind === 'adoptedPublicOutcome'
                  ? outcome.outcome
                  : null;
              };
              const currentHardRevocationRevision =
                await readCurrentPluginHardRevocationRevision({
                  paths: storePaths,
                  pluginId: scope.pluginId,
                });
              const retainedBasis = scope.runtimeBindingBasis;
              if (retainedBasis.deployment.kind === 'managedLocal'
                && isRemoteProviderGatewayPlacement(retainedBasis.deployment.gatewayPlacement, params.machineId)) {
                const metadata = tracked.spawnOptions?.providerBindingMetadataV1;
                if (retained.custody !== 'daemonShared' || !metadata?.runtimeBindingBasis
                  || !sameProviderRuntimeBindingBasis(metadata.runtimeBindingBasis, retainedBasis)
                  || currentHardRevocationRevision !== retained.providerPluginHardRevocationRevisionAtAdmission) {
                  throw new PluginError({ code: 'plugin_services_managed_provider_authority_unavailable',
                    message: 'Retained remote managed gateway authority changed' });
                }
                return await createRemoteManagedProjection(retainedBasis, metadata, currentHardRevocationRevision,
                  async () => readsRetainedAuthorityCurrent() && await revalidateRetainedProviderPolicy(), {
                    sessionId: scope.sessionId, runtimeBindingBasis: retainedBasis,
                    identity: { pluginId: scope.pluginId, localId: scope.providerLocalId }, occurrenceId: scope.occurrenceId,
                    sourceCustody: scope.sourceCustody, manifestAuthority: scope.manifestAuthority, operationClaimId: scope.operationClaimId,
                  });
              }
              if (
                currentHardRevocationRevision !==
                  retained.providerPluginHardRevocationRevisionAtAdmission ||
                (scope.sourceCustody.kind === 'managed' &&
                  !(await readCurrentPluginImmutableGenerationIntegrityCurrentness(
                    {
                      paths: storePaths,
                      pluginId: scope.pluginId,
                      immutableGenerationId:
                        scope.sourceCustody.immutableGenerationId,
                    },
                  )))
              ) {
                throw new PluginError({
                  code: 'plugin_services_managed_provider_authority_unavailable',
                  message: 'Retained managed Provider authority was hard-revoked',
                });
              }
              const created = await createRetainedInvocation({
                ...(retained.custody === 'daemonShared'
                  ? { sharedGateway: await resolveSharedGatewayBinding(scope.runtimeBindingBasis) }
                  : {}),
                scope: {
                  sessionId: scope.sessionId,
                  runtimeBindingBasis: scope.runtimeBindingBasis,
                  identity: {
                    pluginId: scope.pluginId,
                    localId: scope.providerLocalId,
                  },
                  occurrenceId: scope.occurrenceId,
                  sourceCustody: scope.sourceCustody,
                  manifestAuthority: scope.manifestAuthority,
                  operationClaimId: scope.operationClaimId,
                },
                signal,
                isCurrent: readsRetainedAuthorityCurrent,
                readAdoptedPublicOutcome,
                revalidatePolicy: revalidateRetainedProviderPolicy,
              });
              if (!created || (retained.custody === 'daemonShared') !== (created.lifetime === 'sharedConsumer')) {
                throw new PluginError({
                  code: 'plugin_services_managed_provider_authority_unavailable',
                  message:
                    'Retained managed Provider authority could not be reauthorized',
                });
              }
              managedProviderCleanup.current = () => created.cleanup();
              const bootstrap = created.bootstrap;
              if (
                bootstrap.identity.pluginId !== scope.pluginId ||
                bootstrap.identity.localId !== scope.providerLocalId ||
                bootstrap.occurrenceId !== scope.occurrenceId ||
                !pluginSourceCustodyV1Equal(
                  bootstrap.sourceCustody,
                  scope.sourceCustody,
                ) ||
                bootstrap.manifestAuthority !== scope.manifestAuthority ||
                bootstrap.operationClaimId !== scope.operationClaimId ||
                (await readCurrentPluginHardRevocationRevision({
                  paths: storePaths,
                  pluginId: scope.pluginId,
                })) !== currentHardRevocationRevision ||
                (scope.sourceCustody.kind === 'managed' &&
                  !(await readCurrentPluginImmutableGenerationIntegrityCurrentness(
                    {
                      paths: storePaths,
                      pluginId: scope.pluginId,
                      immutableGenerationId:
                        scope.sourceCustody.immutableGenerationId,
                    },
                  )))
              ) {
                throw new PluginError({
                  code: 'plugin_services_managed_provider_retention_mismatch',
                  message:
                    'Replacement daemon reconstructed a different managed Provider authority',
                });
              }
              const isRetainedProviderCurrent = async () =>
                await isRetainedManagedProviderInvocationCurrent({
                  readsRetainedAuthorityCurrent,
                  revalidatePolicy: revalidateRetainedProviderPolicy,
                  fenceRetainedPolicy: fenceRetainedProviderPolicy,
                  readHardRevocationRevision: async () =>
                    await readCurrentPluginHardRevocationRevision({
                      paths: storePaths,
                      pluginId: scope.pluginId,
                    }),
                  readGenerationIntegrityCurrentness: async () =>
                    scope.sourceCustody.kind !== 'managed' ||
                    (await readCurrentPluginImmutableGenerationIntegrityCurrentness(
                      {
                        paths: storePaths,
                        pluginId: scope.pluginId,
                        immutableGenerationId:
                          scope.sourceCustody.immutableGenerationId,
                      },
                    )),
                  hardRevocationRevisionAtAdmission:
                    currentHardRevocationRevision,
                });
              const retainedSessionBindingMetadata =
                tracked.spawnOptions?.providerBindingMetadataV1;
              if (
                !retainedSessionBindingMetadata ||
                !retainedSessionBindingMetadata.runtimeBindingBasis ||
                !sameProviderRuntimeBindingBasis(
                  retainedSessionBindingMetadata.runtimeBindingBasis,
                  scope.runtimeBindingBasis,
                )
              ) {
                throw new PluginError({
                  code: 'plugin_services_managed_provider_materialization_authority_changed',
                  message:
                    'Retained managed Provider binding metadata is unavailable',
                });
              }
              const sharedProjection = created.lifetime === 'sharedConsumer'
                ? createSharedManagedProjection(
                    created,
                    scope.runtimeBindingBasis,
                    retainedSessionBindingMetadata,
                    isRetainedProviderCurrent,
                  )
                : null;
              return Object.freeze({
                bootstrap: Object.freeze({
                  v: 1 as const,
                  ...(sharedProjection ? { custody: 'daemonShared' as const } : {}),
                  scope,
                  requestAuth: sharedProjection ? null : bootstrap.requestAuth,
                  providerPluginHardRevocationRevisionAtAdmission:
                    currentHardRevocationRevision,
                  sessionBindingMetadata: retainedSessionBindingMetadata,
                }),
                connectedAccounts: created.connectedAccounts,
                readSupervisionLaunchAuthority,
                ...(sharedProjection ? {
                  readSharedGatewayAccess: sharedProjection.readSharedGatewayAccess,
                } : {}),
                start: async () => {
                  if (sharedProjection) return await sharedProjection.start();
                  const outcome = await readAdoptedPublicOutcome();
                  if (
                    !outcome ||
                    outcome.operationClaimId !== scope.operationClaimId ||
                    !outcome.endpointTemplateIds.includes(
                      scope.runtimeBindingBasis.endpoint.endpointTemplateId,
                    ) ||
                    !(await isRetainedProviderCurrent())
                  ) {
                    throw new PluginError({
                      code: 'plugin_services_managed_provider_authority_unavailable',
                      message:
                        'Retained managed Provider public outcome is unavailable',
                    });
                  }
                },
                materializeAgentBinding: async ({
                  endpointUrl,
                  credentialPlaceholder,
                }: Readonly<{
                  endpointUrl: string;
                  credentialPlaceholder: string | null;
                }>) => {
                  const basis = scope.runtimeBindingBasis;
                  const metadata =
                    tracked.spawnOptions?.providerBindingMetadataV1;
                  const outcome = await readAdoptedPublicOutcome();
                  const sharedEndpoint = sharedProjection
                    ? await sharedProjection.readSharedGatewayAccess()
                    : null;
                  const endpoint = outcome?.endpoints.find(
                    (entry) =>
                      entry.endpointTemplateId ===
                      basis.endpoint.endpointTemplateId,
                  );
                  let assessed: ReturnType<typeof assessProviderEndpoint> | null =
                    null;
                  try {
                    assessed = assessProviderEndpoint(endpointUrl);
                  } catch {
                    assessed = null;
                  }
                  if (
                    !capturedAgentProviderBinding ||
                    (credentialPlaceholder === null) !==
                      (basis.runtimeCredentialTransport === null) ||
                    !metadata?.model ||
                    !assessed ||
                    (sharedEndpoint ? (
                      assessed.locality !== 'loopback'
                      || new URL(assessed.normalizedUrl).hostname !== '127.0.0.1'
                      || new URL(assessed.normalizedUrl).protocol !== 'http:'
                      || new URL(assessed.normalizedUrl).pathname
                        !== new URL(sharedEndpoint.endpointUrl).pathname
                    ) : (!endpoint || assessed.normalizedUrl !== endpoint.endpointUrl))
                  ) {
                    await cleanupManagedProvider().catch(() => undefined);
                    throw new PluginError({
                      code: 'plugin_services_managed_provider_materialization_authority_changed',
                      message:
                        'Retained managed Provider pre-open materialization authority is unavailable',
                    });
                  }
                  return await materializeRunnerManagedProviderAgentBinding({
                    capturedAgentBinding: capturedAgentProviderBinding,
                    isCapturedAgentRegistrationCurrent:
                      isCapturedAgentRegistrationPreOpen,
                    isManagedProviderCurrent: isRetainedProviderCurrent,
                    cleanup: cleanupManagedProvider,
                    binding: {
                      v: 1,
                      agentTargetKey: basis.agentTargetKey,
                      selection: {
                        connectionId: basis.connectionId,
                        model: metadata.model,
                      },
                      contributionKey: basis.contributionKey,
                      endpoint: {
                        endpointTemplateId: basis.endpoint.endpointTemplateId,
                        normalizedUrl: assessed.normalizedUrl,
                        protocol: basis.endpoint.protocol,
                        publicHeaders: basis.endpoint.publicHeaders,
                      },
                      runtimeCredentialTransport:
                        basis.runtimeCredentialTransport,
                      compatibilityFingerprint: metadata.compatibilityFingerprint,
                    },
                    prepared: basis.prepared,
                    credential:
                      credentialPlaceholder === null
                        ? { kind: 'none' }
                        : {
                            kind: 'apiKey',
                            transport: basis.runtimeCredentialTransport!,
                            value: credentialPlaceholder,
                          },
                  });
                },
                isCurrent: isRetainedProviderCurrent,
              });
            }
            const trackedSelection =
              tracked.spawnOptions?.modelSelection?.ref ?? null;
            const trackedBindingMetadata =
              tracked.spawnOptions?.providerBindingMetadataV1 ?? null;
            const trackedRuntimeBindingBasis =
              trackedBindingMetadata?.runtimeBindingBasis ?? null;
            if (
              !trackedSelection ||
              trackedSelection.providerConnectionId === null ||
              !trackedRuntimeBindingBasis ||
              trackedRuntimeBindingBasis.deployment.kind !== 'managedLocal'
            ) {
              return null;
            }
            const authority = resolveDaemonSessionModelTransitionAuthority({
              trackedAgentId: resolveTrackedSessionCatalogAgentId(tracked),
              authorizedAgentId: retainedAgent.agentId,
              trackedSelection,
              trackedSessionBindingMetadata: trackedBindingMetadata,
              requestAgentId: retainedAgent.agentId,
              requestedSelection: {
                ...trackedSelection,
                providerConnectionId: trackedSelection.providerConnectionId,
              },
            });
            const authorization =
              await authorizeSessionModelTransitionProviderTargetWithLease({
                signal,
                sessionId,
                machineId: params.machineId,
                agentId: authority.agentId,
                agentTargetKey: authority.agentTargetKey,
                lease,
                input: authority.input,
              });
            const runtimeBindingBasis = authorization.runtimeBindingBasis;
            if (runtimeBindingBasis.deployment.kind !== 'managedLocal') {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message:
                  'Runner Provider authorization is not a managed-local binding',
              });
            }
            if (
              !sameProviderRuntimeBindingBasis(
                trackedRuntimeBindingBasis,
                runtimeBindingBasis,
              )
            ) {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message:
                  'Runner managed Provider authorization is not current for this Session binding',
              });
            }
            const identity =
              runtimeBindingBasis.deployment.implementationIdentity;
            const createInvocation =
              lease.registry.createManagedProviderRuntimeInvocationServices;
            if (!createInvocation) {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message:
                  'Managed Provider runtime invocation services are unavailable',
              });
            }
            const storePaths = resolvePluginStorePaths({
              happyHomeDir: configuration.happyHomeDir,
            });
            const providerPluginHardRevocationRevisionAtAdmission =
              await readCurrentPluginHardRevocationRevision({
                paths: storePaths,
                pluginId: identity.pluginId,
              });
            let readAdoptedPublicOutcome:
              | ReturnType<
                  typeof createRunnerManagedServicesClient
                >['readAdoptedPublicOutcome']
              | null = null;
            let fenceRetainedProviderPolicy:
              | ReturnType<
                  typeof createRunnerManagedServicesClient
                >['fenceRetainedProviderPolicy']
              | null = null;
            const readsSessionProviderAuthorityCurrent = (): boolean => {
              const currentBasis =
                tracked.spawnOptions?.providerBindingMetadataV1
                  ?.runtimeBindingBasis;
              return (
                !signal.aborted &&
                authorizeTrackedRunnerAgentDaemonServiceOperation({
                  tracked,
                  sessionId,
                  runner,
                  retainedAgent,
                  witness: undefined,
                  allowIdleCurrentGeneration: true,
                }) &&
                currentBasis !== undefined &&
                sameProviderRuntimeBindingBasis(currentBasis, runtimeBindingBasis)
              );
            };
            const revalidateSessionProviderAuthority =
              async (): Promise<boolean> => {
                if (!readsSessionProviderAuthorityCurrent()) {
                  return false;
                }
                try {
                  const refreshed =
                    await authorizeSessionModelTransitionProviderTargetWithLease({
                      signal,
                      sessionId: sessionId,
                      machineId: params.machineId,
                      agentId: authority.agentId,
                      agentTargetKey: authority.agentTargetKey,
                      lease,
                      input: authority.input,
                    });
                  return (
                    readsSessionProviderAuthorityCurrent() &&
                    sameProviderRuntimeBindingBasis(
                      refreshed.runtimeBindingBasis,
                      runtimeBindingBasis,
                    ) &&
                    (await readCurrentPluginHardRevocationRevision({
                      paths: storePaths,
                      pluginId: identity.pluginId,
                    })) === providerPluginHardRevocationRevisionAtAdmission
                  );
                } catch {
                  return false;
                }
              };
            if (isRemoteProviderGatewayPlacement(runtimeBindingBasis.deployment.gatewayPlacement, params.machineId)) {
              return await createRemoteManagedProjection(runtimeBindingBasis, authorization.sessionBindingMetadata,
                providerPluginHardRevocationRevisionAtAdmission, revalidateSessionProviderAuthority);
            }
            const createdManagedProviderInvocation = await createInvocation({
              identity,
              purposeBindings: runtimeBindingBasis.deployment.purposeBindings,
              ...(runtimeBindingBasis.deployment.managedRuntime.sharing === 'connectionMachine'
                ? { sharedGateway: await resolveSharedGatewayBinding(runtimeBindingBasis) }
                : {}),
              operationClaim: {
                kind: 'sessionDemand',
                sessionId,
                runtimeBindingBasis,
                bindSessionCustody: async (custodyScope, dependencies) => {
                  const runnerCustodyScope: RunnerManagedProviderCustodyScopeV1 =
                    Object.freeze({
                      v: 1,
                      sessionId: custodyScope.sessionId,
                      runtimeBindingBasis: custodyScope.runtimeBindingBasis,
                      pluginId: custodyScope.identity.pluginId,
                      providerLocalId: custodyScope.identity.localId,
                      occurrenceId: custodyScope.occurrenceId,
                      sourceCustody: custodyScope.sourceCustody,
                      manifestAuthority: custodyScope.manifestAuthority,
                      operationClaimId: custodyScope.operationClaimId,
                    });
                  const custodyClient =
                    await createSessionManagedProviderCustodyClient(
                      runnerCustodyScope,
                      dependencies,
                    );
                  readAdoptedPublicOutcome =
                    custodyClient.readAdoptedPublicOutcome;
                  fenceRetainedProviderPolicy =
                    custodyClient.fenceRetainedProviderPolicy;
                  return Object.freeze({
                    managedServices: Object.freeze({
                      dependencies: custodyClient.services.dependencies,
                      supervise(
                        spec: Parameters<
                          typeof custodyClient.services.supervise
                        >[0],
                        options?: Parameters<
                          typeof custodyClient.services.supervise
                        >[1],
                      ) {
                        stampSupervisionLaunchAuthority(spec);
                        return custodyClient.services.supervise(spec, options);
                      },
                    }),
                    projectEndpointAccess: custodyClient.projectEndpointAccess,
                    adoptService: async (serviceId) => {
                      await custodyClient.commitAdoption(serviceId);
                    },
                    readAdoptedPublicOutcome:
                      custodyClient.readAdoptedPublicOutcome,
                  });
                },
              },
              signal,
              isCurrent: readsSessionProviderAuthorityCurrent,
            });
            if (!createdManagedProviderInvocation) {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message:
                  'Managed Provider runtime invocation authority could not be prepared',
              });
            }
            managedProviderCleanup.current = () =>
              createdManagedProviderInvocation.cleanup();
            const bootstrap = createdManagedProviderInvocation.bootstrap;
            if (
              bootstrap.identity.pluginId !== identity.pluginId ||
              bootstrap.identity.localId !== identity.localId ||
              (await readCurrentPluginHardRevocationRevision({
                paths: storePaths,
                pluginId: identity.pluginId,
              })) !== providerPluginHardRevocationRevisionAtAdmission ||
              (bootstrap.sourceCustody.kind === 'managed' &&
                !(await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                  paths: storePaths,
                  pluginId: identity.pluginId,
                  immutableGenerationId:
                    bootstrap.sourceCustody.immutableGenerationId,
                })))
            ) {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message:
                  'Managed Provider runtime authority changed while preparing the Runner invocation',
              });
            }
            const managedRuntimeDeclaration =
              lease.registry.contributes.providers?.find(
                (provider) =>
                  provider.identity.pluginId === identity.pluginId &&
                  provider.identity.localId === identity.localId,
              )?.definition.managedRuntime;
            if (
              managedRuntimeDeclaration?.kind !== 'managed' ||
              !lease.registry.acquireManagedProviderRuntime
            ) {
              throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message:
                  'Managed Provider public runtime declaration is unavailable',
              });
            }
            const providerConnectionRevision =
              authorization.sessionBindingMetadata.connectionRevision;
            const sharedProjection = createdManagedProviderInvocation.lifetime === 'sharedConsumer'
              ? createSharedManagedProjection(
                  createdManagedProviderInvocation,
                  runtimeBindingBasis,
                  authorization.sessionBindingMetadata,
                  revalidateSessionProviderAuthority,
                )
              : null;
            let adoptionCommitted = false;
            let startPromise: Promise<void> | null = null;
            const start = (): Promise<void> => {
              startPromise ??= (async () => {
                if (sharedProjection) {
                  await sharedProjection.start();
                  adoptionCommitted = true;
                  return;
                }
                const launchResourceScope = createProviderLaunchResourceScope();
                const started = await startPublicManagedProviderRuntime({
                  identity,
                  request: Object.freeze({
                    reason: 'sessionDemand' as const,
                    connectionId: trackedSelection.providerConnectionId,
                    connectionRevision: providerConnectionRevision,
                    endpointTemplateIds: Object.freeze([
                      ...managedRuntimeDeclaration.endpointTemplateIds,
                    ]),
                  }),
                  acquireRuntime: async (requestedIdentity) =>
                    await lease.registry.acquireManagedProviderRuntime!(
                      requestedIdentity,
                    ),
                  connectedAccounts:
                    createdManagedProviderInvocation.connectedAccounts,
                  custody: createdManagedProviderInvocation,
                  isAuthorizationCurrent: readsSessionProviderAuthorityCurrent,
                  revalidateAuthorization: revalidateSessionProviderAuthority,
                  signal,
                  launchResourceScope,
                });
                if (!started.ok) {
                  throw new PluginError({
                    code: started.code,
                    message: 'Managed Provider Session runtime start failed',
                  });
                }
                adoptionCommitted = true;
                const retire = launchResourceScope.transfer();
                const cleanupInvocation = managedProviderCleanup.current;
                managedProviderCleanup.current = async () => {
                  await retire?.();
                  await cleanupInvocation?.();
                };
              })();
              return startPromise;
            };
            const isManagedProviderCurrent = async () =>
              await isManagedProviderSessionInvocationCurrent({
                adoptionCommitted: () => adoptionCommitted,
                revalidateInitialPolicy: revalidateSessionProviderAuthority,
                readsRetainedAuthorityCurrent:
                  readsSessionProviderAuthorityCurrent,
                revalidateRetainedPolicy: async () =>
                  await revalidateAdoptedManagedProviderPolicy(
                    runtimeBindingBasis,
                  ),
                fenceRetainedPolicy: async () => {
                  if (sharedProjection) return await cleanupManagedProvider();
                  if (!fenceRetainedProviderPolicy) {
                    throw new PluginError({
                      code: 'plugin_services_managed_provider_custody_unavailable',
                      message:
                        'Runner retained Provider policy-fence authority is unavailable',
                    });
                  }
                  await fenceRetainedProviderPolicy();
                },
                readHardRevocationRevision: async () =>
                  await readCurrentPluginHardRevocationRevision({
                    paths: storePaths,
                    pluginId: identity.pluginId,
                  }),
                readGenerationIntegrityCurrentness: async () =>
                  bootstrap.sourceCustody.kind !== 'managed' ||
                  (await readCurrentPluginImmutableGenerationIntegrityCurrentness(
                    {
                      paths: storePaths,
                      pluginId: identity.pluginId,
                      immutableGenerationId:
                        bootstrap.sourceCustody.immutableGenerationId,
                    },
                  )),
                hardRevocationRevisionAtAdmission:
                  providerPluginHardRevocationRevisionAtAdmission,
              });
            return Object.freeze({
              bootstrap: Object.freeze({
                v: 1 as const,
                ...(sharedProjection ? { custody: 'daemonShared' as const } : {}),
                scope: Object.freeze({
                  v: 1 as const,
                  sessionId: sessionId,
                  runtimeBindingBasis,
                  pluginId: identity.pluginId,
                  providerLocalId: identity.localId,
                  occurrenceId: bootstrap.occurrenceId,
                  sourceCustody: bootstrap.sourceCustody,
                  manifestAuthority: bootstrap.manifestAuthority,
                  operationClaimId: bootstrap.operationClaimId,
                }),
                requestAuth: sharedProjection ? null : bootstrap.requestAuth,
                providerPluginHardRevocationRevisionAtAdmission,
                sessionBindingMetadata: authorization.sessionBindingMetadata,
              }),
              connectedAccounts:
                createdManagedProviderInvocation.connectedAccounts,
              readSupervisionLaunchAuthority,
              start,
              ...(sharedProjection ? {
                readSharedGatewayAccess: sharedProjection.readSharedGatewayAccess,
              } : {}),
              materializeAgentBinding: async ({
                endpointUrl,
                credentialPlaceholder,
              }: Readonly<{
                endpointUrl: string;
                credentialPlaceholder: string | null;
              }>) => {
                if (
                  !startPromise ||
                  !capturedAgentProviderBinding ||
                  (!sharedProjection && !readAdoptedPublicOutcome) ||
                  (credentialPlaceholder === null) !==
                    (runtimeBindingBasis.runtimeCredentialTransport === null)
                ) {
                  await cleanupManagedProvider().catch(() => undefined);
                  throw new PluginError({
                    code: 'plugin_services_managed_provider_materialization_authority_changed',
                    message:
                      'Managed Provider pre-open materialization authority is unavailable',
                  });
                }
                await startPromise;
                let assessed: ReturnType<typeof assessProviderEndpoint>;
                try {
                  assessed = assessProviderEndpoint(endpointUrl);
                } catch {
                  await cleanupManagedProvider().catch(() => undefined);
                  throw new PluginError({
                    code: 'plugin_services_managed_provider_materialization_authority_changed',
                    message:
                      'Managed Provider materialization endpoint is invalid',
                  });
                }
                const adopted = await readAdoptedPublicOutcome?.();
                const sharedEndpoint = sharedProjection
                  ? await sharedProjection.readSharedGatewayAccess()
                  : null;
                const adoptedEndpoint = adopted?.endpoints.find(
                  (entry) =>
                    entry.endpointTemplateId ===
                    runtimeBindingBasis.endpoint.endpointTemplateId,
                );
                if (
                  assessed.locality !== 'loopback' ||
                  (sharedEndpoint ? (
                    new URL(assessed.normalizedUrl).hostname !== '127.0.0.1'
                    || new URL(assessed.normalizedUrl).protocol !== 'http:'
                    || new URL(assessed.normalizedUrl).pathname
                      !== new URL(sharedEndpoint.endpointUrl).pathname
                  ) : (!adopted ||
                  adopted.operationClaimId !== bootstrap.operationClaimId ||
                  !adoptedEndpoint ||
                  assessed.normalizedUrl !== adoptedEndpoint.endpointUrl))
                ) {
                  await cleanupManagedProvider().catch(() => undefined);
                  throw new PluginError({
                    code: 'plugin_services_managed_provider_materialization_authority_changed',
                    message:
                      'Managed Provider adopted endpoint materialization facts are unavailable',
                  });
                }
                return await materializeRunnerManagedProviderAgentBinding({
                  capturedAgentBinding: capturedAgentProviderBinding,
                  isCapturedAgentRegistrationCurrent:
                    isCapturedAgentRegistrationPreOpen,
                  isManagedProviderCurrent,
                  cleanup: cleanupManagedProvider,
                  binding: {
                    v: 1,
                    agentTargetKey: runtimeBindingBasis.agentTargetKey,
                    selection: {
                      connectionId: runtimeBindingBasis.connectionId,
                      model: authorization.model,
                    },
                    contributionKey: runtimeBindingBasis.contributionKey,
                    endpoint: {
                      endpointTemplateId:
                        runtimeBindingBasis.endpoint.endpointTemplateId,
                      normalizedUrl: assessed.normalizedUrl,
                      protocol: runtimeBindingBasis.endpoint.protocol,
                      publicHeaders: runtimeBindingBasis.endpoint.publicHeaders,
                    },
                    runtimeCredentialTransport:
                      runtimeBindingBasis.runtimeCredentialTransport,
                    compatibilityFingerprint:
                      authorization.sessionBindingMetadata
                        .compatibilityFingerprint,
                  },
                  prepared: runtimeBindingBasis.prepared,
                  credential:
                    credentialPlaceholder === null
                      ? { kind: 'none' }
                      : {
                          kind: 'apiKey',
                          transport:
                            runtimeBindingBasis.runtimeCredentialTransport!,
                          value: credentialPlaceholder,
                        },
                });
              },
              isCurrent: isManagedProviderCurrent,
            });
          })().catch(async (error: unknown) => {
            if (
              managedProviderRetention &&
              isPluginError(error) &&
              error.code ===
                'plugin_services_managed_provider_authority_unavailable'
            ) {
              await cleanupManagedProvider().catch(() => undefined);
              return null;
            }
            throw error;
          });
          if (managedProviderRetention && managedProvider) {
            let retainedProviderIsCurrent = false;
            try {
              retainedProviderIsCurrent = await managedProvider.isCurrent();
            } catch {
              retainedProviderIsCurrent = false;
            }
            if (!retainedProviderIsCurrent) {
              await cleanupManagedProvider().catch(() => undefined);
              managedProvider = null;
            }
          }
          preparationStage = 'retained_agent_services';
          const createRetained =
            lease.registry.createRetainedRunnerAgentInvocationServices;
          if (!createRetained) {
            throw new PluginError({
              code: 'plugin_services_retained_generation_unavailable',
              message: 'Retained Runner Agent PluginServices are unavailable',
            });
          }
          const invocationProjection = await createRetained({
            binding: retainedAgent,
            runnerSnapshotIdentity: runner.snapshotIdentity,
            sessionId,
            managedDependencyRetention:
              tracked.runnerManagedDependencyRetentionV1 ?? {
                v: 1 as const,
                sourceCustodies: [],
                qualifiedDependencyIds: [],
              },
            correlationId: invocationId,
            cwd: invocationContext.cwd,
            environment: invocationContext.environment,
            ...(invocationContext.agentCliLaunch
              ? {
                  agentCliLaunch: invocationContext.agentCliLaunch,
                }
              : {}),
            providerBindingActive: invocationContext.providerBindingActive,
            signal,
            isOccurrenceCurrent: () => authorizeOperation(undefined),
          });
          preparationStage = 'invocation_projection';
          const executeCurrentGlobalAction: RunnerDaemonCurrentGlobalActionExecutor =
            async (actionOrRef, actionInput, options, operationWitness) => {
              if (typeof actionOrRef !== 'string') {
                throw new PluginError({
                  code: 'plugin_action_generation_private_unavailable',
                  message:
                    'A retained Runner cannot substitute the current plugin generation for an exact generation-private action handler',
                });
              }
              const currentLease =
                await acquireDaemonPluginRuntimeRegistryLease();
              try {
                const createCurrentActions =
                  currentLease.registry
                    .createRetainedRunnerAgentCurrentGlobalActionsService;
                if (!createCurrentActions) {
                  throw new PluginError({
                    code: 'plugin_services_retained_generation_unavailable',
                    message:
                      'Retained Runner current-global Actions are unavailable',
                  });
                }
                const currentActions = await createCurrentActions({
                  binding: retainedAgent,
                  runnerSnapshotIdentity: runner.snapshotIdentity,
                  sessionId,
                  correlationId: invocationId,
                  signal,
                  readActiveTurnAdmissionWitness: () => operationWitness ?? null,
                  isOccurrenceCurrent: () =>
                    authorizeOperation(operationWitness, {
                      requireActiveTurn: true,
                    }),
                });
                if (
                  !authorizeOperation(operationWitness, {
                    requireActiveTurn: true,
                  })
                ) {
                  throw new PluginError({
                    code: 'plugin_services_turn_authority_unavailable',
                    message:
                      'Runner PluginServices Action lost its exact active-turn authority before execution',
                  });
                }
                // This is the runtime parse boundary: the
                // canonical ActionsService validates the
                // action-specific input and output schemas.
                const executeCurrentAction = currentActions.execute as (
                  action: Parameters<RunnerDaemonCurrentGlobalActionExecutor>[0],
                  actionInput: Parameters<RunnerDaemonCurrentGlobalActionExecutor>[1],
                  actionOptions: Parameters<RunnerDaemonCurrentGlobalActionExecutor>[2],
                ) => Promise<unknown>;
                return await executeCurrentAction(
                  actionOrRef,
                  actionInput,
                  options,
                );
              } finally {
                await currentLease.release();
              }
            };
          const currentGlobalMcp: RunnerDaemonCurrentGlobalMcpOwner =
            Object.freeze({
              async list(query) {
                const currentLease =
                  await acquireDaemonPluginRuntimeRegistryLease();
                try {
                  const createCurrentMcp =
                    currentLease.registry
                      .createRetainedRunnerAgentCurrentGlobalMcpService;
                  if (!createCurrentMcp) {
                    throw new PluginError({
                      code: 'plugin_services_retained_generation_unavailable',
                      message:
                        'Retained Runner current-global MCP is unavailable',
                    });
                  }
                  return await (
                    await createCurrentMcp({
                      binding: retainedAgent,
                      runnerSnapshotIdentity: runner.snapshotIdentity,
                      sessionId,
                      correlationId: invocationId,
                      signal,
                      isOccurrenceCurrent: () => authorizeOperation(undefined),
                    })
                  ).list(query);
                } finally {
                  await currentLease.release();
                }
              },
              async discover(provider, query, options) {
                const currentLease =
                  await acquireDaemonPluginRuntimeRegistryLease();
                try {
                  const createCurrentMcp =
                    currentLease.registry
                      .createRetainedRunnerAgentCurrentGlobalMcpService;
                  if (!createCurrentMcp) {
                    throw new PluginError({
                      code: 'plugin_services_retained_generation_unavailable',
                      message:
                        'Retained Runner current-global MCP is unavailable',
                    });
                  }
                  return await (
                    await createCurrentMcp({
                      binding: retainedAgent,
                      runnerSnapshotIdentity: runner.snapshotIdentity,
                      sessionId,
                      correlationId: invocationId,
                      signal,
                      isOccurrenceCurrent: () => authorizeOperation(undefined),
                    })
                  ).discover(provider, query, options);
                } finally {
                  await currentLease.release();
                }
              },
              async connect(ref, options) {
                const currentLease =
                  await acquireDaemonPluginRuntimeRegistryLease();
                let releaseCurrentLease = true;
                try {
                  const createCurrentMcp =
                    currentLease.registry
                      .createRetainedRunnerAgentCurrentGlobalMcpService;
                  if (!createCurrentMcp) {
                    throw new PluginError({
                      code: 'plugin_services_retained_generation_unavailable',
                      message:
                        'Retained Runner current-global MCP is unavailable',
                    });
                  }
                  const selectedClient = await (
                    await createCurrentMcp({
                      binding: retainedAgent,
                      runnerSnapshotIdentity: runner.snapshotIdentity,
                      sessionId,
                      correlationId: invocationId,
                      signal,
                      isOccurrenceCurrent: () => authorizeOperation(undefined),
                    })
                  ).connect(ref, options);
                  let disposed = false;
                  let disposal: Promise<void> | null = null;
                  const dispose = () => {
                    disposal ??= (async () => {
                      if (disposed) return;
                      disposed = true;
                      signal.removeEventListener('abort', disposeOnAbort);
                      const results = await Promise.allSettled([
                        selectedClient.dispose(),
                        currentLease.release(),
                      ]);
                      const failures = results.flatMap((result) =>
                        result.status === 'rejected' ? [result.reason] : [],
                      );
                      if (failures.length === 1) {
                        throw failures[0];
                      }
                      if (failures.length > 1) {
                        throw new AggregateError(
                          failures,
                          'Retained Runner MCP client cleanup failed',
                        );
                      }
                    })();
                    return disposal;
                  };
                  const disposeOnAbort = () => {
                    void dispose().catch(() => {});
                  };
                  if (signal.aborted) disposeOnAbort();
                  else
                    signal.addEventListener('abort', disposeOnAbort, {
                      once: true,
                    });
                  releaseCurrentLease = false;
                  return Object.freeze({
                    listTools: selectedClient.listTools,
                    callTool: selectedClient.callTool,
                    listResources: selectedClient.listResources,
                    listResourceTemplates: selectedClient.listResourceTemplates,
                    readResource: selectedClient.readResource,
                    subscribeResource: selectedClient.subscribeResource,
                    listPrompts: selectedClient.listPrompts,
                    getPrompt: selectedClient.getPrompt,
                    dispose,
                  });
                } finally {
                  if (releaseCurrentLease) {
                    await currentLease.release();
                  }
                }
              },
            });
          const withCurrentGlobalExternalSessions = async <T>(
            operation: (
              service: RunnerDaemonCurrentGlobalExternalSessionsOwner,
            ) => Promise<T>,
          ): Promise<T> => {
            const currentLease =
              await acquireDaemonPluginRuntimeRegistryLease();
            try {
              const createCurrentExternalSessions =
                currentLease.registry
                  .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
              if (!createCurrentExternalSessions) {
                throw new PluginError({
                  code: 'plugin_services_retained_generation_unavailable',
                  message:
                    'Retained Runner current-global External Sessions are unavailable',
                });
              }
              return await operation(
                await createCurrentExternalSessions({
                  binding: retainedAgent,
                  runnerSnapshotIdentity: runner.snapshotIdentity,
                  sessionId,
                  correlationId: invocationId,
                  signal,
                  isOccurrenceCurrent: () => authorizeOperation(undefined),
                }),
              );
            } finally {
              await currentLease.release();
            }
          };
          const currentGlobalExternalSessions: RunnerDaemonCurrentGlobalExternalSessionsOwner =
            Object.freeze({
              async capabilities(options) {
                return await withCurrentGlobalExternalSessions(
                  async (service) => await service.capabilities(options),
                );
              },
              async list(query, options) {
                return await withCurrentGlobalExternalSessions(
                  async (service) => await service.list(query, options),
                );
              },
              async closeList(cursor, options) {
                await withCurrentGlobalExternalSessions(
                  async (service) => await service.closeList(cursor, options),
                );
              },
              async attach(ref, options) {
                return await withCurrentGlobalExternalSessions(
                  async (service) => await service.attach(ref, options),
                );
              },
              async readTranscript(ref, query, options) {
                return await withCurrentGlobalExternalSessions(
                  async (service) =>
                    await service.readTranscript(ref, query, options),
                );
              },
              async followTranscript(ref, options, listener) {
                const currentLease =
                  await acquireDaemonPluginRuntimeRegistryLease();
                let releaseCurrentLease = true;
                try {
                  const createCurrentExternalSessions =
                    currentLease.registry
                      .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
                  if (!createCurrentExternalSessions) {
                    throw new PluginError({
                      code: 'plugin_services_retained_generation_unavailable',
                      message:
                        'Retained Runner current-global External Sessions are unavailable',
                    });
                  }
                  const followed = await (
                    await createCurrentExternalSessions({
                      binding: retainedAgent,
                      runnerSnapshotIdentity: runner.snapshotIdentity,
                      sessionId,
                      correlationId: invocationId,
                      signal,
                      isOccurrenceCurrent: () => authorizeOperation(undefined),
                    })
                  ).followTranscript(ref, options, listener);
                  if (followed.status === 'unavailable') {
                    return followed;
                  }
                  let disposal: Promise<void> | null = null;
                  const dispose = () => {
                    disposal ??= (async () => {
                      signal.removeEventListener('abort', disposeOnAbort);
                      const results = await Promise.allSettled([
                        followed.subscription.dispose(),
                        currentLease.release(),
                      ]);
                      const failures = results.flatMap((result) =>
                        result.status === 'rejected' ? [result.reason] : [],
                      );
                      if (failures.length === 1) {
                        throw failures[0];
                      }
                      if (failures.length > 1) {
                        throw new AggregateError(
                          failures,
                          'Retained Runner External Sessions follow cleanup failed',
                        );
                      }
                    })();
                    return disposal;
                  };
                  const disposeOnAbort = () => {
                    void dispose().catch(() => {});
                  };
                  if (signal.aborted) disposeOnAbort();
                  else
                    signal.addEventListener('abort', disposeOnAbort, {
                      once: true,
                    });
                  releaseCurrentLease = false;
                  return Object.freeze({
                    status: 'following' as const,
                    startingCursor: followed.startingCursor,
                    subscription: Object.freeze({
                      dispose,
                    }),
                  });
                } finally {
                  if (releaseCurrentLease) {
                    await currentLease.release();
                  }
                }
              },
              async takeover(ref, request, options) {
                return await withCurrentGlobalExternalSessions(
                  async (service) =>
                    await service.takeover(ref, request, options),
                );
              },
            });
          const invocationRetainsRegistryLease = managedProvider !== null;
          const nativeLaunchOperation = runSnapshot ? undefined : tracked.projectSetupOperation;
          let projectLaunchInvocation: ReturnType<typeof createRunnerAgentProjectLaunchInvocation> | undefined;
          const prepareAgentNativeLaunch: ReturnType<typeof createRunnerAgentProjectLaunchInvocation>['prepareAgentNativeLaunch'] = async (...args) => {
            if (!projectLaunchInvocation) {
              // Resume and Account refresh may leave no current context on the
              // tracked runner. The existing Session resolver owns recovery;
              // demand it only when an actual native launch is authorized.
              const requester = params.resolveRequesterSessionRuntimeContext
                ? await resolveSessionAccountContext(sessionId, undefined, args[0])
                : tracked.requesterSessionRuntimeContext;
              try {
                signal.throwIfAborted();
                if (params.pidToTrackedSession.get(tracked.pid) !== tracked || tracked.reportMarkerCustody?.retiring === true
                  || requester && tracked.requesterSessionRuntimeContext !== requester) {
                  throw new PluginError({ code: 'project_requester_credentials_unavailable', message: 'Run controller custody is unavailable' });
                }
                const callRunControl = async (method: string) => {
                  if (!requester || !await requester.isCurrent()) throw new PluginError({
                    code: 'project_requester_credentials_unavailable', message: 'Run controller custody is unavailable' });
                  // This is the existing Session's Run controller, under the
                  // admitted requester Home and encryption owner. No Run state
                  // or lifecycle decision is retained in the daemon projection.
                  return await withSessionAccountHome(requester, async () => {
                    const credentials = requester.bootstrap.credentials;
                    const controlSignal = shutdownCancellationDomains.daemonWorkSignal;
                    const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId, signal: controlSignal });
                    if (!transport.ok || transport.sessionId !== sessionId) throw new PluginError({
                      code: 'execution_run_target_unavailable', message: 'Run controller transport is unavailable' });
                    const rpc = { token: credentials.token, sessionId, method: `${sessionId}:${method}`,
                      request: { runId: invocationId }, signal: controlSignal, timeoutMs: null };
                    return transport.mode === 'plain' ? await callSessionRpc({ ...rpc, mode: 'plain' })
                      : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: transport.ctx });
                  });
                };
                projectLaunchInvocation ??= createRunnerAgentProjectLaunchInvocation({
                  cwd: invocationContext.cwd, signal, sessionId,
                  ...(runSnapshot ? { executionRun: { runId: invocationId,
                    read: async () => ExecutionRunGetResponseSchema.parse(await callRunControl(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).run,
                    stop: async () => ExecutionRunStopResponseSchema.parse(await callRunControl(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)),
                  } } : {}),
                  ...(nativeLaunchOperation ? { operation: nativeLaunchOperation } : {}),
                  ...(requester ? { requester } : {}),
                  references: {
                    ...(invocationContext.profileId ? { profileId: invocationContext.profileId } : {}),
                    ...(invocationContext.secretReferenceOverlay ? { secretReferenceOverlay: invocationContext.secretReferenceOverlay } : {}),
                  },
                  isCurrent: () => authorizeOperation(undefined, { recordRefusal: true }),
                  ...(!requester ? { resolveInstalledAccountRuntime: async (requestSignal: AbortSignal) => {
                    const refuse = (reason: 'requester_unknown' | 'requester_separated' | 'machine_client_unavailable'
                      | 'finite_runtime_unavailable' | 'account_mismatch' | 'machine_mismatch'
                      | 'credentials_mismatch' | 'home_url_mismatch' | 'origin_retired'): null => {
                      try { logger.warnLocalFile(JSON.stringify({ kind: 'plugin_exec_installed_account_refused',
                        phase: 'installed_account_qualification', reason, sessionId })); } catch { /* Logging cannot mask the typed refusal. */ }
                      return null;
                    };
                    const identity = await resolveIsolationIdentity(requestSignal);
                    if (identity.kind !== 'isolated') return refuse('requester_unknown');
                    if (identity.separationRequired) return refuse('requester_separated');
                    const machine = params.getApiMachineForSessions();
                    if (!machine) return refuse('machine_client_unavailable');
                    const runtime = await machine.resolveProjectFiniteRuntime({ signal: requestSignal });
                    if (!runtime) return refuse('finite_runtime_unavailable');
                    if (runtime.accountId !== identity.requester.accountId) return refuse('account_mismatch');
                    if (runtime.machineId !== identity.requester.machineId) return refuse('machine_mismatch');
                    if (!sameStoredCredentials(params.credentials, runtime.credentials)) return refuse('credentials_mismatch');
                    if (normalizeServerHttpBaseUrl(runtime.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(params.serverBaseUrl)) return refuse('home_url_mismatch');
                    if (!await isolationStillCurrent(requestSignal)) return refuse('origin_retired');
                    return runtime;
                  } } : {}),
                  resolveRuntime: async ingress => {
                    const machine = params.getApiMachineForSessions();
                    if (!machine) {
                      logger.debug('[ProjectFinite] Runtime resolution refused', { reason: 'machine_client_unavailable', sessionId });
                      return null;
                    }
                    return await machine.resolveProjectFiniteRuntime(ingress);
                  },
                });
              } finally {
                await releaseSessionAccountContext(requester ?? null);
              }
            }
            return await projectLaunchInvocation.prepareAgentNativeLaunch(...args);
          };
          // Account/Session custody is independent of whether this Machine has
          // an optional native isolation policy/transport port installed.
          const isolationOrigin = await params.resolveCurrentMachineExecutionOriginContext?.(signal) ?? null;
          const isolationAttribution = tracked.requesterWorkAttributionV1 ?? tracked.spawnOptions?.requesterWorkAttributionV1;
          const { resolve: resolveIsolationIdentity, isCurrent: isolationStillCurrent } = createRunnerIsolationIdentity({
            signal, serverId: params.serverId, serverBaseUrl: params.serverBaseUrl, machineId: params.machineId,
            sessionId, credentials: params.credentials, custodianAccountId: params.externalActionAccountId,
            tracked, origin: isolationOrigin, readOrigin: params.resolveCurrentMachineExecutionOriginContext,
            isCurrent: () => authorizeOperation(undefined) && params.pidToTrackedSession.get(tracked.pid) === tracked
              && tracked.reportMarkerCustody?.retiring !== true,
            ...(params.resolveRequesterSessionRuntimeContext ? { resolveRuntime: (requestSignal: AbortSignal) =>
              resolveSessionAccountContext(sessionId, isolationAttribution, requestSignal) } : {}),
            releaseRuntime: releaseSessionAccountContext,
          });
          if (!invocationRetainsRegistryLease) {
            await lease.release();
          }
          releaseLease = false;
          releaseManagedProviderInvocation = false;
          return {
            ...invocationProjection,
            prepareAgentNativeLaunch,
            agentIsolation: createAgentIsolationSessionContext({
              machine: params.agentIsolation, managedHappierBinaryPath: params.agentIsolation?.managedHappierBinaryPath,
              sessionRequester: tracked.requesterWorkAttributionV1,
              sessionRequesterHomeServerIdentityId: tracked.requesterSessionRuntimeContext?.bootstrap.homeServerIdentityId,
              sessionCustodianAccountId: params.externalActionAccountId,
              hostHomeServerIdentityId: isolationOrigin?.machineId === params.machineId ? isolationOrigin.serverIdentityId : null,
              resolveRequesterIdentity: resolveIsolationIdentity,
              readMaterial: () => (runSnapshot ? connectedServiceRuntimeRegistry.getRunTargetByRunKey(invocationId)
                : connectedServiceRuntimeRegistry.getBySessionId(sessionId))?.agentLaunchMaterials,
            }),
            ...(managedProvider ? { managedProvider } : {}),
            authorizeOperation,
            authorizeManagedProviderMaterialization:
              isCapturedAgentRegistrationPreOpen,
            executeCurrentGlobalAction,
            currentGlobalMcp,
            currentGlobalExternalSessions,
            dispose: async () => {
              await projectLaunchInvocation?.disposeProjectAgentLaunch();
              await cleanupManagedProvider();
              if (invocationRetainsRegistryLease) {
                await lease.release();
              }
            },
          };
        } finally {
          if (releaseManagedProviderInvocation) {
            await cleanupManagedProvider();
          }
          if (releaseLease) {
            await lease.release();
          }
        }
      } catch (error) {
        throw createRunnerDaemonPluginServicesPreparationError(error, preparationStage);
      }
    },
  });
}
