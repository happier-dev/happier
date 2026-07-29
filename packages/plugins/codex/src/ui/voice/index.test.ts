import { describe, expect, it } from 'vitest';

import {
  BUNDLED_VOICE_UI_ENTRIES,
} from './index.js';

describe('Codex bundled Voice projection', () => {
  it('normalizes the manifest execution reference to the exact Agent identity', () => {
    const expectedAgent = {
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    };

    expect(BUNDLED_VOICE_UI_ENTRIES[0]?.declaration?.execution).toEqual({
      kind: 'experimental_agent_session_realtime',
      agent: expectedAgent,
    });
    expect(
      BUNDLED_VOICE_UI_ENTRIES[0]
        ?.internal.resolveSurfaceCapabilities?.({}),
    ).not.toHaveProperty('agentRuntime');
  });
});
