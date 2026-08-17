import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineState = vi.hoisted(() => ({
  machineId: 'm1',
  daemonStateVersion: 1,
  isOnline: true,
}));
const activeVoiceAttempt = vi.hoisted(() => ({ sessionId: null as string | null }));
const testState = vi.hoisted(() => ({
  artifacts: [] as any[],
  deleteError: null as Error | null,
  configureError: null as Error | null,
  statusError: null as Error | null,
  blockedEnabledMachineId: null as string | null,
  configureBarrier: null as Promise<void> | null,
  policyByMachine: new Map<string, boolean>(),
  configureCompletions: [] as Array<readonly [machineId: string, enabled: boolean]>,
  health: {
    captureFailure: false,
    cleanup: { status: 'healthy' as const, code: null, ownedEntryCount: 0 as number | null },
  } as any,
}));
const modalAlert = vi.hoisted(() => vi.fn(async () => {}));
const fireAndForgetError = vi.hoisted(() => vi.fn());
const configure = vi.hoisted(() => vi.fn(async (machineId: string, settings: any) => {
  if (testState.blockedEnabledMachineId === machineId && settings.enabled && testState.configureBarrier) {
    await testState.configureBarrier;
  }
  const enabled = settings.enabled === true;
  testState.policyByMachine.set(machineId, enabled);
  testState.configureCompletions.push([machineId, enabled]);
  return {
    ok: true as const,
    root: `/private/${machineId}`,
    settings,
    artifacts: testState.artifacts,
    health: testState.health,
    backupPolicy: { status: 'best_effort' as const, storage: 'private_cache' as const, mechanism: 'cachedir_tag' as const, automaticSync: 'not_implemented' as const },
  };
}));
const status = vi.hoisted(() => vi.fn(async (machineId: string) => ({
  ok: true as const,
  root: `/private/${machineId}`,
  settings: {},
  artifacts: testState.artifacts,
  health: testState.health,
  backupPolicy: { status: 'best_effort' as const, storage: 'private_cache' as const, mechanism: 'cachedir_tag' as const, automaticSync: 'not_implemented' as const },
})));

vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: (props: any) => React.createElement('Switch', props) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { status: { error: '#f00' }, text: { secondary: '#777' } } } }),
}));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(async () => true), alert: modalAlert } }));
vi.mock('@/text', () => ({ t: (key: string) => key, tLoose: (key: string) => key }));
vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>) => void promise.catch(fireAndForgetError),
}));
vi.mock('@/sync/domains/settings/voiceSettings', () => ({
  readVoiceDiagnosticsSettings: (voice: any) => voice.diagnostics,
  writeVoiceDiagnosticsSettings: (voice: any, diagnostics: any) => ({ ...voice, diagnostics }),
  voiceSettingsDefaults: { credentialBindings: [] },
  voiceSettingsParse: (voice: any) => ({ credentialBindings: [], ...(voice ?? {}) }),
}));
vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: () => ({ diagnostics }),
}));
vi.mock('@/sync/store/hooks', () => ({
  useActiveServerAccountScope: () => null,
  useMachineCliDetectionTarget: () => ({
    daemonStateVersion: machineState.daemonStateVersion,
    isOnline: machineState.isOnline,
  }),
  useMachineCliDetectionTargets: (machineIds: readonly string[]) => Object.fromEntries(machineIds.map((machineId) => [
    machineId,
    {
      daemonStateVersion: machineState.daemonStateVersion,
      isOnline: machineState.isOnline,
    },
  ])),
}));
vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({ machineId: machineState.machineId, machineLabel: machineState.machineId }),
}));
vi.mock('@/components/voice/attempt/useVoiceAttemptControl', () => ({
  useVoiceAttemptControl: () => ({ sessionId: activeVoiceAttempt.sessionId }),
  VOICE_ATTEMPT_IDLE_TARGET_GLOBAL: { kind: 'global' },
}));
vi.mock('./artifactExportTarget', () => ({ createVoiceDiagnosticArtifactExportTarget: vi.fn() }));
vi.mock('./client', () => ({
  createVoiceDiagnosticsClient: () => ({
    configure: (settings: any) => configure(machineState.machineId, settings),
  }),
  createVoiceDiagnosticsClientForMachine: (machineId: string) => ({
    configure: async (settings: any) => {
      if (testState.configureError) throw testState.configureError;
      return await configure(machineId, settings);
    },
    deleteAll: async () => {
      if (testState.deleteError) throw testState.deleteError;
    },
    status: async () => {
      if (testState.statusError) throw testState.statusError;
      return await status(machineId);
    },
  }),
}));

import { VoiceDiagnosticsSettingsSection } from './VoiceDiagnosticsSettingsSection';
import { useVoiceDiagnosticsRuntimeSync } from './useVoiceDiagnosticsRuntimeSync';
import {
  beginVoiceDiagnosticsRevocationObligation,
  publishVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
} from './runtimeStatus';
import { resetVoiceDiagnosticsRevocationForTests } from './runtimeRevocation';
import { resetVoiceDiagnosticsSessionPolicyForTests } from './capturePolicy';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

