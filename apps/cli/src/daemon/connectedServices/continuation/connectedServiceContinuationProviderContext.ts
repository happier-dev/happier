import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';
import { join } from 'node:path';

import type { TrackedSession } from '@/daemon/types';
import { configuration } from '@/configuration';
import { resolveDaemonCatalogAgentIdFromBackendTarget } from '@/daemon/backendTargetRouting';
import {
  resolveTrackedConnectedServiceSwitchContinuityContext,
  resolveTrackedConnectedServiceVendorResumeId,
} from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';

type ContinuationContextTrackedSession = Pick<
  TrackedSession,
  'happySessionId' | 'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'
>;

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

function resolveTrackedAgentId(
  tracked: Pick<ContinuationContextTrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions'>,
): AgentId | null {
  const agentId = resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
  if (agentId) return agentId;
  const flavor = tracked.happySessionMetadataFromLocalWebhook?.flavor;
  return isAgentId(flavor) ? flavor : null;
}

function hasConnectedServiceBinding(rawBindings: unknown): boolean {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(rawBindings);
  if (!parsed.success) return false;
  return Object.values(parsed.data.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

function readConnectedServiceBindingServiceId(rawBindings: unknown): string | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(rawBindings);
  if (!parsed.success) return null;
  for (const [serviceId, binding] of Object.entries(parsed.data.bindingsByServiceId)) {
    if (binding.source === 'connected') return serviceId;
  }
  return null;
}

function resolveTrackedConnectedServiceBindingsRaw(
  tracked: Pick<ContinuationContextTrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions'>,
): unknown {
  return tracked.spawnOptions?.connectedServices ?? tracked.happySessionMetadataFromLocalWebhook?.connectedServices;
}

async function hasExactReachableResumeContext(input: Readonly<{
  tracked: Pick<ContinuationContextTrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'>;
  agentId: AgentId;
}>): Promise<boolean> {
  const tracked = input.tracked;
  const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
    agentId: input.agentId,
    baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
    tracked,
    vendorResumeId: resolveTrackedConnectedServiceVendorResumeId({
      agentId: input.agentId,
      tracked,
    }),
  });
  if (!continuityContext.vendorResumeId) return false;
  if (!continuityContext.connectedServiceMaterializationIdentityV1) return false;

  const serviceId = readConnectedServiceBindingServiceId(resolveTrackedConnectedServiceBindingsRaw(tracked));
  if (!serviceId) return false;
  if (!continuityContext.targetMaterializedEnv || !continuityContext.targetMaterializedRoot || !continuityContext.cwd) {
    return false;
  }

  const reachability = await canResumeFromMaterializedState({
    agentId: input.agentId,
    serviceId,
    targetMaterializedRoot: continuityContext.targetMaterializedRoot,
    targetMaterializedEnv: continuityContext.targetMaterializedEnv,
    requestedStateMode: 'isolated',
    effectiveStateMode: 'isolated',
    materializationIdentity: continuityContext.connectedServiceMaterializationIdentityV1,
    vendorResumeId: continuityContext.vendorResumeId,
    cwd: continuityContext.cwd,
    candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
  });
  return reachability.ok;
}

export async function resolveConnectedServiceContinuationProviderContextAvailability(input: Readonly<{
  tracked: Pick<ContinuationContextTrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'>;
}>): Promise<boolean> {
  if (!hasConnectedServiceBinding(resolveTrackedConnectedServiceBindingsRaw(input.tracked))) return true;

  const agentId = resolveTrackedAgentId(input.tracked);
  if (!agentId) return false;

  return await hasExactReachableResumeContext({
    tracked: input.tracked,
    agentId,
  });
}

export async function replayPendingConnectedServiceContinuationsForTrackedSessions(input: Readonly<{
  trackedSessions: Iterable<ContinuationContextTrackedSession>;
  resolvePendingContinuation: (input: Readonly<{
    sessionId: string;
    exactProviderContextAvailable: boolean;
  }>) => Promise<void> | void;
}>): Promise<Readonly<{ attemptedSessionIds: string[] }>> {
  const attemptedSessionIds: string[] = [];
  for (const tracked of input.trackedSessions) {
    const sessionId = normalizeOptionalString(tracked.happySessionId);
    if (!sessionId) continue;
    attemptedSessionIds.push(sessionId);
    await input.resolvePendingContinuation({
      sessionId,
      exactProviderContextAvailable: await resolveConnectedServiceContinuationProviderContextAvailability({ tracked }),
    });
  }
  return { attemptedSessionIds };
}
