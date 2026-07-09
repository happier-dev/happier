import { describe, expect, it } from 'vitest';

describe('createBuiltinVoiceAdapters', () => {
  it('registers the realtime, local-direct, and local-conversation adapters', async () => {
    const { createBuiltinVoiceAdapters } = await import('./registerBuiltinVoiceAdapters');
    const ids = createBuiltinVoiceAdapters().map((adapter) => adapter.id);

    expect(ids).toEqual(['realtime_elevenlabs', 'local_direct', 'local_conversation']);
  });

  it('includes the realtime elevenlabs adapter so web can use the unified voice manager', async () => {
    const { createBuiltinVoiceAdapters } = await import('./registerBuiltinVoiceAdapters');
    const ids = createBuiltinVoiceAdapters().map((adapter) => adapter.id);

    expect(ids).toContain('realtime_elevenlabs');
  });
});
