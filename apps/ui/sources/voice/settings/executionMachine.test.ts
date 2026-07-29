import { describe, expect, it } from 'vitest';

import { resolveVoiceExecutionMachineIdFromState } from './executionMachine';

function machine(id: string, active: boolean, extra: Record<string, unknown> = {}) {
  return { id, active, createdAt: 1, updatedAt: 1, metadata: {}, ...extra } as any;
}

describe('resolveVoiceExecutionMachineIdFromState', () => {
  it('resolves fixed and sticky-auto targets without requiring a voice-home directory', () => {
    const state = {
      machines: { fixed: machine('fixed', true), sticky: machine('sticky', true) },
      settings: {
        voice: {
          executionMachine: { mode: 'fixed', machineId: 'fixed', autoMachineId: 'sticky' },
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
          executionMachine: { mode: 'fixed', machineId: 'old', autoMachineId: null },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('replacement');
    state.machines.replacement.active = false;
    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe(null);
  });

  it('fails closed instead of roaming when a sticky target disconnects', () => {
    const state = {
      machines: {
        sticky: machine('sticky', false),
        another: machine('another', true),
      },
      settings: {
        voice: {
          executionMachine: { mode: 'auto', machineId: null, autoMachineId: 'sticky' },
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
      settings: {
        recentMachinePaths: [{ machineId: 'older', path: '/repo' }],
        voice: {
          executionMachine: { mode: 'auto', machineId: null, autoMachineId: null },
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
          executionMachine: { mode: 'fixed', machineId: 'global', autoMachineId: null },
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
          executionMachine: { mode: 'fixed', machineId: 42, autoMachineId: null },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe(null);
  });
});
