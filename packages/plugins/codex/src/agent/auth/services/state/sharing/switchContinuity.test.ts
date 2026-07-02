import { describe, expect, it } from 'vitest';

import {
  codexConnectedServiceSharedStateRequiredResult,
  resolveCodexConnectedServiceSwitchServiceSupport,
} from './switchContinuity.js';

describe('Codex connected-service switch continuity policy', () => {
  it('supports only the OpenAI Codex connected-service switch path', () => {
    expect(resolveCodexConnectedServiceSwitchServiceSupport('openai-codex')).toEqual({ supported: true });
    expect(resolveCodexConnectedServiceSwitchServiceSupport('openai')).toEqual({
      supported: false,
      result: { mode: 'unsupported', reason: 'codex_api_key_switch_continuity_unsupported' },
    });
    expect(resolveCodexConnectedServiceSwitchServiceSupport('anthropic')).toEqual({
      supported: false,
      result: { mode: 'unsupported', reason: 'unsupported_service' },
    });
  });

  it('declares the shared-state-required restart result', () => {
    expect(codexConnectedServiceSharedStateRequiredResult).toEqual({
      mode: 'restart_shared_state_required',
      reason: 'codex_shared_state_required',
    });
  });
});
