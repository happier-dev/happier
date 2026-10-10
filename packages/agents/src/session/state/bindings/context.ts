import { z } from 'zod';
import { readSessionMemoryEnabledV1, writeSessionContextIntentV1ToMetadata } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { SessionStateBinding } from './_types.js';
import { readSessionVoicePreferenceV1, writeSessionVoicePreferenceV1ToMetadata } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';

export const sessionVoicePreferenceBinding: SessionStateBinding<'intent.voicePreference'> = {
  read: (metadata) => {
    const work = metadata.work;
    return { value: readSessionVoicePreferenceV1(work && typeof work === 'object' && 'voicePreference' in work
      ? work.voicePreference : undefined), updatedAt: null };
  },
  write: (metadata, update) => writeSessionVoicePreferenceV1ToMetadata(metadata, update.value),
};

export const sessionMemoryEnabledBinding: SessionStateBinding<'intent.memoryEnabled'> = {
  read: (metadata) => ({ value: readSessionMemoryEnabledV1(metadata), updatedAt: null }),
  write: (metadata, update) => {
    const work = metadata.work && typeof metadata.work === 'object' ? metadata.work : {};
    return { ...metadata, work: { ...work, memoryEnabled: z.boolean().parse(update.value) } };
  },
};
export const sessionContextBinding: SessionStateBinding<'intent.context'> = {
  // Context is an entry intent, never a second whole-stack representation.
  read: () => ({ value: null, updatedAt: null }),
  write: (metadata, update) => writeSessionContextIntentV1ToMetadata(metadata, update.value),
};
