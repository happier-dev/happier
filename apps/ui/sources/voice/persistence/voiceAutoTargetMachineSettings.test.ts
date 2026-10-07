import { beforeEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { persistVoiceAutoTargetMachineId, readVoiceAutoTargetMachineId } from './voiceAutoTargetMachineSettings';

const scope = { serverId: 'voice-home', accountId: 'voice-account' };

describe('voiceAutoTargetMachineSettings', () => {
  beforeEach(async () => {
    await storage.getState().activateSettingsScope(scope);
    storage.getState().applySettings(settingsDefaults, 1);
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
  });

  it('ignores the never-shipped Account target and reads only scoped local memory', () => {
    const state = {
      settingsScope: scope,
      settings: { voice: { executionMachine: { mode: 'auto', machineId: null, autoMachineId: 'stray-machine' } } },
    };
    expect(readVoiceAutoTargetMachineId(state)).toBeNull();
    useVoiceTargetStore.getState().rememberAutoTargetMachine(scope, 'local-machine');
    expect(readVoiceAutoTargetMachineId(state)).toBe('local-machine');
    expect(readVoiceAutoTargetMachineId({ settings: state.settings })).toBeNull();
  });

  it('does not use remembered automatic targets when the canonical preference is malformed', () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(scope, 'local-machine');
    expect(readVoiceAutoTargetMachineId({
      settingsScope: scope,
      settings: { voice: { executionMachine: { mode: 'fixed', machineId: 42 } } },
    })).toBeNull();
  });

  it('clears local target memory on recovery without changing an explicit fixed preference', () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(scope, 'local-machine');
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBe('local-machine');
    const settings = storage.getState().settings;
    persistVoiceAutoTargetMachineId(null, scope);
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBeNull();
    expect(storage.getState().settings).toBe(settings);
    storage.setState((state) => ({ settings: { ...state.settings, voice: voiceSettingsParse({
      ...settingsDefaults.voice,
      executionMachine: { mode: 'fixed', machineId: 'explicit-machine' },
    }) } }));
    const fixed = storage.getState().settings;
    const memory = useVoiceTargetStore.getState();
    persistVoiceAutoTargetMachineId('automatic-machine', scope);
    expect(storage.getState().settings).toBe(fixed);
    expect(useVoiceTargetStore.getState()).toBe(memory);
  });

  it('remembers the auto target locally without an Account mutation and skips the same value', () => {
    const settings = storage.getState().settings;
    persistVoiceAutoTargetMachineId('  machine-2  ', scope);
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBe('machine-2');
    expect(storage.getState().settings).toBe(settings);
    const memory = useVoiceTargetStore.getState();
    persistVoiceAutoTargetMachineId('machine-2', scope);
    expect(useVoiceTargetStore.getState()).toBe(memory);
  });

  it('keeps captured-scope memory isolated when the Account changes during selection', async () => {
    const otherScope = { ...scope, accountId: 'voice-other-account' };
    await storage.getState().activateSettingsScope(otherScope);
    const settings = storage.getState().settings;
    persistVoiceAutoTargetMachineId('machine-captured', scope);
    expect(storage.getState().settings).toBe(settings);
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBeNull();
    await storage.getState().activateSettingsScope(scope);
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBe('machine-captured');
  });
});
