import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useVoiceExecutionMachinePresentation } from './useExecutionMachinePresentation';

const initialState = storage.getState();

function machine(id: string, displayName: string) {
  return {
    id,
    active: true,
    createdAt: 1,
    updatedAt: 1,
    metadata: { displayName },
  } as any;
}

describe('useVoiceExecutionMachinePresentation', () => {
  afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
  });

  it('reacts when hydration supplies the canonical execution-machine selection', async () => {
    storage.setState({
      ...storage.getState(),
      machines: {},
      settings: {
        ...storage.getState().settings,
        voice: undefined as any,
      },
    });

    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    expect(hook.getCurrent()).toEqual({ selectedMachineId: null, machineId: null, machineLabel: null, selectionKind: 'none' });

    await act(async () => {
      storage.setState((state) => ({
        machines: {
          'machine-a': machine('machine-a', 'Machine A'),
        },
        settings: {
          ...state.settings,
          voice: {
            executionMachine: {
              mode: 'fixed',
              machineId: 'machine-a',
              autoMachineId: null,
            },
          } as any,
        },
      }));
      await Promise.resolve();
    });

    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-a', machineId: 'machine-a', machineLabel: 'Machine A', selectionKind: 'resolved' });
  });

  it('labels an unnamed execution machine as unnamed, never by its id', async () => {
    storage.setState((state) => ({
      machines: { 'f98b860d-63e0': { ...machine('f98b860d-63e0', ''), metadata: {} } },
      settings: {
        ...state.settings,
        voice: { executionMachine: { mode: 'fixed', machineId: 'f98b860d-63e0', autoMachineId: null } } as any,
      },
    }));
    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    expect(hook.getCurrent().machineLabel).toBe(t('machine.unnamedMachine'));
  });

  it('reacts to a committed machine replacement and its label', async () => {
    storage.setState({
      ...storage.getState(),
      machines: {
        'machine-a': machine('machine-a', 'Machine A'),
        'machine-b': machine('machine-b', 'Machine B'),
      },
      settings: {
        ...storage.getState().settings,
        voice: {
          executionMachine: {
            mode: 'fixed',
            machineId: 'machine-a',
            autoMachineId: null,
          },
        } as any,
      },
    });

    const hook = await renderHook(() => useVoiceExecutionMachinePresentation());
    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-a', machineId: 'machine-a', machineLabel: 'Machine A', selectionKind: 'resolved' });

    await act(async () => {
      storage.setState((state) => ({
        settings: {
          ...state.settings,
          voice: {
            ...(state.settings.voice as any),
            executionMachine: {
              mode: 'fixed',
              machineId: 'machine-b',
              autoMachineId: null,
            },
          },
        },
      }));
      await Promise.resolve();
    });

    expect(hook.getCurrent()).toEqual({ selectedMachineId: 'machine-b', machineId: 'machine-b', machineLabel: 'Machine B', selectionKind: 'resolved' });
  });
});
