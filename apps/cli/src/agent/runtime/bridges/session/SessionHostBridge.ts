import type {
  BridgeLifecycleHookEventIdV1,
  BackendTargetRefV2Input,
  ExternalSessionsProviderId,
  ExternalSessionsSource,
  HookScopeV1,
  RuntimeDescriptorV1,
  SessionStateCapabilitiesV1,
} from '@happier-dev/protocol';
import { SessionStateCapabilitiesV1Schema } from '@happier-dev/protocol';

import {
  resolveBackendEngineAdapterResolution,
  resolveBackendExecutionSurfaces,
  type BackendExecutionSurfaces,
} from '@/agent/runtime/registry/engineRegistry';
import { buildRuntimePublicationFromEngineResolution } from '@/agent/runtime/identity/buildRuntimePublicationFromEngineResolution';
import type { ProviderMessageMetaEnricher } from '@happier-dev/agents';
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
import type { SessionHostBridgeContract } from './sessionBridgeContract';
import type { ExternalSessionLinkIdentity } from '@/session/external/providerOps';
import {
  isHostSessionRuntimePlan,
  runHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/lifecycle';
import { throwIfPluginRuntimeStartBlocked } from '@/agent/runtime/registry/throwIfPluginRuntimeStartBlocked';
import { withHostSessionRuntimeIdentityPublication } from '@/agent/runtime/identity/publication/withHostSession';

/**
 * Canonical session host-bridge owner. The older March/plan-only `AgentSessionRuntimeBridge` /
 * `createSessionRuntimeBridge.ts` naming is superseded by this class plus the shared
 * session-loop lifecycle and session-control helpers.
 */
export class SessionHostBridge implements SessionHostBridgeContract {
  private requireCanonicalSessionRuntime(runtime: unknown, backendId: string) {
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

  private resolveEngineResolutionParams(params: unknown): Readonly<{ happyHomeDir?: string }> | undefined {
    if (!params || typeof params !== 'object') {
      return undefined;
    }
    const happyHomeDir = (params as Readonly<Record<string, unknown>>).happyHomeDir;
    if (typeof happyHomeDir !== 'string') {
      return undefined;
    }
    const trimmedHappyHomeDir = happyHomeDir.trim();
    return trimmedHappyHomeDir.length > 0 ? { happyHomeDir: trimmedHappyHomeDir } : undefined;
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

  async createSessionRuntime(backendId: string, params: unknown) {
    const resolution = await resolveBackendEngineAdapterResolution(
      backendId,
      this.resolveEngineResolutionParams(params),
    );
    if (!resolution) {
      throw new Error(`Unsupported session runtime backend: ${backendId}`);
    }
    throwIfPluginRuntimeStartBlocked(resolution);
    const injectedParams = this.injectProviderMessageMetaEnricher(params, resolution.engineAdapter.messageMeta);
    const runtime = await resolution.engineAdapter.runtimeCore.createSessionRuntime(injectedParams);
    const canonicalRuntime = this.requireCanonicalSessionRuntime(runtime, backendId);
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
    return withHostSessionRuntimeIdentityPublication({
      plan: planWithSessionState,
      identity: buildRuntimePublicationFromEngineResolution(resolution, {
        descriptorSchemaId: 'happier.hostSessionRuntimeIdentity',
        includeExecutionRun: false,
      }),
    });
  }

  async runSessionCommand(backendId: string, params: unknown): Promise<void> {
    const runtime = await this.createSessionRuntime(backendId, params);
    await runHostSessionRuntimePlan(runtime);
  }

  async evaluateAttachEligibility(
    params: Parameters<typeof evaluateCliSessionAttachEligibility>[0],
  ): Promise<CliSessionAttachEligibility> {
    return await evaluateCliSessionAttachEligibility(params);
  }

  resolveSessionHandoffEligibility(params: Readonly<{
    metadata: unknown;
    accountSettings?: Record<string, unknown> | null;
  }>): SessionHandoffEligibility {
    return resolveSessionHandoffEligibility(params);
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
    providerId: ExternalSessionsProviderId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
  }>): Promise<ExternalSessionLinkIdentity> {
    return await resolveExternalSessionLinkIdentity(params);
  }

  async canonicalizeLinkedExternalSessionSource(params: Readonly<{
    providerId: ExternalSessionsProviderId;
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
    providerSessionId?: string;
    providerId?: string;
    backendId?: string;
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
        ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
        ...(params.providerId ? { providerId: params.providerId } : {}),
        ...(params.backendId ? { backendId: params.backendId } : {}),
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
