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
  delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
});

describe('resolveHappyToolsBridgeBackendOptions', () => {
  it('returns null when Happier does not control the Pi agent dir', async () => {
    expect(await resolveHappyToolsBridgeBackendOptions({
      agentDir: null,
      sessionId: 'happy-session-1',
      settings: null,
      memoryRecallGuidanceEnabled: true,
    })).toBeNull();
  });

  it('materializes a config-independent asset and resolves the canonical session tool manifest', async () => {
    const agentDir = tempAgentDir();
    const enabled = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      sessionId: 'happy-session-1',
      settings: null,
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
    });

    expect(enabled).not.toBeNull();
    expect(enabled?.sessionConfig.sessionId).toBe('happy-session-1');
    expect(enabled?.sessionConfig.directTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'change_title',
      'action_spec_search',
      'action_spec_get',
      'action_options_resolve',
      'action_execute',
      'memory_search',
      'memory_get_window',
    ]));
    expect(enabled?.sessionConfig.promptAddition).toContain('memory_search');
    expect(enabled?.extensionPath).toBe(resolvePiBridgeExtensionPath(agentDir));
    expect(existsSync(enabled!.extensionPath)).toBe(true);

    const content = readFileSync(enabled!.extensionPath, 'utf8');
    expect(content).not.toContain('happy-session-1');
    expect(content).not.toContain('memory_search');
  });

  it('keeps title guidance and tool registration on one effective profile decision', async () => {
    const agentDir = tempAgentDir();
    const disabled = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      sessionId: 'happy-session-1',
      settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'disabled', responseOptions: 'agent' } },
      memoryRecallGuidanceEnabled: false,
    });
    expect(disabled?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('change_title');
    expect(disabled?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('session_title_set');
    expect(disabled?.sessionConfig.promptAddition).not.toContain('change_title');
    expect(JSON.parse(disabled?.sessionConfig.launch.env.HAPPIER_ACTIONS_SETTINGS_V1 ?? '{}')).toMatchObject({
      actions: {
        'session.title.set': { enabled: false },
      },
    });
    const disabledExtensionContent = readFileSync(disabled!.extensionPath, 'utf8');

    const initial = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      sessionId: 'happy-session-1',
      settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'initial' } },
      memoryRecallGuidanceEnabled: false,
    });
    expect(initial?.sessionConfig.directTools.map((tool) => tool.name)).toContain('change_title');
    expect(initial?.sessionConfig.promptAddition).toContain('change_title');
    expect(readFileSync(initial!.extensionPath, 'utf8')).toBe(disabledExtensionContent);
  });

  it('does not expose a user-promoted title action when the effective profile disables titles', async () => {
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir: tempAgentDir(),
      sessionId: 'happy-session-1',
      settings: {
        codingPromptBehaviorV1: { sessionTitleUpdates: 'disabled' },
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.title.set': {
              enabled: true,
              toolExposureModes: { session_agent: 'direct' },
            },
          },
        },
      },
      memoryRecallGuidanceEnabled: false,
    });

    expect(resolved?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('session_title_set');
    expect(JSON.parse(resolved?.sessionConfig.launch.env.HAPPIER_ACTIONS_SETTINGS_V1 ?? '{}')).toMatchObject({
      actions: {
        'session.title.set': { enabled: false },
      },
    });
  });

  it('registers memory from the guidance requirement without probing mutable index readiness', async () => {
    const agentDir = tempAgentDir();
    const guidanceOff = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      sessionId: 'happy-session-1',
      settings: null,
      memoryRecallGuidanceEnabled: false,
      memoryMachineId: 'machine-1',
    });
    expect(guidanceOff?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('memory_search');

    const noMachineId = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      sessionId: 'happy-session-1',
      settings: null,
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: null,
    });
    expect(noMachineId?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('memory_search');

    const explicitlyDiscoverable = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      sessionId: 'happy-session-1',
      settings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'memory.search': { toolExposureModes: { session_agent: 'discoverable_only' } },
          },
        },
      },
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
    });
    expect(explicitlyDiscoverable?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('memory_search');
    expect(explicitlyDiscoverable?.sessionConfig.promptAddition).not.toContain('memory_search');
  });

  it('uses one environment-overridden action policy for registration and child execution', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'memory.search': { toolExposureModes: { session_agent: 'discoverable_only' } },
      },
    });
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir: tempAgentDir(),
      sessionId: 'happy-session-1',
      settings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'memory.search': { toolExposureModes: { session_agent: 'direct' } },
          },
        },
      },
      memoryRecallGuidanceEnabled: true,
      memoryMachineId: 'machine-1',
    });

    expect(resolved?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('memory_search');
    expect(JSON.parse(resolved?.sessionConfig.launch.env.HAPPIER_ACTIONS_SETTINGS_V1 ?? 'null')).toMatchObject({
      v: 1,
      actions: {
        'memory.search': { toolExposureModes: { session_agent: 'discoverable_only' } },
      },
    });
  });

  it('keeps the Happier CLI launch spec in the protected session config', async () => {
    const agentDir = tempAgentDir();
    const resolved = await resolveHappyToolsBridgeBackendOptions({
      agentDir,
      sessionId: 'happy-session-1',
      settings: null,
      memoryRecallGuidanceEnabled: false,
    });
    const content = readFileSync(resolved!.extensionPath, 'utf8');
    expect(content).not.toContain('HAPPIER_CLI_FILE_PATH');
    expect(resolved?.sessionConfig.launch.filePath).toBeTruthy();
    const prefix = resolved?.sessionConfig.launch.argPrefix ?? [];
    expect(prefix[prefix.length - 1]).not.toBe('tools');
    expect(prefix.length).toBeGreaterThan(0);
  });
});
