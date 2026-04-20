import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration MCP tool call timeouts', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS',
    'HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  const tempDirs: string[] = [];

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      removeTempDirSync(tempDir);
    }
    tempDirs.length = 0;
  });

  function setHomeDir(): void {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
  }

  it('defaults MCP tool calls to a long SDK request timeout', async () => {
    setHomeDir();
    delete process.env.HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS;
    delete process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.mcpToolCallTimeoutMs).toBe(100_000_000);
    expect(configMod.configuration.mcpToolCallTimeoutMs).toBeGreaterThan(60_000);
    expect(configMod.configuration.mcpExecutionRunWaitTimeoutGraceMs).toBe(60_000);
  });

  it('reads MCP tool call timeout overrides from configuration env', async () => {
    setHomeDir();
    process.env.HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS = '240000';
    process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS = '45000';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.mcpToolCallTimeoutMs).toBe(240_000);
    expect(configMod.configuration.mcpExecutionRunWaitTimeoutGraceMs).toBe(45_000);
  });
});
