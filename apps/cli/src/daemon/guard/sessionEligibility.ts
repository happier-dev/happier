import type { TrackedSession } from '../types';
import type { LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import { buildInactiveSessionResumeSpawnOptions, type BuildInactiveSessionResumeSpawnOptionsParams } from '../sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import type { SessionDraftPresence } from '@/session/drafts/readSessionDraftPresence';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { readSessionDraftPresence } from '@/session/drafts/readSessionDraftPresence';
import { withTrackedSessionRpc } from '../sessionEncryption/withTrackedSessionRpc';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { createSessionLiveWorkProducer } from '../lifecycle/sessionLiveWorkProducer';
import { requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { resolveSessionMetadataAgentIdentity, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { isSessionResumeSupported } from '@/session/runtime/resumeSupport';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveCurrentExternalSessionAgentRoutingId } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { readSessionLiveWorkEligibility } from '@/agent/runtime/session/input/sessionLiveWorkEligibility';

export type SessionEligibilityReason = Readonly<{
  kind: 'working' | 'waiting_for_you' | 'subagents_running' | 'unsent_draft' | 'draft_unknown'
    | 'not_resumable' | 'kill_protected' | 'activity_unknown';
  count?: number;
}>;
export type SessionEligibility = Readonly<
  | { eligible: true; settledAt: number; resumeOptions: SpawnSessionOptions }
  | { eligible: false; reasons: readonly SessionEligibilityReason[] }
>;

/** Exact runner facts; aggregate Machine coverage belongs to Machine retention. */
export function readSessionActivityEligibility(tracked: TrackedSession, inventory: LiveWorkInventoryV1): Readonly<
  { eligible: true; settledAt: number } | { eligible: false; reasons: readonly SessionEligibilityReason[] }
> {
  return readSessionLiveWorkEligibility(inventory.items.filter(item => item.ownerRef === tracked));
}

export async function readCurrentSessionEligibility(input: Readonly<{
  access: Parameters<typeof withTrackedSessionRpc>[0];
  /** Initial exact-owner observation only; post-draft activity is always read again. */
  inventory?: LiveWorkInventoryV1;
}>): Promise<SessionEligibility> {
  const unavailable = { eligible: false, reasons: [{ kind: 'not_resumable' }] } as const;
  try {
    return await withTrackedSessionRpc(input.access, async (callRpc, access) => {
      // This stop concerns one runner. Unavailable Sync/Service/other-Session
      // coverage cannot replace its own fresh input, subagent and attention facts.
      const activity = createSessionLiveWorkProducer({
        readSessions: () => input.access.isTrackedCurrent() ? [input.access.tracked] : [],
        readActivity: () => requestSessionInputLiveWork({ callRpc }),
      });
      const metadata = tryDecryptSessionOwnerMetadataView({ credentials: access.credentials,
        accountEncryptionMode: access.accountEncryptionMode, rawSession: access.rawSession });
      if (!metadata) return unavailable;
      const resume = { sessionId: access.sessionId, rawSession: access.rawSession, metadata,
        fallbackMachineId: input.access.machineId };
      const readAcpCatalogSnapshot = async () => {
        const operationContext = input.access.requesterBootstrap?.savedSecretOperationContext;
        const snapshot = operationContext?.readSnapshot() ?? getActiveAccountSettingsSnapshot();
        if (snapshot?.scopeKey !== resolveAccountSettingsScopeKey(access.credentials) || !await access.isCurrent()) {
          return { status: 'unavailable', reason: 'scope-retired' } as const;
        }
        return snapshot.acpCatalog?.status === 'ready' ? snapshot.acpCatalog : await refreshActiveAcpCatalog({
          credentials: access.credentials, signal: input.access.signal, operationContext,
        });
      };
      const items = input.inventory?.items.filter(item => item.ownerRef === input.access.tracked);
      // Aggregate unknown coverage may belong to another Session or Machine
      // owner. Only this runner's complete four-category observation is reused.
      const observed = items && (['session', 'input', 'agents', 'attention'] as const)
        .every(category => items.some(item => item.category === category))
        ? { items, coverage: items.some(item => item.state === 'unknown') ? 'unknown' as const : 'complete' as const }
        : undefined;
      const preliminary = await evaluateSessionEligibility({ tracked: input.access.tracked,
        inventory: observed ?? await activity.read(), resume, draft: { status: 'absent' }, readAcpCatalogSnapshot });
      if (!preliminary.eligible) return preliminary;
      const draft = await readSessionDraftPresence({ sessionId: access.sessionId, signal: input.access.signal,
        requester: { token: access.credentials.token, serverHttpBaseUrl: access.serverHttpBaseUrl,
          isCurrent: access.isCurrent } });
      const inventory = await activity.read();
      return await evaluateSessionEligibility({ tracked: input.access.tracked, inventory, resume, draft, readAcpCatalogSnapshot });
    }) ?? unavailable;
  } catch { return { eligible: false, reasons: [{ kind: 'draft_unknown' }] }; }
}

/** The one automatic-stop predicate. Callers supply fresh inventory/draft facts, not idle guesses. */
export async function evaluateSessionEligibility(input: Readonly<{
  tracked: TrackedSession;
  inventory: LiveWorkInventoryV1;
  draft: SessionDraftPresence;
  resume: BuildInactiveSessionResumeSpawnOptionsParams;
  readAcpCatalogSnapshot?(): Promise<AcpCatalogSnapshotV1>;
}>): Promise<SessionEligibility> {
  const { tracked, inventory, draft } = input;
  const reasons: SessionEligibilityReason[] = [];
  const add = (reason: SessionEligibilityReason) => { if (!reasons.some(existing => existing.kind === reason.kind)) reasons.push(reason); };
  const activity = readSessionActivityEligibility(tracked, inventory);
  const settledAt = activity.eligible ? activity.settledAt : undefined;
  if (inventory.coverage !== 'complete') add({ kind: 'activity_unknown' });
  if (!activity.eligible) for (const reason of activity.reasons) add(reason);
  if (tracked.reattachedFromDiskMarker) add({ kind: 'kill_protected' });
  if (tracked.stopRequestedAtMs !== undefined) add({ kind: 'working' });
  if (draft.status === 'present') add({ kind: 'unsent_draft' });
  else if (draft.status === 'unknown') add({ kind: 'draft_unknown' });
  let resumeOptions: SpawnSessionOptions | null = null;
  if (tracked.happySessionId === input.resume.sessionId) {
    try {
      resumeOptions = buildInactiveSessionResumeSpawnOptions(input.resume);
      if (resumeOptions) {
        const definitionId = resumeOptions.agentTarget?.definitionId
          ?? (resumeOptions.backendTarget?.sourceKind === 'configured'
            ? resumeOptions.backendTarget.configuredBackendId ?? resumeOptions.backendTarget.backendId : null);
        const configuredBackend = definitionId ? resolveConfiguredAcpBackendFromAccountSettings({}, definitionId,
          await input.readAcpCatalogSnapshot?.()) : undefined;
        const agentId = definitionId
          ? await resolveCurrentExternalSessionAgentRoutingId(resumeOptions.agentTarget?.identity ?? CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1)
          : resolveSessionMetadataAgentIdentity(input.resume.metadata).agentId;
        const supported = await isSessionResumeSupported({
          agentId,
          ...(resumeOptions.runtimeDescriptorV1 ? { runtimeDescriptorV1: resumeOptions.runtimeDescriptorV1 } : {}),
          ...(definitionId ? { configuredBackend: configuredBackend ?? null } : {}),
        });
        if (!supported || !agentId || !resolveVendorResumeIdFromSessionMetadata(agentId, input.resume.metadata)) resumeOptions = null;
      }
    } catch { resumeOptions = null; /* Unproven recovery cannot authorize an automatic stop. */ }
  }
  if (resumeOptions === null) add({ kind: 'not_resumable' });
  if (reasons.length || settledAt === undefined || resumeOptions === null) return { eligible: false, reasons };
  return { eligible: true, settledAt: Math.max(settledAt, draft.status === 'absent' ? draft.updatedAt ?? 0 : 0), resumeOptions };
}
