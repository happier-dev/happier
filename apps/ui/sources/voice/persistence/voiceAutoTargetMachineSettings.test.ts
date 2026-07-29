import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceStorageModuleMocks } from './installVoiceStorageModuleMocks';

const applySettingsLocal = vi.fn();
let state: any;

installVoiceStorageModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => state,
      },
    });
  },
});

describe('voiceAutoTargetMachineSettings', () => {
  beforeEach(() => {
    vi.resetModules();
    applySettingsLocal.mockReset();
    state = {
      settings: {
        voice: {
          executionMachine: {
            mode: ' auto ',
            autoMachineId: '  machine-1  ',
          },
        },
      },
      applySettingsLocal,
    };
  });

  it('reads a trimmed sticky auto-target machine id when the mode is auto', async () => {
    const { readVoiceAutoTargetMachineId } = await import('./voiceAutoTargetMachineSettings');

    expect(readVoiceAutoTargetMachineId(state)).toBe('machine-1');
  });

  it('persists a sticky auto-target machine id when the mode is auto even if it is padded', async () => {
    const { persistVoiceAutoTargetMachineId } = await import('./voiceAutoTargetMachineSettings');

    persistVoiceAutoTargetMachineId('  machine-2  ');

    expect(applySettingsLocal).toHaveBeenCalledWith({
      voice: expect.objectContaining({
        executionMachine: {
          mode: 'auto',
          machineId: null,
          autoMachineId: 'machine-2',
        },
      }),
    });
  });
});
