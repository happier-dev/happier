import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { activate, VOICE_PROVIDER_PRESENTATIONS } from './index.native.js';
import { activate as activateNativeRuntime } from './runtime.native.js';

describe('xAI native voice entry', () => {
  it('projects the executable native runtime instead of retaining a presentation-only entry', async () => {
    expect(VOICE_PROVIDER_PRESENTATIONS[0]?.providerId)
      .toBe('happier.voice.xai/realtime-grok');
    expect(activate).toBe(activateNativeRuntime);

    const register = vi.fn();
    activate({ voiceProviders: { register } });
    expect(register).toHaveBeenCalledWith('realtime-grok', expect.any(Object));

    const source = await readFile(new URL('./index.native.ts', import.meta.url), 'utf8');
    expect(source).toContain("from './runtime.native.js'");
  });
});
