import { describe, expect, it } from 'vitest';

import { OPENCODE_AGENT_RUNTIME_CONTRIBUTION } from './catalog.js';
import { OPENCODE_AGENT_RUNTIME_CONTRIBUTION as LEGACY_RUNTIME_CONTRIBUTION } from './runtime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

type SessionControlAdapter = Readonly<{
  normalizeRuntimeKindOverride?: (value: unknown) => 'server' | 'acp' | null;
  applyRuntimeKindOverrideToAccountSettings?: (
    accountSettings: Record<string, unknown> | null,
    runtimeKind: 'server' | 'acp',
  ) => Record<string, unknown> | null;
  resolveConfiguredRuntimeKind?: (accountSettings?: Record<string, unknown> | null) => 'server' | 'acp' | null;
  resolvePersistedSessionRuntimeKind?: (metadata: unknown) => 'server' | 'acp' | null;
  resolveVendorResumeId?: (metadata: unknown) => string | null;
}>;

type RuntimeContributionWithSessionControl = Readonly<{
  runtimeActivityApplicability?: 'supported' | 'unavailable' | 'not_applicable';
  sessionControlAdapter?: SessionControlAdapter;
  connectedServices?: Readonly<{
    requestAuthUses?: readonly unknown[];
    runtimeAuthAdapter?: false | Readonly<{
      classifyRuntimeAuthFailure?: (input: Readonly<{ error: unknown; selection?: unknown }>) => unknown;
      refreshActiveProfile?: (input: unknown) => Promise<unknown>;
      recoverAfterRuntimeAuthSwitch?: (input: unknown) => Promise<unknown>;
    }>;
  }>;
}>;

describe('OPENCODE_AGENT_RUNTIME_CONTRIBUTION', () => {
  it('preserves the legacy runtime entrypoint without private Session preferences', () => {
    expect(OPENCODE_AGENT_RUNTIME_CONTRIBUTION).toBe(LEGACY_RUNTIME_CONTRIBUTION);
    expect(OPENCODE_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('sessionRuntimePreferences');
  });

  it('declares the OpenCode CLI system tool in the manifest catalog', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(agent?.catalog?.agentCliSystemTool).toEqual({
      toolId: 'opencode-cli',
    });
  });

  it('declares exact request-auth materialization for every request-time purpose', () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_AGENT_RUNTIME_CONTRIBUTION;

    expect(contribution.connectedServices?.requestAuthUses).toEqual([{
      purpose: 'anthropic-model-request',
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.anthropic.com',
        headerNames: ['authorization'],
      },
    }, {
      purpose: 'openai-codex-model-request',
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
    }]);
  });

  it('does not opt OpenCode into Runtime Activity', () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_AGENT_RUNTIME_CONTRIBUTION;

    expect(contribution).not.toHaveProperty('runtimeActivityApplicability');
    expect(contribution).not.toHaveProperty('catalogControlAdapter');
  });

  it('leaves runtime-descriptor compatibility and session controls at the generated host projection', () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_AGENT_RUNTIME_CONTRIBUTION;

    expect(contribution).not.toHaveProperty('sessionControlAdapter');
    expect(contribution).not.toHaveProperty('runtimeDescriptorReader');
  });

  it('leaves exact request-auth failure recovery at the request interceptor', () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_AGENT_RUNTIME_CONTRIBUTION;
    const adapter = contribution.connectedServices?.runtimeAuthAdapter;

    expect(adapter).toBe(false);
  });

  it('leaves handoff media extraction to the Agent-native HandoffSurface', () => {
    expect(OPENCODE_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('sessionHandoff');
  });
});
