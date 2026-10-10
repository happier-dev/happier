import type {
  BridgeLifecycleHookEventIdV1,
  BackendTargetRefV2Input,
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  HookScopeV1,
  RuntimeDescriptorV1,
  SessionStateCapabilitiesV1,
} from '@happier-dev/protocol';
import { SessionStateCapabilitiesV1Schema } from '@happier-dev/protocol/sessions/state/capabilitySchema';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtimeDescriptorV1';

import {
  resolveBackendEngineAdapterResolution,
  resolveBackendExecutionSurfaces,
  resolveEngineBackendIdForCatalogAgent,
  type BackendExecutionSurfaces,
} from '@/agent/runtime/registry/engineRegistry';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { buildRuntimePublicationFromEngineResolution } from '@/agent/runtime/identity/buildRuntimePublicationFromEngineResolution';
import type {
  ProviderMessageMetaEnricher,
} from '@happier-dev/agents';
import {
  evaluateCliSessionAttachEligibility,
  type CliSessionAttachEligibility,
} from '@/session/attach/evaluateCliSessionAttachEligibility';
import {
  resolveContinueWithReplayBackendTarget,
  type ContinueWithReplayBackendTargetResolution,
} from '@/session/replay/resolveContinueWithReplayBackendTarget';
import {
  resolveSessionForkBackendTarget,
  type SessionForkBackendTargetResolution,
} from '@/session/fork/backendTarget';
import {
  resolveSessionHandoffEligibility,
  type SessionHandoffEligibility,
} from '@/session/handoff/resolveSessionHandoffEligibility';
import {
  canonicalizeLinkedExternalSessionSource,
  resolveExternalSessionLinkIdentity,
  type CanonicalizedExternalSessionSourceResult,
} from './externalSessionSourceCanonicalization';
import { emitBridgeLifecycleHookEventBestEffort } from '@/agent/runtime/bridges/_shared/emitBridgeLifecycleHookEventBestEffort';
import type {
  CurrentCatalogAgentExecutionSurfaces,
  SessionHostBridgeContract,
} from './sessionBridgeContract';
import type { ExternalSessionLinkIdentity } from '@/session/external/providerOps';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { throwIfPluginRuntimeStartBlocked } from '@/agent/runtime/registry/throwIfPluginRuntimeStartBlocked';
import { withHostSessionRuntimeIdentityPublication } from '@/agent/runtime/identity/publication/withHostSession';
import {
  HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import {
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import {
  createRunnerAgentSessionRuntimeBootstrap,
} from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { configuration } from '@/configuration';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { logger } from '@/ui/logger';

type SessionHostRunOptions = Readonly<{
  beforeRuntimePlanCommit?: () => void | Promise<void>;
  agentRuntimeRunnerBootstrapFilePath?: string;
  agentRuntimeDaemonServiceAuthorityFilePath?: string;
  /**
   * Exact host-owned plugin registry lease for a scoped process such as
   * Happier Runner. Its caller retains and releases custody; the bridge only
   * consumes the pinned registry and never falls back to the daemon singleton.
   */
  pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
  /**
   * Scoped host authority for an exact Team credential binding. This is
   * intentionally separate from the daemon runner source: the standalone
   * Runner already owns its pinned plugin runtime lease.
   */
  prepareTeamCredentialProviderBinding?: NonNullable<
    NonNullable<Parameters<typeof resolveBackendEngineAdapterResolution>[1]>[
      'prepareTeamCredentialProviderBinding'
    ]
  >;
}>;

/**
 * Canonical session host-bridge owner. The older March/plan-only `AgentSessionRuntimeBridge` /
 * `createSessionRuntimeBridge.ts` naming is superseded by this class plus the shared
 * session-loop lifecycle and session-control helpers.
 */
export class SessionHostBridge implements SessionHostBridgeContract {
  private async requireCanonicalSessionRuntime(runtime: unknown, backendId: string) {
    const { isHostSessionRuntimePlan } = await import('@/agent/runtime/session/loop/lifecycle');
    if (isHostSessionRuntimePlan(runtime)) {
      return runtime;
    }
    throw new Error(
      `Backend '${backendId}' must return HostSessionRuntimePlan from runtimeCore.createSessionRuntime(...)`,
    );
  }

  async resolveExecutionSurfaces(backendId?: string | null): Promise<BackendExecutionSurfaces> {
    return await resolveBackendExecutionSurfaces(backendId);
  }

  async resolveCurrentExecutionSurfacesForCatalogAgent(
    agentId: string,
  ): Promise<CurrentCatalogAgentExecutionSurfaces | null> {
    const initialSnapshot = readAgentCatalogSnapshot();
    const backendId = resolveEngineBackendIdForCatalogAgent(initialSnapshot, agentId);
    const agentTarget = AgentExecutionTargetV1Schema.safeParse({
      kind: 'agent',
      identity: initialSnapshot.agentDefinitionsById.get(agentId)?.identity,
    });
    if (!backendId || !agentTarget.success) return null;

    const executionSurfaces = await this.resolveExecutionSurfaces(backendId);
    const currentSnapshot = readAgentCatalogSnapshot();
    const currentBackendId = resolveEngineBackendIdForCatalogAgent(currentSnapshot, agentId);
    const currentAgentTarget = AgentExecutionTargetV1Schema.safeParse({
      kind: 'agent',
      identity: currentSnapshot.agentDefinitionsById.get(agentId)?.identity,
    });
    if (
      currentBackendId !== backendId
      || !currentAgentTarget.success
      || currentAgentTarget.data.identity.pluginId !== agentTarget.data.identity.pluginId
      || currentAgentTarget.data.identity.localId !== agentTarget.data.identity.localId
    ) return null;

    return Object.freeze({
      agentId,
      backendId,
      agentTarget: agentTarget.data,
      executionSurfaces,
    });
  }

  private async resolveEngineResolutionParams(
    backendId: string,
    params: unknown,
    hostOptions?: SessionHostRunOptions,
  ): Promise<Parameters<typeof resolveBackendEngineAdapterResolution>[1]> {
    if (!params || typeof params !== 'object') {
      return undefined;
    }
    const record = params as Readonly<Record<string, unknown>>;
    const resolutionParams: {
      agentTarget?: NonNullable<Parameters<typeof resolveBackendEngineAdapterResolution>[1]>['agentTarget'];
      startupRuntimeDescriptorV1?: RuntimeDescriptorV1;
      happyHomeDir?: string;
      runtimeRegistry?: PluginRuntimeRegistryLease['registry'];
      requireRunnerAgentSessionRuntimeSource?: boolean;
      runnerAgentSessionRuntimeSource?: NonNullable<
        Parameters<typeof resolveBackendEngineAdapterResolution>[1]
      >['runnerAgentSessionRuntimeSource'];
      prepareTeamCredentialProviderBinding?: NonNullable<
        Parameters<typeof resolveBackendEngineAdapterResolution>[1]
      >['prepareTeamCredentialProviderBinding'];
    } = {};

    if (record.agentTarget !== undefined) {
      resolutionParams.agentTarget = AgentExecutionTargetV1Schema.parse(record.agentTarget);
    }
    if (record.runtimeDescriptorV1 !== undefined) {
      resolutionParams.startupRuntimeDescriptorV1 = RuntimeDescriptorV1Schema.parse(record.runtimeDescriptorV1);
    }

    if (hostOptions?.pluginRuntimeRegistryLease) {
      resolutionParams.runtimeRegistry = hostOptions.pluginRuntimeRegistryLease.registry;
    }
    if (hostOptions?.prepareTeamCredentialProviderBinding) {
      resolutionParams.prepareTeamCredentialProviderBinding =
        hostOptions.prepareTeamCredentialProviderBinding;
    }

    const happyHomeDir = record.happyHomeDir;
    if (typeof happyHomeDir === 'string') {
      const trimmedHappyHomeDir = happyHomeDir.trim();
      if (trimmedHappyHomeDir.length > 0) {
        resolutionParams.happyHomeDir = trimmedHappyHomeDir;
      }
    }

    const startedBy = record.startedBy;
    const isDaemonStarted =
      typeof startedBy === 'string' && startedBy.trim() === 'daemon';
    const foregroundBootstrapFilePath =
      hostOptions?.agentRuntimeRunnerBootstrapFilePath?.trim() ?? '';
    if (isDaemonStarted || foregroundBootstrapFilePath) {
      resolutionParams.requireRunnerAgentSessionRuntimeSource = true;
      const bootstrapFilePath = (
        foregroundBootstrapFilePath
        || String(
          process.env[
            HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY
          ] ?? '',
        ).trim()
      );
      const authorityFilePath = (
        hostOptions?.agentRuntimeDaemonServiceAuthorityFilePath?.trim()
        || String(
          process.env[
            HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY
          ] ?? '',
        ).trim()
      );
      if (
        bootstrapFilePath
        && authorityFilePath
        && resolutionParams.happyHomeDir
      ) {
        const source = await createRunnerAgentSessionRuntimeBootstrap({
          happyHomeDir: resolutionParams.happyHomeDir,
          publicReleaseRing: configuration.publicReleaseRing,
          authorityFilePath,
          bootstrapFilePath,
        });
        if (source?.identity.backendId === backendId) {
          resolutionParams.runnerAgentSessionRuntimeSource = source;
        }
      }
    }

    return Object.keys(resolutionParams).length > 0 ? resolutionParams : undefined;
  }

  private injectProviderMessageMetaEnricher(
    params: unknown,
    enricher: ProviderMessageMetaEnricher | undefined,
  ): unknown {
    if (!enricher || typeof enricher.buildOutgoingMessageMetaExtras !== 'function') {
      return params;
    }
    if (!params || typeof params !== 'object') {
      return params;
    }
    const record = params as Record<string, unknown>;
    if ('providerMessageMetaEnricher' in record) {
      return params;
    }
    return { ...record, providerMessageMetaEnricher: enricher };
  }

  private resolveSessionStateCapabilities(resolution: Awaited<ReturnType<typeof resolveBackendEngineAdapterResolution>>): SessionStateCapabilitiesV1 {
    const facetCapabilities = resolution?.engineAdapter.facets?.sessionState?.capabilities;
    if (facetCapabilities) {
      const parsed = SessionStateCapabilitiesV1Schema.safeParse(facetCapabilities);
      return parsed.success ? parsed.data : {};
    }
    const backendCapabilities = resolution?.backend.capabilities as Readonly<Record<string, unknown>> | undefined;
    const sessionCapabilities = backendCapabilities?.session;
    const stateCapabilities = sessionCapabilities && typeof sessionCapabilities === 'object'
      ? (sessionCapabilities as Readonly<Record<string, unknown>>).state
      : undefined;
    const parsed = SessionStateCapabilitiesV1Schema.safeParse(stateCapabilities);
    return parsed.success ? parsed.data : {};
  }

  async createSessionRuntime(
    backendId: string,
    params: unknown,
    hostOptions?: SessionHostRunOptions,
  ) {
    const resolution = await resolveBackendEngineAdapterResolution(
      backendId,
      await this.resolveEngineResolutionParams(backendId, params, hostOptions),
    );
    if (!resolution) {
      throw new Error(`Unsupported session runtime backend: ${backendId}`);
    }
    throwIfPluginRuntimeStartBlocked(resolution);
    const hostScopedParams = hostOptions?.prepareTeamCredentialProviderBinding
      && params && typeof params === 'object'
      ? { ...(params as Readonly<Record<string, unknown>>), allowAttachedTeamCredentialBinding: true }
      : params;
    const injectedParams = this.injectProviderMessageMetaEnricher(hostScopedParams, resolution.engineAdapter.messageMeta);
    const runtime = await resolution.engineAdapter.runtimeCore.createSessionRuntime(injectedParams);
    const canonicalRuntime = await this.requireCanonicalSessionRuntime(runtime, backendId);
    const sessionStateFacet = resolution.engineAdapter.facets?.sessionState;
    const planWithSessionState = sessionStateFacet
      ? {
          ...canonicalRuntime,
          config: {
            ...canonicalRuntime.config,
            sessionState: {
              facet: sessionStateFacet,
              capabilities: this.resolveSessionStateCapabilities(resolution),
            },
          },
        }
      : canonicalRuntime;
    const publishHostRuntimeEvent: NonNullable<
      HostSessionRuntimePlan['config']['publishHostRuntimeEvent']
    > = (event) => {
      const scopedRegistry = hostOptions?.pluginRuntimeRegistryLease?.registry;
      if (scopedRegistry) {
        scopedRegistry.publishHostEvent?.(event);
        return;
      }
      const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
      if (!lease) {
        resolution.publishHostEvent?.(event);
        return;
      }
      try {
        lease.registry.publishHostEvent?.(event);
      } finally {
        void lease.release().catch(() => {
          logger.debug('[SessionHostBridge] Host Event registry lease release failed (non-fatal)', {
            error: 'host_event_registry_lease_release_failed',
          });
        });
      }
    };
    const planWithHostEvents = {
      ...planWithSessionState,
      config: {
        ...planWithSessionState.config,
        publishHostRuntimeEvent,
        ...(hostOptions?.pluginRuntimeRegistryLease
          ? { pluginRuntimeRegistryLease: hostOptions.pluginRuntimeRegistryLease }
          : {}),
      },
    };
    const planWithIdentity = withHostSessionRuntimeIdentityPublication({
      plan: planWithHostEvents,
      identity: buildRuntimePublicationFromEngineResolution(resolution, {
        includeExecutionRun: false,
      }),
    });
    return planWithIdentity;
  }

  async runSessionCommand(
    backendId: string,
    params: unknown,
    hostOptions?: SessionHostRunOptions,
  ): Promise<void> {
    const runtime = await this.createSessionRuntime(
      backendId,
      params,
      hostOptions,
    );
    await hostOptions?.beforeRuntimePlanCommit?.();
    const { runHostSessionRuntimePlan } = await import('@/agent/runtime/session/loop/lifecycle');
    await runHostSessionRuntimePlan(runtime);
  }

  async evaluateAttachEligibility(
    params: Omit<Parameters<typeof evaluateCliSessionAttachEligibility>[0], 'resolveExecutionSurfaces'>,
  ): Promise<CliSessionAttachEligibility> {
    return await evaluateCliSessionAttachEligibility({
      ...params,
      resolveExecutionSurfaces: (backendId) => this.resolveExecutionSurfaces(backendId),
    });
  }

  async resolveSessionHandoffEligibility(
    params: Omit<
      Parameters<typeof resolveSessionHandoffEligibility>[0],
      'resolveCurrentExecutionSurfacesForAgent'
    >,
  ): Promise<SessionHandoffEligibility> {
    return await resolveSessionHandoffEligibility({
      ...params,
      resolveCurrentExecutionSurfacesForAgent: (agentId) =>
        this.resolveCurrentExecutionSurfacesForCatalogAgent(agentId),
    });
  }

  resolveContinueWithReplayBackendTarget(params: Readonly<{
    agent?: string;
    backendTarget?: BackendTargetRefV2Input | null;
  }>): ContinueWithReplayBackendTargetResolution {
    return resolveContinueWithReplayBackendTarget(params);
  }

  async resolveSessionForkBackendTarget(
    params: Parameters<typeof resolveSessionForkBackendTarget>[0],
  ): Promise<SessionForkBackendTargetResolution> {
    return await resolveSessionForkBackendTarget(params);
  }

  async resolveExternalSessionLinkIdentity(params: Readonly<{
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
  }>): Promise<ExternalSessionLinkIdentity> {
    return await resolveExternalSessionLinkIdentity(params);
  }

  async canonicalizeLinkedExternalSessionSource(params: Readonly<{
    agentId: ExternalSessionsAgentId;
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    source: ExternalSessionsSource;
  }>): Promise<CanonicalizedExternalSessionSourceResult> {
    return await canonicalizeLinkedExternalSessionSource(params);
  }

  async emitLifecycleHookEvent(params: Readonly<{
    happyHomeDir: string;
    eventId: BridgeLifecycleHookEventIdV1;
    scope?: HookScopeV1;
    happySessionId?: string;
    agentSessionId?: string;
    agentId?: string;
    backendTarget?: string;
    machineId?: string;
    workspaceId?: string;
    cwd?: string;
    turnId?: string;
    toolCallId?: string;
    timestampMs?: number;
    payload: Record<string, unknown>;
  }>): Promise<void> {
    await emitBridgeLifecycleHookEventBestEffort({
      happyHomeDir: params.happyHomeDir,
      event: {
        eventId: params.eventId,
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.happySessionId ? { happySessionId: params.happySessionId } : {}),
        ...(params.agentSessionId ? { agentSessionId: params.agentSessionId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.backendTarget ? { backendTarget: params.backendTarget } : {}),
        ...(params.machineId ? { machineId: params.machineId } : {}),
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(typeof params.timestampMs === 'number' ? { timestampMs: params.timestampMs } : {}),
        payload: params.payload,
      },
    });
  }
}

let sharedSessionHostBridge: SessionHostBridge | null = null;

export function getSessionHostBridge(): SessionHostBridge {
  if (!sharedSessionHostBridge) {
    sharedSessionHostBridge = new SessionHostBridge();
  }
  return sharedSessionHostBridge;
}
