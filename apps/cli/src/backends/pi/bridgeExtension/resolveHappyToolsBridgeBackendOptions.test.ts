import { existsSync, readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { resolveHappyToolsBridgeBackendOptions } from './resolveHappyToolsBridgeBackendOptions';
import { resolvePiBridgeExtensionPath } from './piBridgeExtensionAssets';

const TEMP_DIRS = new Set<string>();

function tempAgentDir(): string {
  const dir = createTempDirSync('happier-pi-bridge-resolve-');
  TEMP_DIRS.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
  TEMP_DIRS.clear();
});

describe('resolveHappyToolsBridgeBackendOptions', () => {
  it('returns null when Happier does not control the Pi agent dir', async () => {
    expect(await resolveHappyToolsBridgeBackendOptions({
      agentDir: null,
      settings: null,
      memoryRecallGuidanceEnabled: true,
    })).toBeNull();

    expect(await resolveHappyToolsBridgeBackendOptions({
      agentDir: '',
      settings: null,
      memoryRecallGuidanceEnabled: true,
    })).toBeNull();
  });

  it('materializes the asset and derives disable flags from the same prompt signals', async () => {
    const agentDir = tempAgentDir();

    const enabled = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: null,
      memoryRecallGuidanceEnabled: true,
    });
    expect(enabled).not.toBeNull();
    expect(enabled?.disableRename).toBe(false);
    expect(enabled?.disableMemory).toBe(false);
    expect(enabled?.extensionPath).toBe(resolvePiBridgeExtensionPath(agentDir));
    expect(existsSync(enabled!.extensionPath)).toBe(true);

    const content = readFileSync(enabled!.extensionPath, 'utf8');
    expect(content).toContain('const RENAME_ENABLED = true;');
    expect(content).toContain('const MEMORY_ENABLED = true;');
  });

  it('disables rename when the session title updates mode is disabled in settings', async () => {
    const agentDir = tempAgentDir();
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'disabled' } },
      memoryRecallGuidanceEnabled: true,
    });
    expect(resolved?.disableRename).toBe(true);
    expect(resolved?.disableMemory).toBe(false);

    const content = readFileSync(resolved!.extensionPath, 'utf8');
    expect(content).toContain('const RENAME_ENABLED = false;');
  });

  it('disables memory tools when memory recall guidance is disabled', async () => {
    const agentDir = tempAgentDir();
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: null,
      memoryRecallGuidanceEnabled: false,
    });
    expect(resolved?.disableRename).toBe(false);
    expect(resolved?.disableMemory).toBe(true);

    const content = readFileSync(resolved!.extensionPath, 'utf8');
    expect(content).toContain('const MEMORY_ENABLED = false;');
  });

  it('bakes a Happier CLI launch spec into the asset', async () => {
    const agentDir = tempAgentDir();
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: null,
      memoryRecallGuidanceEnabled: true,
    });
    const content = readFileSync(resolved!.extensionPath, 'utf8');
    expect(content).toMatch(/const HAPPIER_CLI_FILE_PATH = ".*";/);
    const prefixMatch = content.match(/const HAPPIER_CLI_ARG_PREFIX = (\[.*?\]);/s);
    expect(prefixMatch).not.toBeNull();
    // The prefix ends just before the `tools` subcommand, which the bridge appends per call.
    const prefix = JSON.parse(prefixMatch![1]) as string[];
    expect(Array.isArray(prefix)).toBe(true);
    expect(prefix[prefix.length - 1]).not.toBe('tools');
    expect(prefix.length).toBeGreaterThan(0);
  });
});
