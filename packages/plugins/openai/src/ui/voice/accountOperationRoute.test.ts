import { describe, expect, it } from 'vitest';

import { BUNDLED_VOICE_UI_ENTRIES } from './index.js';

describe('OpenAI Realtime account-operation route', () => {
  const resolveAccountOperationTarget =
    BUNDLED_VOICE_UI_ENTRIES[0].internal.resolveAccountOperationTarget!;

  it('keeps all three authentication sources explicit with no cross-source fallback', () => {
    expect(resolveAccountOperationTarget({
      authentication: { source: 'voice_saved_secret' },
    })).toEqual({ kind: 'savedSecret' });
    expect(resolveAccountOperationTarget({
      authentication: { source: 'connected_service_api_key' },
    })).toEqual({
      kind: 'daemonAction',
      actionLocalId: 'mint-realtime-client-auth',
    });
    expect(resolveAccountOperationTarget({
      authentication: { source: 'connected_service_oauth' },
    })).toEqual({
      kind: 'daemonAction',
      actionLocalId: 'mint-realtime-client-auth-with-codex-oauth',
    });
    expect(() => resolveAccountOperationTarget({
      authentication: { source: 'unknown-source' },
    })).toThrow('openai_realtime_authentication_source_invalid');
  });
});
