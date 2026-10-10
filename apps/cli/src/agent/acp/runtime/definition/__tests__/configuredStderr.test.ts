import '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { KIRO_ACP_STDERR_RULES } from '@happier-dev/plugins-kiro/agent/acp/transport';
import { normalizeConfiguredAcpDefinition } from '../configured';
import { createAcpTransportHandlerFromDefinition } from '../transport';

describe('configured ACP transport rules', () => {
  it('preserves retained declarative stderr suppression without hiding ordinary executable errors', () => {
    const backend = {
      backendId: 'retained-kiro', source: { kind: 'account_configured' as const },
      name: 'retained-kiro', title: 'Retained', command: 'kiro-cli', args: ['acp'], env: {},
      capabilities: { supportsLoadSession: true, supportsModes: 'unknown' as const, supportsModels: 'unknown' as const,
        supportsConfigOptions: 'unknown' as const, promptImageSupport: 'no' as const },
      runtime: { stderrRules: KIRO_ACP_STDERR_RULES },
    };
    const handler = createAcpTransportHandlerFromDefinition(normalizeConfiguredAcpDefinition({ backend }));
    const rule = KIRO_ACP_STDERR_RULES.suppress[0];
    const context = { activeToolCalls: new Set<string>(), hasActiveInvestigation: false };
    expect(handler.handleStderr?.(rule.includes.join(' '), context)).toEqual({ message: null, suppress: true });
    expect(handler.handleStderr?.('ordinary executable failure', context)).not.toEqual({ message: null, suppress: true });
  });
});
