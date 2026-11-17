import * as React from 'react';
import type { PetAccountReferenceV1 } from '@happier-dev/protocol/pets/selection';

import { useEventCallback } from '@/hooks/ui/useEventCallback';

/**
 * "Use as a Bot's face…" (DECISIONS-R12 §10): the Store hands a pet to the Bot the person chose, whose own face
 * chooser then opens wearing it. The handoff lives in memory until that Bot's header takes it: the header's face editor
 * makes the one change and saves it, so the Store never writes a face itself. A handoff no header takes (the person
 * navigated elsewhere) is dropped by the next one.
 */
let pending: Readonly<{
  sessionId: string;
  pet: PetAccountReferenceV1;
}> | null = null;
const listeners = new Set<() => void>();

export function requestBotFaceWear(
  sessionId: string,
  pet: PetAccountReferenceV1,
): void {
  pending = { sessionId, pet };
  for (const listener of listeners) listener();
}

/** The pet handed to this Bot, once: reading it takes it. */
export function useBotFaceWearRequest(
  sessionId: string,
  onRequest: (pet: PetAccountReferenceV1) => void,
): void {
  const take = useEventCallback(() => {
    if (pending?.sessionId !== sessionId) return;
    const { pet } = pending;
    pending = null;
    onRequest(pet);
  });
  React.useEffect(() => {
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, [sessionId, take]);
}
