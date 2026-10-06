import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

import {
  isCapturedVoiceExecutionMachineCurrent,
  resolveVoiceExecutionMachineIdFromState,
  resolveVoiceExecutionMachineSelectionFromState,
} from './executionMachine';

function machine(id: string, active: boolean, extra: Record<string, unknown> = {}) {
  return { id, active, createdAt: 1, updatedAt: 1, metadata: {}, ...extra } as any;
}

describe('resolveVoiceExecutionMachineIdFromState', () => {
  const settingsScope = { serverId: 'execution-home', accountId: 'execution-account' };
  beforeEach(() => useVoiceTargetStore.setState({ autoTargetMachineByScope: {} }));
  it('keeps an unresolved captured target current until the selected execution machine changes', () => {
    const previous = storage.getState();
    storage.setState({
      ...previous,
      settings: {
        ...previous.settings,
        voice: {
          ...previous.settings.voice,
          executionMachine: { mode: 'fixed', machineId: 'offline-machine' },
        },
      },
      machines: [],
    } as never);

    try {
      expect(isCapturedVoiceExecutionMachineCurrent(null)).toBe(true);
      expect(isCapturedVoiceExecutionMachineCurrent('machine-a')).toBe(false);
    } finally {
      storage.setState(previous, true);
    }
  });

  it('keeps a captured selected machine current after it becomes unreachable, but invalidates a new selection', () => {
    const previous = storage.getState();
    storage.setState({
      ...previous,
      settings: {
        ...previous.settings,
        voice: {
          ...previous.settings.voice,
          executionMachine: { mode: 'fixed', machineId: 'machine-a' },
        },
      },
      machines: {
        'machine-a': machine('machine-a', true, { activeAt: Date.now() }),
      },
    } as never);

    try {
      expect(isCapturedVoiceExecutionMachineCurrent('machine-a')).toBe(true);

      storage.setState({
        ...storage.getState(),
        machines: {
          'machine-a': machine('machine-a', false),
        },
      } as never);

      expect(isCapturedVoiceExecutionMachineCurrent('machine-a')).toBe(true);

      storage.setState({
        ...storage.getState(),
        settings: {
          ...storage.getState().settings,
          voice: {
            ...storage.getState().settings.voice,
            executionMachine: { mode: 'fixed', machineId: 'machine-b' },
          },
        },
        machines: {
          'machine-a': machine('machine-a', false),
          'machine-b': machine('machine-b', true, { activeAt: Date.now() }),
        },
      } as never);

      expect(isCapturedVoiceExecutionMachineCurrent('machine-a')).toBe(false);
    } finally {
      storage.setState(previous, true);
    }
  });

  it('resolves fixed and sticky-auto targets without requiring a voice-home directory', () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(settingsScope, 'sticky');
    const state = {
      settingsScope,
      machines: { fixed: machine('fixed', true), sticky: machine('sticky', true) },
      settings: {
        voice: {
          executionMachine: { mode: 'fixed', machineId: 'fixed' },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('fixed');
    state.settings.voice.executionMachine.mode = 'auto';
    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('sticky');
  });

  it('follows a replacement only when the canonical daemon is active', () => {
    const state = {
      machines: {
        old: machine('old', false, { replacedByMachineId: 'replacement' }),
        replacement: machine('replacement', true),
      },
      settings: {
        voice: {
          executionMachine: { mode: 'fixed', machineId: 'old' },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('replacement');
    state.machines.replacement.active = false;
    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe(null);
    expect(resolveVoiceExecutionMachineSelectionFromState(state)).toEqual({
      kind: 'selected_unreachable',
      machineId: 'replacement',
    });
  });

  it('uses the canonical online grace rule for a recently disconnected fixed machine', () => {
    const state = {
      machines: {
        fixed: machine('fixed', false, { activeAt: Date.now() - 1_000 }),
      },
      settings: {
        voice: {
          executionMachine: { mode: 'fixed', machineId: 'fixed' },
        },
      },
    };

    expect(resolveVoiceExecutionMachineSelectionFromState(state)).toEqual({
      kind: 'resolved',
      machineId: 'fixed',
    });
  });

  it('fails closed instead of roaming when a sticky target disconnects', () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(settingsScope, 'sticky');
    const state = {
      settingsScope,
      machines: {
        sticky: machine('sticky', false),
        another: machine('another', true),
      },
      settings: {
        voice: {
          executionMachine: { mode: 'auto', machineId: null },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe(null);
  });

  it('uses the canonical preferred-machine ordering only before a sticky auto target exists', () => {
    const state = {
      machines: {
        older: machine('older', true, { createdAt: 1 }),
        newer: machine('newer', true, { createdAt: 2 }),
      },
      authoringMemory: {
        recentMachinePaths: [{ machineId: 'older', path: '/repo' }],
      },
      settings: {
        voice: {
          executionMachine: { mode: 'auto', machineId: null },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('older');
  });

  it('honors a scoped override without rewriting the persisted default', () => {
    const state = {
      machines: { global: machine('global', true), scoped: machine('scoped', true) },
      settings: {
        voice: {
          executionMachine: { mode: 'fixed', machineId: 'global' },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state, { machineId: 'scoped' })).toBe('scoped');
    expect(state.settings.voice.executionMachine.machineId).toBe('global');
  });

  it('resolves the migrated legacy nested fixed target before choosing an automatic machine', () => {
    const state = {
      machines: {
        wrong: machine('wrong', true),
        configured: machine('configured', true),
      },
      settings: {
        voice: {
          adapters: {
            local_conversation: {
              agent: {
                machineTargetMode: 'fixed',
                machineTargetId: 'configured',
              },
            },
          },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('configured');
  });

  it('fails closed for malformed canonical machine settings instead of choosing another daemon', () => {
    const state = {
      machines: { wrong: machine('wrong', true) },
      settings: {
        voice: {
          executionMachine: { mode: 'fixed', machineId: 42 },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe(null);
  });
});
