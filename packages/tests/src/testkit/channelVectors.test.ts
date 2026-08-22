import { describe, expect, it } from 'vitest';

import { CHANNEL_NEW_CREATION_VECTOR_V1 } from './channelVectors';

describe('Channels contract vectors', () => {
  it('pins the shared /new creation-key vector', () => {
    expect(CHANNEL_NEW_CREATION_VECTOR_V1).toEqual({
      bindingId: 'binding-01',
      commandOccurrenceId: 'telegram-update-9001',
      expectedCreationKey: 'channel-new:binding-01:telegram-update-9001',
    });
  });
});
