import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

describe('Kiro agent definition', () => {
  it('owns Kiro runtime, model, and profile facts as plugin data', async () => {
    const definitionUrl = new URL('./definition.ts', import.meta.url);

    expect(existsSync(definitionUrl)).toBe(true);
    if (!existsSync(definitionUrl)) return;

    const module = await import('./definition.js') as { AGENT_DEFINITION?: unknown };
    const definition = requireRecord(module.AGENT_DEFINITION, 'AGENT_DEFINITION');

    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
    expect(definition).toMatchObject({
      id: 'kiro',
      core: {
        id: 'kiro',
        cliSubcommand: 'kiro',
        detectKey: 'kiro-cli',
        flavorAliases: ['kiro-cli'],
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'kiroSessionId' },
        sessionStorage: { direct: true, persisted: true },
        handoff: { vendorStateTransfer: 'unsupported' },
        localControl: { supported: true, topology: 'exclusive', attachStrategy: 'unsupported' },
        tools: { delivery: 'native_mcp', support: 'supported' },
      },
      sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
      sessionModesKind: 'acpAgentModes',
      modelConfig: {
        supportsSelection: true,
        supportsFreeform: true,
        nonAcpApplyScope: 'next_prompt',
        acpApplyBehavior: 'set_model',
        acpModelConfigOptionId: 'model',
        dynamicProbe: 'static-only',
        defaultMode: 'default',
        allowedModes: ['default'],
      },
    });
    expect(definition).not.toHaveProperty('agentCliRuntime');
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli).toMatchObject({
      executable: { binaryName: 'kiro-cli' },
      auth: {
        support: 'login_terminal',
        probe: { parser: 'kiroWhoamiJson' },
      },
    });
  });
});
