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
      modeValues: ['acp', 'appServer'],
      activeModeValues: ['appServer'],
    });
    expect(CODEX_UI_DESCRIPTOR.behavior.payload.sessionExtras).toEqual({
      outputKey: 'codexBackendMode',
      values: ['acp', 'appServer'],
      settingKey: 'codexBackendMode',
      aliases: {
        mcp: 'mcp',
        mcp_resume: 'acp',
      },
      defaultValue: 'appServer',
    });
    expect(JSON.stringify(CODEX_UI_DESCRIPTOR)).not.toContain('agentRuntimeDescriptorV1');
    expect(JSON.stringify(CODEX_UI_DESCRIPTOR)).not.toContain('providerExtra');
  });

  it('declares the spawn/resume backend transport instead of relying on a host-side Codex override', () => {
    expect(CODEX_UI_DESCRIPTOR.behavior.payload.backendTransport).toEqual({
      backendMode: {
        values: ['acp', 'appServer'],
        aliases: { mcp: 'mcp', mcp_resume: 'acp' },
        legacyExperimentalValue: 'acp',
      },
      runtimeHandleFields: [
        'backendMode',
        'providerSessionId',
        'home',
        'connectedServiceId',
        'connectedServiceProfileId',
        'connectedServiceGroupId',
        'homePath',
      ],
      agentExtra: {
        owner: 'codex',
        schemaId: 'codex.agentRuntimeDescriptorExtra',
        v: 1,
      },
    });
    // The declaration preserves each released spelling. `mcp_resume` retains
    // its ACP meaning; unavailable `mcp` reaches the plugin lifecycle ingress
    // unchanged so it fails closed instead of silently selecting App Server.
    expect(CODEX_UI_DESCRIPTOR.behavior.payload.backendTransport.backendMode.aliases).toMatchObject({
      mcp: 'mcp',
      mcp_resume: 'acp',
    });
  });
});
