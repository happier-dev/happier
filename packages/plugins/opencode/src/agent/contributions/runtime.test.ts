import { describe, expect, it, vi } from 'vitest';

import { OPENCODE_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

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
  agentCliSystemTool?: Readonly<{ toolId: string }>;
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
  it('binds native OpenCode launches to the declared CLI system tool', () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_AGENT_RUNTIME_CONTRIBUTION;

    expect(contribution.agentCliSystemTool).toEqual({
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

  it('projects the host-private handoff surface and replay-child launch resolver', async () => {
    const handoff = OPENCODE_AGENT_RUNTIME_CONTRIBUTION.sessionHandoff;
    const run = vi.fn();

    expect(handoff.surface({ exec: { run } })).toEqual(expect.objectContaining({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    }));
    await expect(handoff.resolveReplayChildLaunch({
      parentMetadata: {
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:49196',
        opencodeServerBaseUrlExplicit: true,
      },
    })).resolves.toEqual({
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49196/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
    });
  });
});
