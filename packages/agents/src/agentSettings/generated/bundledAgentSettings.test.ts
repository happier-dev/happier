import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS } from './bundledAgentSettings.js';

describe('BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS', () => {
  it('contains Antigravity runtime mode agent settings as plugin-authored data', () => {
    const antigravity = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.find((entry) => entry.agentId === 'antigravity');

    expect(antigravity).toEqual(expect.objectContaining({
      id: 'antigravity.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(antigravity?.fields.map((field) => field.id)).toEqual(['antigravityRuntimeMode']);
    expect(antigravity?.fields[0]).toMatchObject({
      default: 'auto',
      schema: {
        kind: 'enum',
        values: ['auto', 'cliPrint', 'sdk'],
      },
    });
  });

  it('contains Codex and Kimi agent settings as plugin-authored data', () => {
    const codex = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.find((entry) => entry.agentId === 'codex');
    const kimi = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.find((entry) => entry.agentId === 'kimi');

    expect(codex).toEqual(expect.objectContaining({
      id: 'codex.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(codex?.fields.map((field) => field.id)).toEqual(['codexBackendMode']);

    expect(kimi).toEqual(expect.objectContaining({
      id: 'kimi.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(kimi?.fields.map((field) => field.id)).toEqual(['kimiAcpPythonSelector']);
  });

  it('contains Claude agent settings as plugin-authored data', () => {
    const claude = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.find((entry) => entry.agentId === 'claude');

    expect(claude).toEqual(expect.objectContaining({
      id: 'claude.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(claude?.fields.map((field) => field.id)).toContain('claudeRemoteAgentSdkEnabled');
    expect(claude?.fields.map((field) => field.id)).toContain('claudeUnifiedTerminalHost');
    expect(claude?.fields.map((field) => field.id)).toContain('claudeUnifiedTerminalResumeChoice');
    expect(claude?.ui.sections.find((section) => section.id === 'claudeUnifiedTerminal')?.fields).toEqual([
      'claudeUnifiedTerminalEnabled',
      'claudeUnifiedTerminalHost',
      'claudeUnifiedTerminalResumeChoice',
    ]);
  });

  it('contains ownerless descriptor providers as plugin-authored data', () => {
    const agentIds = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.map((entry) => entry.agentId);

    expect(agentIds).toEqual(expect.arrayContaining([
      'auggie',
      'copilot',
      'kilo',
      'kiro',
      'opencode',
      'pi',
    ]));

    for (const agentId of ['auggie', 'copilot', 'kilo', 'kiro', 'pi']) {
      const contribution = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.find((entry) => entry.agentId === agentId);

      expect(contribution).toEqual(expect.objectContaining({
        id: `${agentId}.agentSettings.v1`,
        kind: 'agentSettings.v1',
        storageScope: 'agentAccount',
      }));
      expect(contribution?.fields).toEqual([]);
    }

    const opencode = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.find((entry) => entry.agentId === 'opencode');
    expect(opencode?.fields.map((field) => field.id)).toEqual([
      'opencodeBackendMode',
      'opencodeServerBaseUrl',
      'opencodeServerBaseUrlByServerIdV1',
    ]);
  });
});
