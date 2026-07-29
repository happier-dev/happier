import type {
  PackedManagedProviderPreparedInput,
  PackedManagedProviderScenarioDependencies,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';

type CleanupObservation = Readonly<{
  agentCapabilityAbsent: boolean;
  managedCapabilityAbsent: boolean;
  providerMaterializationAbsent: boolean;
  sessionMarkerAbsent: boolean;
  wrapperStopped: boolean;
  wrapperPidExited: boolean;
}>;

export type PackedManagedProviderWrapperObservation = Readonly<{
  buildVersion: string;
  contractVersion: string;
  sdkVersion: string;
  materializationId: string;
  protocolCount: number;
  purposeCount: number;
  modelListEnabled: boolean;
  readinessIdentityMatched: boolean;
  healthStatus: number;
  modelStatus: number;
  managementStatus: number;
  preactivationStatus: number;
  capabilityFileCreated: boolean;
  requestAuthRequests: number;
  upstreamRequests: number;
  credentialSentinelObserved: boolean;
  runtimeEntriesAfterStop: readonly string[];
  wrapperStopped: boolean;
}>;

export type PackedManagedProviderFreshSpawnObservation = Readonly<{
  spawnRequestIncludedSessionId: boolean;
  returnedSessionId: string;
  markerSessionId: string;
  wrapperReadyBeforeCanonicalSession: boolean;
  capabilityPresentBeforeCanonicalSession: boolean;
  agentCapabilityPresentBeforeCanonicalSession: boolean;
  requestAuthRequestsBeforeCanonicalSession: number;
  upstreamRequestsBeforeCanonicalSession: number;
  managedPurpose: string;
  agentPurpose: string;
  managedCapabilityScopeDigest: string;
  agentCapabilityScopeDigest: string;
  credentialRevision: string;
  leaseCredentialRevision: string;
  managedLeaseAccessTokenFingerprint: string;
  upstreamAuthorizationFingerprint: string;
  managedRequestAuthOrigin: string;
  managedConnectionSecurityFingerprint: string;
  upstreamConnectTarget: string;
  currentAccessTokenFingerprint: string;
  promptSentinelObserved: boolean;
  upstreamRequestPath: string;
  timeline: Readonly<{
    freshSpawnStartedAtMs: number;
    canonicalSessionRegisteredAtMs: number;
    canonicalWebhookAcknowledgedAtMs: number;
    capabilitiesActivatedAtMs: number;
    spawnAcknowledgedAtMs: number;
    agentRequestAuthLookupAtMs: number;
    agentRequestAuthLookupCompletedAtMs: number;
    managedRequestAuthLookupAtMs: number;
    managedRequestAuthLookupCompletedAtMs: number;
    providerAttemptAtMs: number;
  }>;
  observedPorts: Readonly<{
    server: number;
    serverProxy: number;
    daemon: number;
    brokerProxy: number;
    upstreamProxy: number;
    wrapper: number;
  }>;
  stockPortRequestCount: number;
  stockPortOsConnectionAttemptCount: number;
  stockListenerIdentityBefore: string;
  stockListenerIdentityAfter: string;
  wrapperHealthStatus: number;
  wrapperAliveAfterSpawnAcknowledgement: boolean;
  providerMaterializationPresentAfterSpawnAcknowledgement: boolean;
  sessionMarkerPresentAfterSpawnAcknowledgement: boolean;
  cleanup: CleanupObservation;
}>;

export type PackedManagedProviderActivationFailureObservation = Readonly<{
  activationRefused: boolean;
  spawnAcknowledged: boolean;
  firstInputDispatched: boolean;
  providerAttemptStarted: boolean;
  stockPortOsConnectionAttemptCount: number;
  stockListenerIdentityBefore: string;
  stockListenerIdentityAfter: string;
  cleanup: CleanupObservation;
}>;

export type PackedManagedProviderLiveSystem = Readonly<{
  probePackagedWrapper(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderWrapperObservation>;
  probeFreshManagedSpawn(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderFreshSpawnObservation>;
  probeActivationFailureCleanup(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderActivationFailureObservation>;
  cleanup(
    input: Parameters<PackedManagedProviderScenarioDependencies['cleanup']>[0],
  ): Promise<void>;
}>;

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function assertCompleteCleanup(
  cleanup: CleanupObservation,
  context: string,
): void {
  assert(cleanup.agentCapabilityAbsent, `${context}_agent_capability_retained`);
  assert(cleanup.managedCapabilityAbsent, `${context}_managed_capability_retained`);
  assert(
    cleanup.providerMaterializationAbsent,
    `${context}_provider_materialization_retained`,
  );
  assert(cleanup.sessionMarkerAbsent, `${context}_session_marker_retained`);
  assert(cleanup.wrapperStopped, `${context}_wrapper_running`);
  assert(cleanup.wrapperPidExited, `${context}_wrapper_pid_alive`);
}

function createDefaultPackedManagedProviderLiveSystem():
PackedManagedProviderLiveSystem {
  let systemPromise: Promise<PackedManagedProviderLiveSystem> | null = null;
  const system = async (): Promise<PackedManagedProviderLiveSystem> => {
    systemPromise ??= import('./packedManagedProviderLiveSystem')
      .then((module) =>
        module.createCanonicalPackedManagedProviderLiveSystem());
    return await systemPromise;
  };
  return {
    probePackagedWrapper: async (input) =>
      await (await system()).probePackagedWrapper(input),
    probeFreshManagedSpawn: async (input) =>
      await (await system()).probeFreshManagedSpawn(input),
    probeActivationFailureCleanup: async (input) =>
      await (await system()).probeActivationFailureCleanup(input),
    cleanup: async (input) =>
      await (await system()).cleanup(input),
  };
}

export function createPackedManagedProviderLiveScenario(
  system: PackedManagedProviderLiveSystem =
    createDefaultPackedManagedProviderLiveSystem(),
): PackedManagedProviderScenarioDependencies {
  return {
    runPackagedWrapperConformance: async (input) => {
      const observed = await system.probePackagedWrapper(input);
      assert(
        observed.buildVersion === input.prepared.candidate.cli.version,
        'packed_managed_provider_wrapper_build_version_mismatch',
      );
      assert(
        observed.contractVersion === 'happier.cliproxyapi-managed/v1'
          && observed.sdkVersion === 'v7.2.95'
          && observed.materializationId === 'packed-materialization'
          && observed.protocolCount === 1
          && observed.purposeCount === 1
          && observed.modelListEnabled
          && observed.readinessIdentityMatched,
        'packed_managed_provider_wrapper_health_identity_mismatch',
      );
      assert(observed.healthStatus === 200, 'packed_managed_provider_wrapper_health_failed');
      assert(
        observed.modelStatus === 200,
        'packed_managed_provider_wrapper_model_catalog_failed',
      );
      assert(
        observed.managementStatus === 404,
        'packed_managed_provider_wrapper_management_surface_exposed',
      );
      assert(
        observed.preactivationStatus >= 400,
        'packed_managed_provider_wrapper_preactivation_request_succeeded',
      );
      assert(
        !observed.capabilityFileCreated
          && observed.requestAuthRequests === 0
          && observed.upstreamRequests === 0
          && !observed.credentialSentinelObserved,
        'packed_managed_provider_wrapper_released_preactivation_authority',
      );
      assert(
        observed.runtimeEntriesAfterStop.length === 0 && observed.wrapperStopped,
        'packed_managed_provider_wrapper_cleanup_incomplete',
      );
      return {
        tokenFreeReadiness: true,
        preActivationLookupRefused: true,
        preActivationCredentialReleased: false,
        preActivationUpstreamAttempted: false,
      };
    },
    runFreshManagedSequence: async (input) => {
      const observed = await system.probeFreshManagedSpawn(input);
      assert(
        !observed.spawnRequestIncludedSessionId,
        'packed_managed_provider_fresh_spawn_preallocated_session_id',
      );
      assert(
        observed.returnedSessionId.length > 0
          && observed.returnedSessionId === observed.markerSessionId,
        'packed_managed_provider_canonical_session_identity_mismatch',
      );
      assert(
        observed.wrapperReadyBeforeCanonicalSession
          && !observed.capabilityPresentBeforeCanonicalSession
          && !observed.agentCapabilityPresentBeforeCanonicalSession
          && observed.requestAuthRequestsBeforeCanonicalSession === 0
          && observed.upstreamRequestsBeforeCanonicalSession === 0,
        'packed_managed_provider_preactivation_boundary_failed',
      );
      assert(
        observed.managedPurpose === 'openai-upstream'
          && observed.agentPurpose === 'openai-codex-model-request'
          && /^[a-f0-9]{64}$/u.test(observed.managedCapabilityScopeDigest)
          && /^[a-f0-9]{64}$/u.test(observed.agentCapabilityScopeDigest)
          && observed.managedCapabilityScopeDigest
            !== observed.agentCapabilityScopeDigest,
        'packed_managed_provider_purpose_binding_failed',
      );
      assert(
        observed.credentialRevision === observed.leaseCredentialRevision
          && observed.managedLeaseAccessTokenFingerprint
            === observed.currentAccessTokenFingerprint
          && observed.upstreamAuthorizationFingerprint
            === observed.currentAccessTokenFingerprint,
        'packed_managed_provider_stale_credential_revision',
      );
      assert(
        observed.promptSentinelObserved
          && observed.managedRequestAuthOrigin === 'https://chatgpt.com'
          && /^connection-security:v1:[A-Za-z0-9_-]{43}$/u.test(
            observed.managedConnectionSecurityFingerprint,
          )
          && observed.upstreamConnectTarget === 'chatgpt.com:443'
          && observed.upstreamRequestPath
            .startsWith('/backend-api/codex/'),
        'packed_managed_provider_first_prompt_upstream_unobserved',
      );
      assert(
        Object.values(observed.observedPorts)
          .every((port) => Number.isInteger(port) && port > 0 && port !== 8317)
          && new Set(Object.values(observed.observedPorts)).size
            === Object.values(observed.observedPorts).length
          && observed.stockPortRequestCount === 0
          && observed.stockPortOsConnectionAttemptCount === 0
          && /^sha256:[a-f0-9]{64}$/u.test(
            observed.stockListenerIdentityBefore,
          )
          && observed.stockListenerIdentityAfter
            === observed.stockListenerIdentityBefore,
        'packed_managed_provider_stock_port_touched',
      );
      assert(
        observed.wrapperHealthStatus === 200
          && observed.wrapperAliveAfterSpawnAcknowledgement
          && observed.providerMaterializationPresentAfterSpawnAcknowledgement
          && observed.sessionMarkerPresentAfterSpawnAcknowledgement,
        'packed_managed_provider_live_resources_missing_after_ack',
      );
      assertCompleteCleanup(observed.cleanup, 'packed_managed_provider_success_cleanup');

      return {
        freshSession: true,
        agentId: 'opencode',
        canonicalSessionIdBeforeWebhook: null,
        canonicalSessionId: observed.returnedSessionId,
        purposes: [
          `happier.agent.opencode/opencode:${observed.agentPurpose}`,
          `happier.provider.cliproxyapi/cliproxyapi:${observed.managedPurpose}`,
        ],
        capabilityScopeDigests: [
          observed.agentCapabilityScopeDigest,
          observed.managedCapabilityScopeDigest,
        ],
        timeline: observed.timeline,
        observedPorts: observed.observedPorts,
        stockPortRequestCount: observed.stockPortRequestCount,
        stockPortOsConnectionAttemptCount:
          observed.stockPortOsConnectionAttemptCount,
        stockListenerIdentityBefore: observed.stockListenerIdentityBefore,
        stockListenerIdentityAfter: observed.stockListenerIdentityAfter,
        preActivationCredentialReleased: false,
        preActivationUpstreamAttempted: false,
        preActivationAgentCapabilityPresent:
          observed.agentCapabilityPresentBeforeCanonicalSession,
        managedLeaseCredentialRevision: observed.leaseCredentialRevision,
        managedLeaseAccessTokenFingerprint:
          observed.managedLeaseAccessTokenFingerprint,
        upstreamAuthorizationFingerprint:
          observed.upstreamAuthorizationFingerprint,
        managedRequestAuthOrigin: observed.managedRequestAuthOrigin,
        managedConnectionSecurityFingerprint:
          observed.managedConnectionSecurityFingerprint,
        upstreamConnectTarget: observed.upstreamConnectTarget,
        promptSentinelObserved: observed.promptSentinelObserved,
        upstreamRequestPath: observed.upstreamRequestPath,
        currentCredentialRevision: observed.credentialRevision,
        currentAccessTokenFingerprint:
          observed.currentAccessTokenFingerprint,
      };
    },
    runActivationFailureCleanupProbe: async (input) => {
      const observed = await system.probeActivationFailureCleanup(input);
      assert(
        observed.activationRefused && !observed.spawnAcknowledged,
        'packed_managed_provider_activation_failure_not_refused_before_ack',
      );
      assert(
        !observed.firstInputDispatched && !observed.providerAttemptStarted,
        'packed_managed_provider_activation_failure_leaked_work',
      );
      assert(
        /^sha256:[a-f0-9]{64}$/u.test(
          observed.stockListenerIdentityBefore,
        )
          && observed.stockPortOsConnectionAttemptCount === 0
          && observed.stockListenerIdentityAfter
            === observed.stockListenerIdentityBefore,
        'packed_managed_provider_activation_failure_stock_port_touched',
      );
      assertCompleteCleanup(
        observed.cleanup,
        'packed_managed_provider_activation_failure_cleanup',
      );
      return {
        activationFailedBeforeAck: true,
        firstInputDispatched: false,
        providerAttempted: false,
        wrapperStopped: true,
        capabilityRetired: true,
        materializationRemoved: true,
      };
    },
    cleanup: async (input) => {
      await system.cleanup(input);
    },
  };
}
