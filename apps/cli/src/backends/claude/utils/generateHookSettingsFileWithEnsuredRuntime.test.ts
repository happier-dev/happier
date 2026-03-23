import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureClaudeJsRuntimeExecutableMock = vi.fn(async () => '/managed/js-runtime');
const generateHookSettingsFileMock = vi.fn(() => '/tmp/generated-hooks.json');

vi.mock('@/backends/claude/utils/ensureClaudeJsRuntimeExecutable', () => ({
  ensureClaudeJsRuntimeExecutable: ensureClaudeJsRuntimeExecutableMock,
}));

vi.mock('./generateHookSettings', () => ({
  generateHookSettingsFile: generateHookSettingsFileMock,
}));

describe('generateHookSettingsFileWithEnsuredRuntime', () => {
  beforeEach(() => {
    ensureClaudeJsRuntimeExecutableMock.mockReset();
    generateHookSettingsFileMock.mockReset();
    ensureClaudeJsRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    generateHookSettingsFileMock.mockReturnValue('/tmp/generated-hooks.json');
  });

  it('ensures the Claude JS runtime before generating hook settings', async () => {
    const { generateHookSettingsFileWithEnsuredRuntime } = await import('./generateHookSettingsFileWithEnsuredRuntime');

    const filePath = await generateHookSettingsFileWithEnsuredRuntime(43124, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'secret',
    });

    expect(ensureClaudeJsRuntimeExecutableMock).toHaveBeenCalledBefore(generateHookSettingsFileMock);
    expect(generateHookSettingsFileMock).toHaveBeenCalledWith(43124, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'secret',
    });
    expect(filePath).toBe('/tmp/generated-hooks.json');
  });
});
