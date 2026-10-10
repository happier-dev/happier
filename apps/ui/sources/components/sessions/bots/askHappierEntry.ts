import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';

import { Modal } from '@/modal';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { AskHappierContext } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { t } from '@/text';
import type { SessionState } from '@/utils/sessions/sessionUtils';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import type { AskHappierDraftResult } from './happierGuideDraft';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

/**
 * Every Ask Happier entry (offer card, Bots menu, palette, What's new, showcase end, an error
 * link, the sign-in continuation) runs this one owner: the editable guide draft, and when the guide
 * cannot be prepared, the truthful unavailable line with the explicit blank New bot alternative.
 * Nothing here Sends; the ordinary composer does.
 */
export async function startAskHappier(
  params: Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    context?: AskHappierContext;
    currentUiContext?: CurrentUiContextSnapshotV1 | null;
    executeAction?: MountedAuthoringActionExecute;
    guideRef?: PromptDocArtifactRefV1;
  }>,
): Promise<AskHappierDraftResult> {
  // Lazy: the guide asset and draft owners load only when someone asks.
  const { openAskHappierDraft, openBlankAskHappierDraft } =
    await import('./happierGuideDraft');
  const result = await openAskHappierDraft({
    lifetime: params.lifetime,
    context: params.context,
    currentUiContext: params.currentUiContext,
    executeAction: params.executeAction,
    guideRef: params.guideRef,
  });
  const unavailable =
    result.kind === 'documentUnavailable' ||
    (result.kind === 'unavailable' && result.reason === 'client_unavailable');
  if (!unavailable) return result;
  const lifetime = params.lifetime;
  if (result.kind !== 'documentUnavailable' || !lifetime) {
    await Modal.alertAsync(t('bots.guide.offer'), t('bots.guide.unavailable'));
    return result;
  }
  const startBlank = await Modal.confirm(
    t('bots.guide.offer'),
    t('bots.guide.unavailable'),
    {
      confirmText: t('bots.guide.startBlank'),
      cancelText: t('common.cancel'),
    },
  );
  if (startBlank && lifetime.isCurrent())
    return { ...await openBlankAskHappierDraft(lifetime, params.executeAction), guideRef: result.guideRef };
  return result;
}

/**
 * Session states in which the status row offers Ask Happier: the machine or runtime can't serve the
 * Session and the person needs to know what to do. Healthy and in-progress states stay quiet.
 */
const ASK_HAPPIER_STATUS_OFFER_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
    'disconnected', 'failed', 'repair_needed', 'recoverable_unservable', 'setup_required',
]);
export function isAskHappierStatusOfferState(state: SessionState): boolean {
    return ASK_HAPPIER_STATUS_OFFER_STATES.has(state);
}
