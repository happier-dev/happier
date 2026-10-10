import { SessionBotV1Schema, readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { SessionStateBinding } from '../_types.js';

/** Account metadata CAS arbitrates the display marker; it never reaches an Agent. */
export const sessionBotBinding: SessionStateBinding<'display.bot'> = {
  read: (metadata) => ({ value: readSessionBotV1(metadata.bot), updatedAt: null }),
  write: (metadata, update) => {
    const bot = update.value === null ? null : SessionBotV1Schema.parse(update.value);
    const { bot: _previousBot, ...rest } = metadata;
    const work = metadata.work && typeof metadata.work === 'object' && !Array.isArray(metadata.work)
      ? metadata.work : {};
    // Promotion changes identity, not an existing Session's memory choice.
    // An absent retained choice must keep the baseline it had before this write.
    const memoryEnabled = 'memoryEnabled' in work ? work.memoryEnabled : readSessionBotV1(metadata.bot) !== null;
    return { ...rest, ...(bot ? { bot } : {}), work: { ...work, memoryEnabled } };
  },
};
