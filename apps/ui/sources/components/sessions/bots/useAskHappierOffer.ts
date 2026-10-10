import * as React from 'react';

import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { AskHappierContext } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { AskHappierDraftResult } from './happierGuideDraft';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

import { startAskHappier } from './askHappierEntry';

/** The setup step whose durable hidden state is the Account-wide "Don't show again". */
export const ASK_HAPPIER_SETUP_STEP_ID = 'askHappier';

// "Not now" hides the offer for this app run on every surface that shows it; it writes nothing.
let offerSnoozed = false;
const snoozeListeners = new Set<() => void>();
function subscribeOfferSnooze(listener: () => void): () => void {
  snoozeListeners.add(listener);
  return () => {
    snoozeListeners.delete(listener);
  };
}
const readOfferSnooze = () => offerSnoozed;
function snoozeOffer(): void {
  if (offerSnoozed) return;
  offerSnoozed = true;
  for (const listener of snoozeListeners) listener();
}

/** Test seam: a fresh app run starts with the offer unsnoozed. */
export function resetAskHappierOfferSnoozeForTests(): void {
  offerSnoozed = false;
}

/**
 * Whether the offer is shown (empty Bots roster, Home's Get set up). It waits for the Account
 * layout snapshot, so it never flashes before a stored "Don't show again" is known. Dismissal
 * removes only the offer; the Bots menu, palette and Help entries stay.
 */
export function useAskHappierOfferVisible(): boolean {
  const { hasSnapshot, hidden } = useHomeSetupDismissals();
  const snoozed = React.useSyncExternalStore(
    subscribeOfferSnooze,
    readOfferSnooze,
    readOfferSnooze,
  );
  return hasSnapshot && !snoozed && !hidden.has(ASK_HAPPIER_SETUP_STEP_ID);
}

/** Start · Not now · Don't show again, wired to their one owner each. */
export function useAskHappierOfferChoices(): Readonly<{
  start: () => void;
  notNow: () => void;
  dontShowAgain: () => void;
}> {
  const open = useAskHappierOpener();
  const { dismiss } = useHomeSetupDismissals();
  return React.useMemo(
    () => ({
      start: () => fireAndForget(open(), { tag: 'AskHappier.startOffer' }),
      notNow: snoozeOffer,
      dontShowAgain: () =>
        fireAndForget(dismiss(ASK_HAPPIER_SETUP_STEP_ID), {
          tag: 'AskHappier.dontShowAgain',
        }),
    }),
    [dismiss, open],
  );
}

/**
 * The entry opener a mounted control calls. The Account lifetime and the visible screen are
 * captured at the press, never read again after the draft opens.
 */
export function useAskHappierOpener(): (context?: AskHappierContext) => Promise<AskHappierDraftResult> {
  const currentUiContextReader = useOptionalCurrentUiContextReader();
  const start = useAskHappierStarter();
  return React.useCallback(async (context?: AskHappierContext) => start({
    lifetime: captureActiveServerAccountScopeLifetime(), context,
    currentUiContext: currentUiContextReader?.readCurrentUiContext() ?? null,
  }), [currentUiContextReader, start]);
}

/** Captured entry data also serves authenticated resume and the shell palette. */
export function useAskHappierStarter(): (params: Parameters<typeof startAskHappier>[0]) => Promise<AskHappierDraftResult> {
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope);
  const acknowledged = React.useRef<Readonly<{ scope: ServerAccountScope; guideRef: PromptDocArtifactRefV1 }> | null>(null);
  return React.useCallback(
    async params => {
      const { lifetime } = params;
      const guideRef = lifetime && acknowledged.current && areServerAccountScopesEqual(lifetime.scope, acknowledged.current.scope)
        ? acknowledged.current.guideRef : undefined;
      const result = await startAskHappier({ ...params, executeAction: execute, guideRef: params.guideRef ?? guideRef });
      if (result.guideRef && lifetime) acknowledged.current = { scope: lifetime.scope, guideRef: result.guideRef };
      return result;
    },
    [execute],
  );
}
