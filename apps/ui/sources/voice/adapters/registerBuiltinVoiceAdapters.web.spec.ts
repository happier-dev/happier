import { describe, expect, it } from 'vitest';

describe('createBuiltinVoiceAdapters.web', () => {
  it('includes the realtime elevenlabs adapter so web can use the unified voice manager', async () => {
    const { createBuiltinVoiceAdapters } = await import('./registerBuiltinVoiceAdapters.web');
    const ids = createBuiltinVoiceAdapters().map((a) => a.id);
    expect(ids).toContain('realtime_elevenlabs');
  });
});

