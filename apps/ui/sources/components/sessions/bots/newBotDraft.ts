import type { SessionAuthoringOpenResultV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionIdentityAdditions } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { openSessionAuthoringAction, type MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';

/** A new Bot is an ordinary editable draft that is born a Bot; only the composer's Send creates it. */
export const NEW_BOT_SEED = {
  initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
} as const;

/** The one "New bot" entry for every surface (Bots roster, Bots menu, empty states). */
export async function openNewBotDraft(
  lifetime: ServerAccountScopeLifetime,
  executeAction?: MountedAuthoringActionExecute,
): Promise<SessionAuthoringOpenResultV1> {
  const result = await openSessionAuthoringAction({ seed: NEW_BOT_SEED }, lifetime, undefined, executeAction);
  if (result.kind === 'unavailable') await Modal.alertAsync(t('bots.new'), t('common.unavailable'));
  return result;
}

/**
 * A New Bot draft draws its face from the draft's own id until another face is chosen, and that seed is born with
 * the Session in the same metadata, so the face previewed is the face born. Ordinary (non-Bot) drafts are unchanged.
 */
export function withNewBotDraftFaceSeed(
  facts: SessionIdentityAdditions | undefined,
  draftId: string,
): SessionIdentityAdditions | undefined {
  if (!facts?.bot || facts.botFace?.seed) return facts;
  return { ...facts, botFace: { ...facts.botFace, seed: draftId } };
}
