import { describe, expect, it } from 'vitest';

import { CODEX_UI_DESCRIPTOR } from './descriptor.js';

describe('CODEX_UI_DESCRIPTOR context window fallback', () => {
  it('pins the current Codex catalog windows while leaving live snapshots authoritative', () => {
    expect(CODEX_UI_DESCRIPTOR.behavior.contextWindow).toEqual({
      defaultTokens: 372_000,
      modelRules: [
        { idSuffix: 'gpt-5.6-sol', tokens: 372_000 },
        { idSuffix: 'gpt-5.6-terra', tokens: 372_000 },
        { idSuffix: 'gpt-5.6-luna', tokens: 372_000 },
        { idSuffix: 'gpt-5.5', tokens: 272_000 },
        { idSuffix: 'gpt-5.4', tokens: 272_000 },
        { idSuffix: 'gpt-5.4-mini', tokens: 272_000 },
      ],
    });
  });

  it('publishes semantic runtime projection facts without raw compatibility paths', () => {
    expect(CODEX_UI_DESCRIPTOR.behavior.workState.editableGoals).toMatchObject({
      providerId: 'codex',
      modeValues: ['acp', 'appServer'],
      activeModeValues: ['appServer'],
    });
    expect(CODEX_UI_DESCRIPTOR.behavior.payload.sessionExtras).toEqual({
      providerId: 'codex',
      outputKey: 'codexBackendMode',
      values: ['acp', 'appServer'],
    });
    expect(JSON.stringify(CODEX_UI_DESCRIPTOR)).not.toContain('agentRuntimeDescriptorV1');
    expect(JSON.stringify(CODEX_UI_DESCRIPTOR)).not.toContain('providerExtra');
  });
});
