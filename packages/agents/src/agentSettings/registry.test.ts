import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { SettingDefinitionMap } from '@happier-dev/protocol';

import {
  assertAgentSettingsRegistryValid,
  getAgentSettingsDefaults,
  getAgentSettingsDefinition,
  getAgentSettingsFields,
  getAgentSettingsShape,
} from './registry.js';
import type { AgentSettingsDescriptor } from './types.js';

function makeDefinition(overrides: Partial<AgentSettingsDescriptor>): AgentSettingsDescriptor {
  const baseFields = {
    foo: {
      schema: z.string(),
      default: '',
      description: 'Foo',
      storageScope: 'account',
    },
  } satisfies SettingDefinitionMap;

  return {
    agentId: 'claude',
    fields: baseFields,
    ...overrides,
  };
}

describe('agent settings registry', () => {
  it('rejects duplicate setting keys across provider field maps', () => {
    const a = makeDefinition({ agentId: 'claude' as any });
    const b = makeDefinition({ agentId: 'codex' as any });

    expect(() => assertAgentSettingsRegistryValid([a, b])).toThrow(/defined more than once/i);
  });

  it('exposes field defaults from the canonical provider definition', () => {
    const codexDefinition = getAgentSettingsDefinition('codex');
    expect(codexDefinition).not.toBeNull();
    expect(codexDefinition?.fields.codexBackendMode?.default).toBe('appServer');

    const kimiDefinition = getAgentSettingsDefinition('kimi');
    expect(kimiDefinition).not.toBeNull();
    expect(kimiDefinition?.fields.kimiAcpPythonSelector?.default).toBe('auto');
  });

  it('resolves generated fields, defaults, and validation shapes by agent id', () => {
    expect(getAgentSettingsFields('kimi')?.kimiAcpPythonSelector.default).toBe('auto');
    expect(getAgentSettingsDefaults('kimi')).toEqual({
      kimiAcpPythonSelector: 'auto',
    });
    expect(getAgentSettingsShape('codex')?.codexBackendMode?.safeParse('mcp_resume').success).toBe(true);
  });

  it('exposes OpenCode agent settings from the generated plugin contribution', () => {
    expect(getAgentSettingsFields('opencode')?.opencodeBackendMode.default).toBe('server');
    expect(getAgentSettingsDefaults('opencode')).toEqual({
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: '',
      opencodeServerBaseUrlByServerIdV1: {},
    });
    expect(getAgentSettingsShape('opencode')?.opencodeBackendMode?.safeParse('acp').success).toBe(true);
  });
});
