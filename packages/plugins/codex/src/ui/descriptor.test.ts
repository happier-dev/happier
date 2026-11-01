import { describe, expect, it } from 'vitest';

import { CODEX_UI_DESCRIPTOR } from './descriptor.js';

describe('CODEX_UI_DESCRIPTOR context window fallback', () => {
  it('pins the current Codex catalog fallback windows', () => {
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
      capabilityDriven: true,
    });
    expect(CODEX_UI_DESCRIPTOR.behavior.payload.sessionExtras).toEqual({
      outputKey: 'codexBackendMode',
      values: ['acp', 'appServer'],
      settingKey: { scope: 'account', localId: 'codexBackendMode' },
      aliases: {
        mcp: 'mcp',
        mcp_resume: 'acp',
      },
      defaultValue: 'appServer',
    });
    expect(JSON.stringify(CODEX_UI_DESCRIPTOR)).not.toContain('agentRuntimeDescriptorV1');
    expect(JSON.stringify(CODEX_UI_DESCRIPTOR)).not.toContain('providerExtra');
  });

  it('leaves runtime-descriptor interpretation to the Agent runtime', () => {
    expect(CODEX_UI_DESCRIPTOR.behavior.payload).not.toHaveProperty('backendTransport');
    expect(CODEX_UI_DESCRIPTOR.behavior.externalSessions.browse.linkEnsureRequestExtras)
      .not.toHaveProperty('runtimeDescriptorFromCandidate');
  });
});
