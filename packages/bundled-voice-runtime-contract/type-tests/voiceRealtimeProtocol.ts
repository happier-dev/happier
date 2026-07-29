import type { VoiceRealtimeCanonicalEvent } from '../src/index.js';

const rawProviderEvent: VoiceRealtimeCanonicalEvent = {
  // @ts-expect-error Provider-native payloads must remain inside provider leaves.
  type: 'provider_event',
};

void rawProviderEvent;
