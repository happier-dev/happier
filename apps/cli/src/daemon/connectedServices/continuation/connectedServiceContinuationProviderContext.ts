import {
  ConnectedServiceBindingsV1Schema,
  isSessionContinuationRecoveryBlockingPendingDrain,
} from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { TrackedSession } from '@/daemon/types';
import { configuration } from '@/configuration';
import { resolveTrackedSessionCatalogAgentId } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import {
  resolveTrackedConnectedServiceSwitchContinuityContext,
  resolveTrackedConnectedServiceVendorResumeId,
} from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { resolveConnectedServicesMaterializationBaseDir } from '@/daemon/connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';
import { resolveTrackedConnectedServiceBindingsRaw } from '@/daemon/connectedServices/trackedSessionConnectedServiceBindings';

type ContinuationContextTrackedSession = Pick<
  TrackedSession,
  'happySessionId' | 'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'
>;

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveTrackedAgentId(
  tracked: Pick<ContinuationContextTrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions'>,
): CatalogAgentId | null {
  return resolveTrackedSessionCatalogAgentId(tracked);
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

function resolveContinuationConnectedServiceBindingsRaw(input: Readonly<{
  tracked: Pick<ContinuationContextTrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions'>;
  persistedSessionMetadata?: unknown;
}>): unknown {
  return resolveTrackedConnectedServiceBindingsRaw(input.tracked)
    ?? (input.persistedSessionMetadata as { connectedServices?: unknown } | null)?.connectedServices;
}

async function hasExactReachableResumeContext(input: Readonly<{
  tracked: Pick<ContinuationContextTrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'>;
  agentId: CatalogAgentId;
  persistedSessionMetadata?: unknown;
}>): Promise<boolean> {
  const tracked = input.tracked;
  const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
    agentId: input.agentId,
    baseDir: resolveConnectedServicesMaterializationBaseDir(configuration.happyHomeDir),
    tracked,
    persistedSessionMetadata: input.persistedSessionMetadata,
    vendorResumeId: resolveTrackedConnectedServiceVendorResumeId({
      agentId: input.agentId,
      tracked,
    }),
  });
  if (!continuityContext.vendorResumeId) return false;
  if (!continuityContext.connectedServiceMaterializationIdentityV1) return false;

  const serviceId = readConnectedServiceBindingServiceId(resolveContinuationConnectedServiceBindingsRaw({
    tracked,
    persistedSessionMetadata: input.persistedSessionMetadata,
  }));
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
  persistedSessionMetadata?: unknown;
}>): Promise<boolean> {
  if (!hasConnectedServiceBinding(resolveContinuationConnectedServiceBindingsRaw(input))) return true;

  const agentId = resolveTrackedAgentId(input.tracked);
  if (!agentId) return false;

  return await hasExactReachableResumeContext({
    tracked: input.tracked,
    agentId,
    persistedSessionMetadata: input.persistedSessionMetadata,
  });
}

export async function replayPendingConnectedServiceContinuationsForTrackedSessions(input: Readonly<{
  trackedSessions: Iterable<ContinuationContextTrackedSession>;
  resolvePersistedSessionMetadata?: (input: Readonly<{ sessionId: string }>) => Promise<unknown> | unknown;
  resolvePendingContinuation: (input: Readonly<{
    sessionId: string;
    exactProviderContextAvailable: boolean;
  }>) => Promise<void> | void;
}>): Promise<Readonly<{ attemptedSessionIds: string[] }>> {
  const attemptedSessionIds: string[] = [];
  for (const tracked of input.trackedSessions) {
    const sessionId = normalizeOptionalString(tracked.happySessionId);
    if (!sessionId) continue;
    const persistedSessionMetadata = await input.resolvePersistedSessionMetadata?.({ sessionId }) ?? null;
    const replayMetadata = persistedSessionMetadata ?? tracked.happySessionMetadataFromLocalWebhook;
    if (!isSessionContinuationRecoveryBlockingPendingDrain(replayMetadata)) continue;
    attemptedSessionIds.push(sessionId);
    await input.resolvePendingContinuation({
      sessionId,
      exactProviderContextAvailable: await resolveConnectedServiceContinuationProviderContextAvailability({
        tracked,
        persistedSessionMetadata,
      }),
    });
  }
  return { attemptedSessionIds };
}
