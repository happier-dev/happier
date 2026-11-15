import type { SessionIdentityAdditions } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { openSessionAuthoringAction, type MountedAuthoringActionExecute, type SessionAuthoringOpenOutcome } from '@/sync/ops/actions/sessionAuthoringActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** A new Bot is an ordinary editable draft that is born a Bot; only the composer's Send creates it. */
export const NEW_BOT_SEED = {
  initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
} as const;

/** The one "New bot" entry for every surface (Bots roster, Bots menu, empty states). */
export async function openNewBotDraft(
  lifetime: ServerAccountScopeLifetime,
  executeAction?: MountedAuthoringActionExecute,
): Promise<SessionAuthoringOpenOutcome> {
  // Bot authoring needs its mounted approval custodian; the authoring owner shows a refusal or a waiting approval.
  if (!executeAction) return { kind: 'unavailable', reason: 'client_unavailable' };
  return openSessionAuthoringAction({ seed: NEW_BOT_SEED }, lifetime, { executeAction });
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
