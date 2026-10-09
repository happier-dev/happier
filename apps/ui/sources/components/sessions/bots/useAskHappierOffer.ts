import * as React from 'react';

import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { AskHappierContext } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
      start: () => open(),
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
export function useAskHappierOpener(): (context?: AskHappierContext) => void {
  const currentUiContextReader = useOptionalCurrentUiContextReader();
  return React.useCallback(
    (context?: AskHappierContext) => {
      const lifetime = captureActiveServerAccountScopeLifetime();
      const currentUiContext =
        currentUiContextReader?.readCurrentUiContext() ?? null;
      fireAndForget(startAskHappier({ lifetime, context, currentUiContext }), {
        tag: 'AskHappier.start',
      });
    },
    [currentUiContextReader],
  );
}
