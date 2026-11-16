import { expect, it } from 'vitest';
import { resolveSessionCreationAgentTarget } from './resolveSessionCreationAgentTarget';
import { projectManifestAgentFields } from '@/plugins/projection/registry/projectManifestAgentFields';

it.each([true, false])('reads native sandbox support=%s from the admitted Agent declaration', supported => {
  const agent = projectManifestAgentFields({ pluginId: 'acme.sandbox-agent', provenance: 'external', source: { kind: 'path' },
    definition: { id: 'native', title: 'Native Agent', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        ...(supported ? { nativeSandbox: { off: true } } : {}) } } });
  expect(resolveSessionCreationAgentTarget({ kind: 'agent', identity: agent.identity }, {
    agentDefinitionsById: new Map([[agent.id, agent]]), pluginEnablementById: {},
  })).toMatchObject({ nativeSandboxAvailable: supported });
});

it.each(['plugin_account_execution_unavailable', 'plugin_disabled'] as const)(
  'preserves the catalog admission refusal %s for Session creators', code => {
    const catalog = {
      agentDefinitionsById: new Map(),
      pluginEnablementById: {
        'happier.agent.codex': { enabled: false, machineEnabled: true,
          accountEnabled: code === 'plugin_disabled' ? false : undefined,
          ...(code === 'plugin_account_execution_unavailable' ? { unavailableCode: code } : {}) },
      },
    };
    expect(() => resolveSessionCreationAgentTarget({ kind: 'agent', identity: {
      pluginId: 'happier.agent.codex', localId: 'codex',
    } }, catalog)).toThrow(expect.objectContaining({ code }));
    expect(resolveSessionCreationAgentTarget({ kind: 'agent', identity: {
      pluginId: 'absent.plugin', localId: 'unknown',
    } }, catalog)).toBeNull();
  },
);
