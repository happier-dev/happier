import { expect, it } from 'vitest';
import { resolveSessionCreationAgentTarget } from './resolveSessionCreationAgentTarget';

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
