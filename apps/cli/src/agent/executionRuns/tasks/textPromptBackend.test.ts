import { beforeEach, describe, expect, it, vi } from 'vitest';

const createExecutionRunRuntimeMock = vi.fn();
const readCredentialsMock = vi.fn();
const bootstrapAccountSettingsContextMock = vi.fn();

vi.mock('@/agent/runtime/bridges/executionRun/runtime/create', () => ({
  createExecutionRunRuntime: (...args: unknown[]) => createExecutionRunRuntimeMock(...args),
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: (...args: unknown[]) => bootstrapAccountSettingsContextMock(...args),
}));

import { createExecutionRunTextPromptBackendForTarget } from './textPromptBackend';

describe('createExecutionRunTextPromptBackendForTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createExecutionRunRuntimeMock.mockReturnValue({});
  });

  it('passes backendTarget and account settings through for built-in agents', async () => {
    bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { codexBackendMode: 'acp' } });
    readCredentialsMock.mockResolvedValue({ token: 'cred-1' });

    await createExecutionRunTextPromptBackendForTarget({
      cwd: '/tmp/workspace',
      sessionId: 'sess-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'no_tools',
      intent: 'replay_summary',
    });

    expect(createExecutionRunRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      accountSettings: { codexBackendMode: 'acp' },
    }));
  });

  it('routes configured ACP targets through the canonical execution-run backend path', async () => {
    bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { backendEnabledByTargetKey: { 'acpBackend:review-bot': true } } });
    readCredentialsMock.mockResolvedValue({ token: 'cred-1' });

    await createExecutionRunTextPromptBackendForTarget({
      cwd: '/tmp/workspace',
      sessionId: 'sess-1',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'no_tools',
      intent: 'replay_summary',
    });

    expect(createExecutionRunRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'review-bot',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      accountSettings: { backendEnabledByTargetKey: { 'acpBackend:review-bot': true } },
    }));
  });
});
