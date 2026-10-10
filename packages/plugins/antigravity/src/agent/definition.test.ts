import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('Antigravity agent definition', () => {
  it('admits negotiated ACP modes without inventing static choices', () => {
    expect(AGENT_DEFINITION).toMatchObject({
      sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
      sessionModesKind: 'acpAgentModes',
    });
    expect(AGENT_DEFINITION.core).not.toHaveProperty('sessionModes');
  });
  it('keeps provider identity and backend ownership as definition data', () => {
    expect(JSON.parse(JSON.stringify(AGENT_DEFINITION))).toEqual(AGENT_DEFINITION);
    expect(AGENT_DEFINITION).toMatchObject({
      id: 'antigravity',
      core: {
        id: 'antigravity',
        backendDefinition: false,
        cliSubcommand: 'antigravity',
        detectKey: 'agy',
        flavorAliases: ['agy'],
        connectedServices: {
          supportedServiceIds: ['gemini'],
        },
        sessionStorage: { direct: false, persisted: true },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'antigravitySessionId' },
        handoff: { vendorStateTransfer: 'unsupported' },
        localControl: {
          supported: true,
          topology: 'exclusive',
          attachStrategy: 'terminal_host',
        },
        tools: { delivery: 'native_mcp', support: 'experimental' },
      },
      settingsBackendId: 'antigravity',
      ownedBackendIds: ['antigravity'],
      // Released settings persisted the Agents toggle under the concrete
      // backend ids Antigravity used to own. The declarative ACP runtime
      // replaced those runtimes, but the persisted disabled/enabled state must
      // still project through the one compatibility reader.
      enablementCompatibilityBackendIds: ['antigravity-localharness', 'antigravity-terminal'],
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions');
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual([
      expect.objectContaining({
        service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
        credentialKinds: ['token'],
      }),
    ]);
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli).toMatchObject({
      executable: { binaryName: 'agy', sourcePreference: 'system-first' },
      install: { manual: { kind: 'vendor_recipe' } },
      auth: {
        support: 'login_terminal',
        machineLoginKey: 'antigravity-cli',
        loginLaunches: [{ kind: 'primary', target: 'agent_acp', args: [] }],
      },
    });
  });

  it('keeps model authority with the negotiated ACP session, carrying no CLI-derived fallback', () => {
    // Happier ACP sessions run the managed `agy_acp_server`; the interactive `agy`
    // CLI is a separate identity. `agy models` output is not a model source for
    // ACP sessions, so the ACP agent declaration carries no static model
    // fallback: models come from the ACP handshake of the live session.
    expect(AGENT_DEFINITION).not.toHaveProperty('modelConfig');
    expect(JSON.stringify(PLUGIN_MANIFEST)).not.toContain('Gemini 3.5');

    const agent = PLUGIN_MANIFEST.contributes.agents[0];
    expect(agent?.runtime).toMatchObject({
      kind: 'acp',
      transport: {
        kind: 'stdio',
        executable: { kind: 'managedDependency', id: 'agy-acp-server' },
      },
      definition: {
        auth: { methodId: 'oauth-personal' },
      },
    });
    expect(agent?.runtime).not.toHaveProperty('definition.models');
    expect(agent?.runtime).not.toHaveProperty('definition.defaultModel');
  });
});
