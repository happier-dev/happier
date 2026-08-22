import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

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
    expect(hook.getCurrent()).toEqual({ machineId: null, machineLabel: null, selectionKind: 'none' });

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

    expect(hook.getCurrent()).toEqual({ machineId: 'machine-a', machineLabel: 'Machine A', selectionKind: 'resolved' });
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
    expect(hook.getCurrent()).toEqual({ machineId: 'machine-a', machineLabel: 'Machine A', selectionKind: 'resolved' });

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

    expect(hook.getCurrent()).toEqual({ machineId: 'machine-b', machineLabel: 'Machine B', selectionKind: 'resolved' });
  });
});
