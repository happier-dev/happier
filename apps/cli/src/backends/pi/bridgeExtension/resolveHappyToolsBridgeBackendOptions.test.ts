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

  it('materializes a config-independent asset and derives the bridge config from prompt signals', async () => {
    const agentDir = tempAgentDir();

    const enabled = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: null,
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
    });
    expect(enabled).not.toBeNull();
    expect(enabled?.sessionRenameMode).toBe('ongoing');
    expect(enabled?.promptOptionsEnabled).toBe(true); // responseOptions defaults to 'agent'
    expect(enabled?.memoryMachineId).toBe('machine-1');
    expect(enabled?.extensionPath).toBe(resolvePiBridgeExtensionPath(agentDir));
    expect(existsSync(enabled!.extensionPath)).toBe(true);

    // The asset is config-independent: every behavior knob rides launch flags, so
    // sessions with different configs share one materialized file.
    const content = readFileSync(enabled!.extensionPath, 'utf8');
    expect(content).not.toContain('RENAME_ENABLED');
    expect(content).not.toContain('MEMORY_ENABLED');
  });

  it('resolves the rename mode and response options from settings', async () => {
    const agentDir = tempAgentDir();
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'disabled', responseOptions: 'agent' } },
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
    });
    expect(resolved?.sessionRenameMode).toBe('disabled');
    expect(resolved?.promptOptionsEnabled).toBe(true);

    const initial = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'initial' } },
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
    });
    expect(initial?.sessionRenameMode).toBe('initial');
    // The materialized asset does not change with config (one file for all configs).
    // Capture the first content BEFORE the second resolution so the comparison proves the
    // second call did not rewrite the asset, not just that both reads agree after the fact.
    const initialContent = readFileSync(initial!.extensionPath, 'utf8');
    const second = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: { codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'agent' } },
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
    });
    expect(second?.sessionRenameMode).toBe('ongoing');
    expect(readFileSync(second!.extensionPath, 'utf8')).toBe(initialContent);
  });

  it('binds memory to a machine id and disables it when guidance is off or no id is bound', async () => {
    const agentDir = tempAgentDir();

    const guidanceOff = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: null,
      memoryRecallGuidanceEnabled: false,
      memoryMachineId: 'machine-1',
    });
    expect(guidanceOff?.memoryMachineId).toBeNull();

    const noMachineId = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: null,
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: null,
    });
    expect(noMachineId?.memoryMachineId).toBeNull();
  });

  it('bakes a Happier CLI launch spec into the asset', async () => {
    const agentDir = tempAgentDir();
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      settings: null,
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
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
