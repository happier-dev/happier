import type {
  BridgeLifecycleHookEventIdV1,
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  BackendTargetRefV2Input,
  AgentExecutionTargetV1,
  HookScopeV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';
import type {
  CliSessionAttachEligibility,
  CliSessionAttachEligibilityParams,
} from '@/session/attach/evaluateCliSessionAttachEligibility';
import type {
  SessionForkBackendTargetParams,
  SessionForkBackendTargetResolution,
} from '@/session/fork/backendTarget';
import type {
  ContinueWithReplayBackendTargetResolution,
} from '@/session/replay/resolveContinueWithReplayBackendTarget';
import type {
  SessionHandoffEligibility,
  SessionHandoffEligibilityInput,
} from '@/session/handoff/resolveSessionHandoffEligibility';
import type {
  CanonicalizedExternalSessionSourceResult,
} from './externalSessionSourceCanonicalization';
import type { ExternalSessionLinkIdentity } from '@/session/external/providerOps';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/plan';

export type CurrentCatalogAgentExecutionSurfaces = Readonly<{
  agentId: string;
  backendId: string;
  agentTarget: AgentExecutionTargetV1;
  executionSurfaces: BackendExecutionSurfaces;
}>;

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
  resolveCurrentExecutionSurfacesForCatalogAgent(
    agentId: string,
  ): Promise<CurrentCatalogAgentExecutionSurfaces | null>;
  createSessionRuntime(backendId: string, params: unknown): Promise<HostSessionRuntimePlan>;
  runSessionCommand(
    backendId: string,
    params: unknown,
    lifecycle?: Readonly<{
      beforeRuntimePlanCommit?: () => void | Promise<void>;
    }>,
  ): Promise<void>;
  evaluateAttachEligibility(
    params: Omit<CliSessionAttachEligibilityParams, 'resolveExecutionSurfaces'>,
  ): Promise<CliSessionAttachEligibility>;
  resolveSessionHandoffEligibility(
    params: Omit<SessionHandoffEligibilityInput, 'resolveCurrentExecutionSurfacesForAgent'>,
  ): Promise<SessionHandoffEligibility>;
  resolveContinueWithReplayBackendTarget(params: Readonly<{
    agent?: string;
    backendTarget?: BackendTargetRefV2Input | null;
  }>): ContinueWithReplayBackendTargetResolution;
  resolveSessionForkBackendTarget(
    params: SessionForkBackendTargetParams,
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
