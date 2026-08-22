import type {
  PackedManagedProviderPreparedInput,
  PackedManagedProviderScenarioDependencies,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';

export type PackedManagedProviderWrapperObservation = Readonly<{
  publicActivationReasons: readonly ('explicitStartLocal' | 'catalogProbe')[];
  explicitStartContributionKey: string;
  explicitStartPhase: 'detecting' | 'running';
  catalogConnectionId: string;
  catalogModelIds: readonly string[];
  catalogRequestFingerprint: string;
  catalogOwnerReleased: boolean;
  publicObservationContainsCredential: boolean;
  providerAttemptedBeforeSessionDemand: boolean;
  credentialSentinelObserved: boolean;
}>;

export type PackedManagedProviderFreshSpawnObservation = Readonly<{
  publicActivationReason: 'sessionDemand';
  spawnRequestIncludedSessionId: boolean;
  returnedSessionId: string;
  publicSessionId: string;
  upstreamRequestsBeforeCanonicalSession: number;
  managedPurpose: string;
  agentPurpose: string;
  connectionRevision: number;
  credentialRevision: string;
  upstreamAuthorizationFingerprint: string;
  managedRequestAuthOrigin: string;
  upstreamConnectTarget: string;
  currentAccessTokenFingerprint: string;
  promptSentinelObserved: boolean;
  upstreamRequestPath: string;
  timeline: Readonly<{
    freshSpawnStartedAtMs: number;
    canonicalSessionRegisteredAtMs: number;
    spawnAcknowledgedAtMs: number;
    providerAttemptAtMs: number;
  }>;
  observedPorts: Readonly<{
    server: number;
    serverProxy: number;
    daemon: number;
    upstreamProxy: number;
  }>;
  stockPortRequestCount: number;
  stockPortOsConnectionAttemptCount: number;
  stockListenerIdentityBefore: string;
  stockListenerIdentityAfter: string;
  providerProcess: Readonly<{
    pid: number;
    executablePath: string;
    executableMatchedCandidate: boolean;
  }>;
  providerProcessCountForSessionDemand: number;
}>;

export type PackedManagedProviderActivationFailureObservation = Readonly<{
  publicActivationReason: 'sessionDemand';
  activationRefused: boolean;
  spawnAcknowledged: boolean;
  firstInputDispatched: boolean;
  providerAttemptStarted: boolean;
  stockPortOsConnectionAttemptCount: number;
  stockListenerIdentityBefore: string;
  stockListenerIdentityAfter: string;
  cleanup: Readonly<{
    failedSessionAbsent: boolean;
    activeSessionAbsent: boolean;
    sessionProviderExited: boolean;
    noPostStopProviderAttempt: boolean;
  }>;
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
        observed.publicActivationReasons.length === 2
          && observed.publicActivationReasons[0] === 'explicitStartLocal'
          && observed.publicActivationReasons[1] === 'catalogProbe',
        'packed_managed_provider_public_activation_reasons_mismatch',
      );
      assert(
        observed.explicitStartContributionKey
          === 'happier.provider.cliproxyapi/cliproxyapi'
          && observed.explicitStartPhase === 'running',
        'packed_managed_provider_public_explicit_start_mismatch',
      );
      assert(
        observed.catalogConnectionId.length > 0
          && observed.catalogModelIds.includes('gpt-5.5')
          && observed.catalogRequestFingerprint.length > 0
          && observed.catalogOwnerReleased,
        'packed_managed_provider_public_catalog_probe_mismatch',
      );
      assert(
        !observed.publicObservationContainsCredential
          && !observed.providerAttemptedBeforeSessionDemand
          && !observed.credentialSentinelObserved,
        'packed_managed_provider_public_preactivation_boundary_failed',
      );
      return {
        publicExplicitStart: true,
        publicCatalogProbe: true,
        catalogOwnerReleased: true,
        publicCredentialLeakObserved: false,
        providerAttemptedBeforeSessionDemand: false,
      };
    },
    runFreshManagedSequence: async (input) => {
      const observed = await system.probeFreshManagedSpawn(input);
      assert(
        observed.publicActivationReason === 'sessionDemand'
          && !observed.spawnRequestIncludedSessionId,
        'packed_managed_provider_fresh_spawn_preallocated_session_id',
      );
      assert(
        observed.returnedSessionId.length > 0
          && observed.returnedSessionId === observed.publicSessionId,
        'packed_managed_provider_canonical_session_identity_mismatch',
      );
      assert(
        observed.upstreamRequestsBeforeCanonicalSession === 0,
        'packed_managed_provider_preactivation_boundary_failed',
      );
      assert(
        observed.managedPurpose === 'openai-upstream'
          && observed.agentPurpose === 'openai-codex-model-request'
          && Number.isInteger(observed.connectionRevision)
          && observed.connectionRevision > 0,
        'packed_managed_provider_purpose_binding_failed',
      );
      assert(
        observed.upstreamAuthorizationFingerprint
            === observed.currentAccessTokenFingerprint,
        'packed_managed_provider_stale_credential_revision',
      );
      assert(
        observed.promptSentinelObserved
          && observed.managedRequestAuthOrigin === 'https://chatgpt.com'
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
        observed.providerProcess.executableMatchedCandidate
          && observed.providerProcess.pid > 0
          && observed.providerProcess.executablePath.length > 0
          && observed.providerProcessCountForSessionDemand === 1,
        'packed_managed_provider_public_session_owner_mismatch',
      );

      return {
        freshSession: true,
        agentId: 'opencode',
        canonicalSessionId: observed.returnedSessionId,
        purposes: [
          `happier.agent.opencode/opencode:${observed.agentPurpose}`,
          `happier.provider.cliproxyapi/cliproxyapi:${observed.managedPurpose}`,
        ],
        publicActivationReason: observed.publicActivationReason,
        connectionRevision: observed.connectionRevision,
        timeline: observed.timeline,
        observedPorts: observed.observedPorts,
        stockPortRequestCount: observed.stockPortRequestCount,
        stockPortOsConnectionAttemptCount:
          observed.stockPortOsConnectionAttemptCount,
        stockListenerIdentityBefore: observed.stockListenerIdentityBefore,
        stockListenerIdentityAfter: observed.stockListenerIdentityAfter,
        preSessionDemandCredentialReleased: false,
        preSessionDemandUpstreamAttempted: false,
        upstreamAuthorizationFingerprint:
          observed.upstreamAuthorizationFingerprint,
        managedRequestAuthOrigin: observed.managedRequestAuthOrigin,
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
      assert(
        observed.cleanup.failedSessionAbsent
          && observed.cleanup.activeSessionAbsent
          && observed.cleanup.sessionProviderExited
          && observed.cleanup.noPostStopProviderAttempt,
        'packed_managed_provider_activation_failure_cleanup_incomplete',
      );
      return {
        activationFailedBeforeAck: true,
        firstInputDispatched: false,
        providerAttempted: false,
        publicSessionCleanupComplete: true,
        sessionProviderExited: true,
      };
    },
    cleanup: async (input) => {
      await system.cleanup(input);
    },
  };
}
