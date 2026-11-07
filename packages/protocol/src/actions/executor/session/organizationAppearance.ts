import { isSessionOrganizationAppearanceActionId } from '../../actionIds.js';
import type { SessionOrganizationAppearanceActionInput } from '../../sessionOrganizationMoveAction.js';
import type { ActionHomeEquivalence, CoreInvocation } from '../coreInvocation.js';
import { completeActionResult } from '../resultProjection.js';
import type { ActionExecuteResult } from '../types.js';

/** Admission owns the typed intent; the captured client owns display encryption and merging. */
export async function dispatchSessionOrganizationAppearance(
  inv: Pick<CoreInvocation, 'actionId' | 'admittedInput' | 'deps' | 'ctx'> & Readonly<{ sameHome: ActionHomeEquivalence }>,
): Promise<ActionExecuteResult | null> {
  if (!isSessionOrganizationAppearanceActionId(inv.actionId)) return null;
  if (!inv.deps.sessionOrganizationAppearanceSet) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${inv.actionId}` };
  const input = inv.admittedInput as SessionOrganizationAppearanceActionInput;
  if (input.serverId && inv.ctx.serverId && !inv.sameHome(input.serverId, inv.ctx.serverId)) {
    return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
  }
  return completeActionResult(await inv.deps.sessionOrganizationAppearanceSet({ input,
    ...(inv.ctx.signal ? { signal: inv.ctx.signal } : {}) }));
}
