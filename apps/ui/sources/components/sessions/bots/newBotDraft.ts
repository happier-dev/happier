import type { SessionNewSessionSeedOutcome } from '@happier-dev/protocol/plugins/ui';

import { openOrdinaryNewSessionSeed } from '@/components/sessions/new/newSessionSeedNavigation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** A new Bot is an ordinary editable draft that is born a Bot; only the composer's Send creates it. */
export const NEW_BOT_SEED = {
  initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
} as const;

/** The one "New bot" entry for every surface (Bots roster, Bots menu, empty states). */
export async function openNewBotDraft(
  lifetime: ServerAccountScopeLifetime,
): Promise<SessionNewSessionSeedOutcome> {
  return openOrdinaryNewSessionSeed({
    seed: NEW_BOT_SEED,
    scope: lifetime.scope,
    isCurrent: lifetime.isCurrent,
  });
}
