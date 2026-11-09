import { SessionTurnProgressV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/turnProgress';

import type { SessionStateBinding } from '../_types.js';

export const sessionTurnProgressBinding: SessionStateBinding<'runtime.turnProgress'> = {
  read: metadata => {
    const parsed = SessionTurnProgressV1Schema.safeParse(metadata.sessionTurnProgressV1);
    return { value: parsed.success ? parsed.data : null, updatedAt: null };
  },
  write: (metadata, update) => {
    if (update.value === null) {
      if (metadata.sessionTurnProgressV1 === undefined) return metadata;
      const { sessionTurnProgressV1: _previous, ...next } = metadata;
      return next;
    }
    const previous = metadata.sessionTurnProgressV1;
    const progress = update.value;
    if (previous?.turnId === progress.turnId && previous.phase === progress.phase
      && previous.attempt === progress.attempt && previous.reason === progress.reason) return metadata;
    return { ...metadata, sessionTurnProgressV1: progress };
  },
};
