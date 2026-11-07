import * as React from 'react';

import {
  readSessionComposerActionChipOffer,
  requestRegisteredSessionComposerActionChip,
  subscribeSessionComposerPresentationTargets,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/** The model chip among the session composer's action chips: the one model/credential picker. */
export const SESSION_MODEL_PICKER_CHIP_KEY = 'session-model-picker';

export type SessionModelPickerEntry = Readonly<{
  /** The Session's mounted composer lets this viewer choose its model right now. */
  offered: boolean;
  open: () => void;
}>;

/**
 * The model picker's external open entry, for surfaces beside the composer (a failed turn's recovery
 * in the transcript). There is no second picker: the request goes through the presentation-target
 * registry to the exact Home/Session composer, which opens the same picker its own status line opens.
 */
export function useSessionModelPickerEntry(
  address: SessionAddress | null,
): SessionModelPickerEntry {
  const serverId = address?.serverId ?? null;
  const sessionId = address?.sessionId ?? null;
  const readOffer = React.useCallback(
    () =>
      serverId && sessionId
        ? readSessionComposerActionChipOffer(
            { serverId, sessionId },
            SESSION_MODEL_PICKER_CHIP_KEY,
          )
        : ('no_composer' as const),
    [serverId, sessionId],
  );
  const offer = React.useSyncExternalStore(
    subscribeSessionComposerPresentationTargets,
    readOffer,
    readOffer,
  );
  const open = React.useCallback(() => {
    if (serverId && sessionId)
      requestRegisteredSessionComposerActionChip(
        { serverId, sessionId },
        SESSION_MODEL_PICKER_CHIP_KEY,
      );
  }, [serverId, sessionId]);
  return React.useMemo(
    () => ({ offered: offer === 'offered', open }),
    [offer, open],
  );
}
