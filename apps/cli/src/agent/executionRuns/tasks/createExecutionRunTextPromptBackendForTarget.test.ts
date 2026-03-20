import { beforeEach, describe, expect, it, vi } from 'vitest';

const createExecutionRunBackendMock = vi.fn();
const readCredentialsMock = vi.fn();
const bootstrapAccountSettingsContextMock = vi.fn();

vi.mock('@/agent/executionRuns/runtime/createExecutionRunBackend', () => ({
  createExecutionRunBackend: (...args: unknown[]) => createExecutionRunBackendMock(...args),
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: (...args: unknown[]) => bootstrapAccountSettingsContextMock(...args),
}));

import { createExecutionRunTextPromptBackendForTarget } from './createExecutionRunTextPromptBackendForTarget';

describe('createExecutionRunTextPromptBackendForTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createExecutionRunBackendMock.mockReturnValue({});
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

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
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

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      accountSettings: { backendEnabledByTargetKey: { 'acpBackend:review-bot': true } },
    }));
  });
});
