import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionNativeToolDescriptors } from './resolveSessionNativeToolBridge';

const originalActionsSettingsEnv = process.env.HAPPIER_ACTIONS_SETTINGS_V1;

beforeEach(() => {
  delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
});

afterEach(() => {
  if (originalActionsSettingsEnv === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = originalActionsSettingsEnv;
});

describe('resolveSessionNativeToolDescriptors', () => {
  it('uses the canonical direct catalog and promotes memory only while recall guidance is active', () => {
    const base = resolveSessionNativeToolDescriptors({
      accountSettings: {},
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: false,
    });
    expect(base.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'change_title',
      'action_spec_search',
      'action_spec_get',
      'action_options_resolve',
      'action_execute',
    ]));
    expect(base.map((tool) => tool.name)).not.toContain('memory_search');

    const withMemory = resolveSessionNativeToolDescriptors({
      accountSettings: {},
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: true,
    });
    expect(withMemory.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'memory_search',
      'memory_get_window',
    ]));
    const search = withMemory.find((tool) => tool.name === 'memory_search');
    const window = withMemory.find((tool) => tool.name === 'memory_get_window');
    expect(search?.inputSchema).not.toMatchObject({ required: expect.arrayContaining(['machineId']) });
    expect(window?.inputSchema).toMatchObject({ required: expect.arrayContaining(['sessionId']) });
    expect(window?.inputSchema).not.toMatchObject({ required: expect.arrayContaining(['machineId']) });
  });

  it('honors profile title disabling and explicit discoverable-only memory exposure', () => {
    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {
        codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'agent' },
        profiles: [{
          v: 2,
          id: 'focused',
          name: 'Focused',
          extraEnvironmentVariables: [],
          defaultPermissionModeByTargetKey: {},
          defaultPersistenceModeByTargetKey: {},
          compatibilityByTargetKey: {},
          codingPromptBehaviorOverrides: { sessionTitleUpdates: 'disabled' },
          createdAt: 1,
          updatedAt: 1,
        }],
        actionsSettingsV1: {
          v: 1,
          actions: {
            'memory.search': { toolExposureModes: { agent: 'discoverable_only' } },
          },
        },
      },
      profileId: 'focused',
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).not.toContain('change_title');
    expect(tools.map((tool) => tool.name)).not.toContain('memory_search');
    expect(tools.map((tool) => tool.name)).toContain('memory_get_window');
  });

  it('omits the title tool when its canonical action is disabled', () => {
    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: { 'session.title.set': { enabled: false } },
        },
      },
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).not.toContain('change_title');
  });

  it('uses the environment action policy override for native presentation', () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'memory.search': { toolExposureModes: { agent: 'discoverable_only' } },
      },
    });

    const tools = resolveSessionNativeToolDescriptors({
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'memory.search': { toolExposureModes: { agent: 'direct' } },
          },
        },
      },
      profileId: null,
      sessionId: 'session-1',
      sessionMachineId: 'machine-1',
      memoryRecallGuidanceEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).not.toContain('memory_search');
  });
});