function RuntimeSyncSettingsHarness(props: Readonly<{ voice: any }>) {
  useVoiceDiagnosticsRuntimeSync(props.voice);
  return React.createElement(VoiceDiagnosticsSettingsSection, {
    voice: props.voice,
    setVoice: vi.fn(),
  });
}

const diagnostics = Object.freeze({
  v: 1 as const,
  enabled: true,
  consentVersion: 1 as const,
  captureSttInput: true,
  captureTtsOutput: false,
  maxAgeMs: 86_400_000,
  maxFiles: 20,
  maxBytes: 104_857_600,
  maxDurationMs: 300_000,
});

describe('VoiceDiagnosticsSettingsSection selected-machine status', () => {
  beforeEach(() => {
    machineState.machineId = 'm1';
    machineState.daemonStateVersion = 1;
    machineState.isOnline = true;
    activeVoiceAttempt.sessionId = null;
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsSessionPolicyForTests();
    configure.mockClear();
    status.mockClear();
    modalAlert.mockClear();
    testState.artifacts = [];
    testState.deleteError = null;
    testState.configureError = null;
    testState.statusError = null;
    testState.blockedEnabledMachineId = null;
    testState.configureBarrier = null;
    testState.policyByMachine.clear();
    testState.configureCompletions = [];
    testState.health = {
      captureFailure: false,
      cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 },
    };
    fireAndForgetError.mockClear();
  });

  it('gives every diagnostics switch a programmatic accessible name', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: voiceSettingsParse({ diagnostics }),
        setVoice: vi.fn(),
      }));
    });

    const switchLabels = tree.root.findAllByType('Item' as any)
      .map((item) => item.props.rightElement?.props?.accessibilityLabel)
      .filter((label): label is string => typeof label === 'string');
    expect(switchLabels).toEqual([
      'settingsVoice.diagnostics.enabled',
      'settingsVoice.diagnostics.sttInput',
      'settingsVoice.diagnostics.ttsOutput',
    ]);
  });

  it('keeps a failed persisted shutdown visible and retryable in Voice Settings', async () => {
    beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'former-machine' },
      'failed',
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics } as any,
        setVoice: vi.fn(),
      }));
    });

    expect(tree.root.findAllByType('Text' as any).some(
      (node) => node.children.join('') === 'settingsVoice.diagnostics.shutdownFailedIndicator',
    )).toBe(true);
    const retry = tree.root.findByProps({
      accessibilityLabel: 'settingsVoice.diagnostics.retryShutdown',
    });
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.disabled).toBe(false);
  });

  it('offers session opt-out in Voice Settings for the canonical active Voice attempt', async () => {
    activeVoiceAttempt.sessionId = 'active-diagnostics-session';
    publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'active' });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics } as any,
        setVoice: vi.fn(),
      }));
    });

    const optOut = tree.root.findByProps({
      accessibilityLabel: 'settingsVoice.diagnostics.sessionOptOut',
    });
    expect(optOut.props.accessibilityRole).toBe('button');
    expect(optOut.props.disabled).toBe(false);
  });

  it('invalidates retained artifacts and reloads status from the newly selected machine', async () => {
    let tree!: renderer.ReactTestRenderer;
    const first = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } } as any;
    const second = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm2' } } as any;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, { voice: first, setVoice: vi.fn() }));
    });
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.location' }).props.subtitle).toBe('/private/m1');

    machineState.machineId = 'm2';
    await act(async () => {
      tree.update(React.createElement(VoiceDiagnosticsSettingsSection, { voice: second, setVoice: vi.fn() }));
    });

    expect(status.mock.calls.map(([machineId]) => machineId)).toEqual(['m1', 'm2']);
    expect(configure).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.location' }).props.subtitle).toBe('/private/m2');
  });

  it('invalidates stale daemon status during restart reconciliation and reloads it after acknowledgement', async () => {
    let tree!: renderer.ReactTestRenderer;
    const voice = { diagnostics, executionMachine: { mode: 'fixed', machineId: 'm1' } } as any;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, { voice, setVoice: vi.fn() }));
    });
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'transitioning' });
    });
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.location' }).props.subtitle)
      .toBe('settingsVoice.diagnostics.unavailable');

    await act(async () => {
      publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'active' });
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.location' }).props.subtitle).toBe('/private/m1');
  });

  it('does not let an older cleanup retry re-enable or republish a revoked former machine', async () => {
    testState.health = {
      captureFailure: false,
      cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 },
    };
    const voiceFor = (machineId: string) => ({
      diagnostics,
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let releaseCleanup!: () => void;
    const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(RuntimeSyncSettingsHarness, { voice: voiceFor('m1') }));
    });
    expect(testState.policyByMachine.get('m1')).toBe(true);

    testState.blockedEnabledMachineId = 'm1';
    testState.configureBarrier = cleanupBarrier;
    await act(async () => {
      tree.root.findByProps({ title: 'settingsVoice.diagnostics.retryCleanup' }).props.onPress();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm1' && settings.enabled === true,
    )).toHaveLength(2));

    machineState.machineId = 'm2';
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncSettingsHarness, { voice: voiceFor('m2') }));
    });

    await act(async () => {
      releaseCleanup();
      await vi.waitFor(() => expect(testState.configureCompletions).toHaveLength(4));
    });
    expect(testState.configureCompletions.filter(([machineId]) => machineId === 'm1').at(-1))
      .toEqual(['m1', false]);
    expect(testState.policyByMachine.get('m1')).toBe(false);
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.location' }).props.subtitle)
      .not.toBe('/private/m1');
    await act(async () => { tree.unmount(); });
  });

  it('discloses best-effort cache protection instead of claiming OS-enforced backup exclusion', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics } as any,
        setVoice: vi.fn(),
      }));
    });

    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.backupPolicy' }).props.subtitle)
      .toBe('settingsVoice.diagnostics.backupPolicyBestEffort');
  });

  it('reports a failed delete-all privacy action instead of failing silently', async () => {
    testState.artifacts = [{
      id: 'abcdef12-dead-beef',
      createdAtMs: 1,
      direction: 'stt_input',
      format: 'webm',
      durationMs: null,
      byteLength: 42,
    }];
    testState.deleteError = new Error('daemon unavailable');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics } as any,
        setVoice: vi.fn(),
      }));
    });

    await act(async () => {
      tree.root.findByProps({ title: 'settingsVoice.diagnostics.deleteAll' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(modalAlert).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.diagnostics.deleteFailed',
    );
  });

  it('keeps an offline enable intent without leaking the expected machine failure to fire-and-forget', async () => {
    testState.configureError = new Error('machine unavailable');
    testState.statusError = new Error('machine unavailable');
    const disabledDiagnostics = { ...diagnostics, enabled: false, consentVersion: null } as any;
    const setVoice = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics: disabledDiagnostics } as any,
        setVoice,
      }));
    });

    await act(async () => {
      tree.root.findByProps({ title: 'settingsVoice.diagnostics.enabled' })
        .props.rightElement.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fireAndForgetError).not.toHaveBeenCalled();
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      diagnostics: expect.objectContaining({ enabled: true, consentVersion: 1 }),
    }));
    expect(configure).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.location' }).props.subtitle)
      .toBe('settingsVoice.diagnostics.unavailable');
  });

  it('commits desired diagnostics settings without writing current-machine policy from the settings surface', async () => {
    const disabledDiagnostics = { ...diagnostics, enabled: false, consentVersion: null } as any;
    const setVoice = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics: disabledDiagnostics } as any,
        setVoice,
      }));
    });

    await act(async () => {
      tree.root.findByProps({ title: 'settingsVoice.diagnostics.enabled' })
        .props.rightElement.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      diagnostics: expect.objectContaining({ enabled: true, consentVersion: 1 }),
    }));
    expect(configure).not.toHaveBeenCalled();
  });

  it('keeps degraded cleanup visible and retryable when no committed artifacts can be listed', async () => {
    testState.health = {
      captureFailure: false,
      cleanup: { status: 'required', code: 'catalog_unreadable', ownedEntryCount: null },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics } as any,
        setVoice: vi.fn(),
      }));
    });

    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.cleanupRequired' })).toBeTruthy();
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.deleteAll' }).props.disabled).toBe(false);
    expect(tree.root.findAllByProps({ subtitle: 'settingsVoice.diagnostics.noArtifacts' })).toHaveLength(0);
    const beforeRetry = configure.mock.calls.length;
    await act(async () => {
      tree.root.findByProps({ title: 'settingsVoice.diagnostics.retryCleanup' }).props.onPress();
      await Promise.resolve();
    });
    expect(configure.mock.calls.length).toBeGreaterThan(beforeRetry);
  });

  it('does not mislabel a non-retaining capture failure as leftover private data', async () => {
    testState.health = {
      captureFailure: true,
      cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics } as any,
        setVoice: vi.fn(),
      }));
    });

    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.captureFailed' })).toBeTruthy();
    expect(tree.root.findAllByProps({ title: 'settingsVoice.diagnostics.cleanupRequired' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ title: 'settingsVoice.diagnostics.retryCapture' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ title: 'settingsVoice.diagnostics.retryCleanup' })).toHaveLength(0);
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.deleteAll' }).props.disabled).toBe(true);
  });

  it('shows independent capture and cleanup obligations with only truthful actions', async () => {
    testState.health = {
      captureFailure: true,
      cleanup: {
        status: 'required',
        code: 'cleanup_failed',
        ownedEntryCount: 1,
      },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsSettingsSection, {
        voice: { diagnostics } as any,
        setVoice: vi.fn(),
      }));
    });

    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.captureFailed' })).toBeTruthy();
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.cleanupRequired' })).toBeTruthy();
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.retryCleanup' })).toBeTruthy();
    expect(tree.root.findByProps({ title: 'settingsVoice.diagnostics.deleteAll' }).props.disabled).toBe(false);
    expect(tree.root.findAllByProps({ title: 'settingsVoice.diagnostics.retryCapture' })).toHaveLength(0);
  });
});
