import { ReviewEngineInventorySchema, type ReviewEngineProfileSelection } from '@happier-dev/protocol/reviews/reviewEngines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSessionListPreferredServerIdFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveVoiceContextSessionFromState } from '@/voice/context/resolveVoiceContextSession';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { randomUUID } from '@/platform/randomUUID';

const failure = (errorCode: string) => ({ ok: false as const, errorCode, errorMessage: errorCode });
const normalizeId = (raw: unknown) => typeof raw === 'string' ? raw.trim() : '';

/** The daemon owns the inventory and launch defaults; the UI only chooses the exact transport target. */
export async function listReviewEnginesForVoiceTool(params: Readonly<{
  sessionId: string | null; machineId?: string; includeDisabled?: boolean; scope?: 'paths'; serverId?: string;
  profileSelections?: readonly ReviewEngineProfileSelection[];
}>, capturedAccount?: LazyActionAccountContext): Promise<unknown> {
  const detached = params.sessionId === null;
  const sessionId = normalizeId(params.sessionId) || null;
  if (!sessionId && !detached) return failure('session_not_selected');
  const state = storage.getState();
  const session = sessionId ? resolveVoiceContextSessionFromState(sessionId, state) : null;
  const machineId = detached ? normalizeId(params.machineId)
    : normalizeId(sessionId ? readMachineTargetForSession(sessionId)?.machineId : null)
      || normalizeId(session ? readSessionOwnerMetadataView(session)?.machineId : null);
  if (!machineId) return failure('machine_not_selected');
  if (detached && !normalizeId(params.serverId)) return failure('server_not_selected');
  const preferredServerId = sessionId ? resolveSessionListPreferredServerIdFromState(state, sessionId) : null;
  if (params.serverId && preferredServerId && !areServerProfileIdentifiersEquivalent(params.serverId, preferredServerId)) {
    return failure('action_account_scope_changed');
  }
  const serverId = params.serverId ?? preferredServerId ?? normalizeId(getActiveServerSnapshot()?.serverId);
  if (!serverId) return failure('server_not_selected');
  if (capturedAccount && !areServerProfileIdentifiersEquivalent(capturedAccount.serverId, serverId)) return failure('action_account_scope_changed');
  const account = capturedAccount ?? await captureLazyActionAccountContext(serverId);
  try {
    account.assertCurrent();
    const response = await executeOriginalAccountMachineAction({ account, machineId, actionId: 'review.engines.list',
      requestId: randomUUID(), input: { sessionId: null, machineId,
        ...(params.includeDisabled !== undefined ? { includeDisabled: params.includeDisabled } : {}),
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.profileSelections ? { profileSelections: params.profileSelections } : {}) },
      ...(account.invocationSignal ? { signal: account.invocationSignal } : {}),
    });
    account.assertCurrent();
    if (!response.ok) return response;
    const result = ReviewEngineInventorySchema.safeParse(response.result);
    return result.success ? { sessionId, ...result.data } : failure('invalid_action_output');
  } finally {
    if (!capturedAccount) account.dispose();
  }
}
