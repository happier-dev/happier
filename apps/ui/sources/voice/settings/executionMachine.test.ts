import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveVoiceExecutionMachinePresentationFromState } from '@/voice/credentials/useExecutionMachinePresentation';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';

import {
  isCapturedVoiceExecutionMachineCurrent,
  resolveVoiceExecutionMachineIdFromState,
  resolveVoiceExecutionMachineSelectionFromState,
  projectVoiceExecutionMachineReadiness,
} from './executionMachine';

function machine(id: string, active: boolean, extra: Record<string, unknown> = {}) {
  return { id, active, createdAt: 1, updatedAt: 1, metadata: {}, ...extra } as any;
}

describe('resolveVoiceExecutionMachineIdFromState', () => {
  const settingsScope = { serverId: 'execution-home', accountId: 'execution-account' };
  const fixtureScope = { serverId: getAppliedActiveServerSnapshot().serverId, accountId: settingsScope.accountId };
  beforeEach(() => {
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
    clearMachineRequestReachabilityForTest();
    storage.setState({ profileScope: fixtureScope });
  });
  it('preserves a selected unobserved target without admitting it or declaring it offline', () => {
    const state = { profileScope: fixtureScope, machines: { selected: machine('selected', true, { activeAt: Date.now() }) },
      settings: { voice: { executionMachine: { mode: 'fixed', machineId: 'selected' } } } };
    withdrawMachinePresenceForScope(fixtureScope);
    const selection = resolveVoiceExecutionMachineSelectionFromState(state);
    expect(selection).toEqual({ kind: 'selected_unknown', machineId: 'selected' });
    expect(resolveVoiceExecutionMachineIdFromState(state)).toBeNull();
    expect(projectVoiceExecutionMachineReadiness(selection.kind, null)).toBe('unknown');
    captureMachinePresenceObservation(fixtureScope)(['selected']);
    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('selected');
    const offline = { ...state, machines: { selected: machine('selected', false, { activeAt: Date.now() - 97_000 }) } };
    expect(resolveVoiceExecutionMachineSelectionFromState(offline)).toEqual({ kind: 'selected_unreachable', machineId: 'selected' });
  });
  it('keeps a selected failed machine unreachable in its exact Account despite a fresh heartbeat', () => {
    const scope = { serverId: getAppliedActiveServerSnapshot().serverId, accountId: 'voice-account' };
    const state = { profileScope: scope, machines: { selected: machine('selected', true, { activeAt: Date.now() }) },
      settings: { voice: { executionMachine: { mode: 'fixed', machineId: 'selected' } } } };
    recordMachineRequestFailed({ ...scope, machineId: 'selected' });
    expect(resolveVoiceExecutionMachineSelectionFromState(state)).toEqual({ kind: 'selected_unreachable', machineId: 'selected' });
    expect(resolveVoiceExecutionMachineSelectionFromState({ ...state, profileScope: { ...scope, accountId: 'other-account' } }))
      .toEqual({ kind: 'resolved', machineId: 'selected' });
  });
  it('selects the Machine belonging to the applied Home while another Home is staged', () => {
    const original = getAppliedActiveServerSnapshot();
    const originalAvailable = isAppliedActiveServerRuntimeAvailable();
    const stagedServerId = getActiveServerSnapshot().serverId;
    const appliedServerId = `${stagedServerId}-execution-owner`;
    const state = {
      ...storage.getState(),
      profileScope: { serverId: appliedServerId, accountId: fixtureScope.accountId },
      machines: {},
      machineListByServerId: {
        [stagedServerId]: [machine('wrong-staged-machine', true)],
        [appliedServerId]: [machine('admitted-machine', true, { metadata: { displayName: 'Admitted machine', host: 'admitted-host' } })],
      },
      settings: { ...storage.getState().settings, voice: { ...storage.getState().settings.voice,
        executionMachine: { mode: 'auto' as const, machineId: null } } },
    };
    try {
      publishAppliedActiveServerSnapshot({ serverId: appliedServerId, serverUrl: 'https://execution-owner.test', generation: 1 });
      expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('admitted-machine');
      expect(resolveVoiceExecutionMachineIdFromState(state, { machineId: 'wrong-staged-machine' })).toBeNull();
      expect(resolveVoiceExecutionMachinePresentationFromState(state).machineLabel).toBe('Admitted machine');
    } finally {
      publishAppliedActiveServerSnapshot(original, originalAvailable);
    }
  });

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
      profileScope: fixtureScope,
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

  it('does not traverse unrelated voice settings while selecting a canonical automatic target', () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(settingsScope, 'sticky');
    let dictationReads = 0;
    const state = {
      profileScope: fixtureScope,
      settingsScope,
      machines: { sticky: machine('sticky', true) },
      settings: {
        voice: {
          executionMachine: { mode: 'auto', machineId: null },
          // Instrument the real settings input: machine selection must be independent
          // of provider/dictation normalization on every machine-activity update.
          get dictation() {
            dictationReads += 1;
            return {};
          },
        },
      },
    };

    expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('sticky');
    expect(dictationReads).toBe(0);
  });

  it('follows a replacement only when the canonical daemon is active', () => {
    const state = {
      profileScope: fixtureScope,
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
      profileScope: fixtureScope,
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
      profileScope: fixtureScope,
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

  it('chooses the same automatic target across inventory order and presence changes', () => {
    const original = getAppliedActiveServerSnapshot();
    const originalAvailable = isAppliedActiveServerRuntimeAvailable();
    const serverId = 'voice-auto-stability';
    const older = machine('older', true, { createdAt: 1, availability: { kind: 'available' }, metadata: { displayName: 'Voice host' } });
    const newer = machine('newer', true, { createdAt: 2, availability: { kind: 'available' }, metadata: { displayName: 'Voice host' } });
    const stateFor = (machines: Record<string, ReturnType<typeof machine>>) => ({
      profileScope: { serverId, accountId: settingsScope.accountId },
      machines,
      machineListByServerId: { [serverId]: Object.values(machines) },
      settings: { voice: { executionMachine: { mode: 'auto', machineId: null } } },
    });
    let settingsWrites = 0;
    let previousSettings = storage.getState().settings;
    const unsubscribe = storage.subscribe(state => {
      if (state.settings !== previousSettings) settingsWrites += 1;
      previousSettings = state.settings;
    });
    try {
      publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://voice-auto-stability.test', generation: 1 });
      const state = stateFor({ older, newer });
      expect(resolveVoiceExecutionMachineSelectionFromState(state)).toEqual({ kind: 'resolved', machineId: 'newer' });
      expect(resolveVoiceExecutionMachineSelectionFromState(stateFor({ newer, older })))
        .toEqual({ kind: 'resolved', machineId: 'newer' });
      expect(resolveVoiceExecutionMachineSelectionFromState(stateFor({ newer: { ...newer, createdAt: older.createdAt }, older })))
        .toEqual({ kind: 'resolved', machineId: 'newer' });
      // Both Machines remain reachable under the canonical presence grace rule.
      expect(resolveVoiceExecutionMachineSelectionFromState(stateFor({ newer: { ...newer, active: false, activeAt: Date.now() - 1_000 }, older })))
        .toEqual({ kind: 'resolved', machineId: 'newer' });
      expect(resolveVoiceExecutionMachineSelectionFromState(stateFor({ newer: { ...newer, replacedByMachineId: 'older' }, older })))
        .toEqual({ kind: 'resolved', machineId: 'older' });
      expect(resolveVoiceExecutionMachineSelectionFromState(state, { machineId: 'older' }))
        .toEqual({ kind: 'resolved', machineId: 'older' });
      const scope = { serverId, accountId: settingsScope.accountId };
      useVoiceTargetStore.getState().rememberAutoTargetMachine(scope, 'newer');
      expect(resolveVoiceExecutionMachineSelectionFromState({ ...stateFor({ newer: { ...newer, active: false }, older }),
        settingsScope: scope,
      })).toEqual({ kind: 'selected_unreachable', machineId: 'newer' });
      expect(settingsWrites).toBe(0);
    } finally {
      unsubscribe();
      publishAppliedActiveServerSnapshot(original, originalAvailable);
    }
  });

  it('uses stable Machine facts only before a sticky auto target exists', () => {
    const original = getAppliedActiveServerSnapshot();
    const originalAvailable = isAppliedActiveServerRuntimeAvailable();
    const serverId = 'voice-auto-recency';
    const machines = {
      older: machine('older', true, { createdAt: 1, availability: { kind: 'available' } }),
      newer: machine('newer', true, { createdAt: 2, availability: { kind: 'available' } }),
    };
    const state = {
      profileScope: { serverId, accountId: settingsScope.accountId },
      machines,
      machineListByServerId: { [serverId]: Object.values(machines) },
      authoringMemory: {
        recentMachinePaths: [{ machineId: 'older', path: '/repo' }],
      },
      settings: {
        voice: {
          executionMachine: { mode: 'auto', machineId: null },
        },
      },
    };

    try {
      publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://voice-auto-recency.test', generation: 1 });
      // VOICE-LOGIC-1106: recent authoring activity must not move Automatic Voice.
      expect(resolveVoiceExecutionMachineIdFromState(state)).toBe('newer');
    } finally {
      publishAppliedActiveServerSnapshot(original, originalAvailable);
    }
  });

  it('honors a scoped override without rewriting the persisted default', () => {
    const state = {
      profileScope: fixtureScope,
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
      profileScope: fixtureScope,
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
      profileScope: fixtureScope,
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
