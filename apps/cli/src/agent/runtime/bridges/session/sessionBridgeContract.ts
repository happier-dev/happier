import type {
  BridgeLifecycleHookEventIdV1,
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  BackendTargetRefV2Input,
  HookScopeV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';
import type { RuntimeOutboundTranscriptDispatchFacetV1 } from '@happier-dev/agents';
import type { CliSessionAttachEligibility } from '@/session/attach/evaluateCliSessionAttachEligibility';
import type {
  SessionForkBackendTargetResolution,
} from '@/session/fork/backendTarget';
import type {
  ContinueWithReplayBackendTargetResolution,
} from '@/session/replay/resolveContinueWithReplayBackendTarget';
import type { SessionHandoffEligibility } from '@/session/handoff/resolveSessionHandoffEligibility';
import type {
  CanonicalizedExternalSessionSourceResult,
} from './externalSessionSourceCanonicalization';
import type { ExternalSessionLinkIdentity } from '@/session/external/providerOps';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

/**
 * Canonical live session host-bridge surface. This is the concrete owner that superseded the
 * plan-only `AgentSessionRuntimeBridge` noun.
 *
 * Direct-session routing stays on these explicit bridge methods plus adjacent helpers; there is no
 * separate `AgentSessionCatalog`, `createSessionRuntimeBridge.ts`, or bridge-local
 * `resolveRuntimeControlSurface` owner in the live tree.
 */
export interface SessionHostBridgeContract {
  resolveExecutionSurfaces(backendId?: string | null): Promise<BackendExecutionSurfaces>;
  resolveOutboundTranscriptDispatchFacet(backendId?: string | null): Promise<Readonly<{
    backendId: string;
    facet: RuntimeOutboundTranscriptDispatchFacetV1;
  }> | null>;
  createSessionRuntime(backendId: string, params: unknown): Promise<HostSessionRuntimePlan>;
  runSessionCommand(backendId: string, params: unknown): Promise<void>;
  evaluateAttachEligibility(
    params: Omit<
      Parameters<(typeof import('@/session/attach/evaluateCliSessionAttachEligibility'))['evaluateCliSessionAttachEligibility']>[0],
      'resolveExecutionSurfaces'
    >,
  ): Promise<CliSessionAttachEligibility>;
  resolveSessionHandoffEligibility(params: Readonly<{
    metadata: unknown;
    accountSettings?: Record<string, unknown> | null;
  }>): SessionHandoffEligibility;
  resolveContinueWithReplayBackendTarget(params: Readonly<{
    agent?: string;
    backendTarget?: BackendTargetRefV2Input | null;
  }>): ContinueWithReplayBackendTargetResolution;
  resolveSessionForkBackendTarget(
    params: Parameters<(typeof import('@/session/fork/backendTarget'))['resolveSessionForkBackendTarget']>[0],
  ): Promise<SessionForkBackendTargetResolution>;
  resolveExternalSessionLinkIdentity(params: Readonly<{
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
  }>): Promise<ExternalSessionLinkIdentity>;
  canonicalizeLinkedExternalSessionSource(params: Readonly<{
    agentId: ExternalSessionsAgentId;
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    source: ExternalSessionsSource;
  }>): Promise<CanonicalizedExternalSessionSourceResult>;
  emitLifecycleHookEvent(params: Readonly<{
    happyHomeDir: string;
    eventId: BridgeLifecycleHookEventIdV1;
    scope?: HookScopeV1;
    happySessionId?: string;
    agentSessionId?: string;
    agentId?: string;
    backendId?: string;
    backendTarget?: string;
    machineId?: string;
    workspaceId?: string;
    cwd?: string;
    turnId?: string;
    toolCallId?: string;
    timestampMs?: number;
    payload: Record<string, unknown>;
  }>): Promise<void>;
}
