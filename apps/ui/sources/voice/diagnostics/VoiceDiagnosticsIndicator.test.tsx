import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

vi.mock('@/sync/store/hooks', () => ({
  useActiveServerAccountScope: () => null,
  useMachineCliDetectionTarget: () => ({ daemonStateVersion: 1, isOnline: true }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diagnostics = vi.hoisted(() => ({ enabled: true, consentVersion: 1 as 1 | null }));
const machineState = vi.hoisted(() => ({ machineId: 'm1' as string | null }));
const modalState = vi.hoisted(() => ({ confirmed: true }));
const modalAlert = vi.hoisted(() => vi.fn(async () => {}));
const revokeState = vi.hoisted(() => ({ error: null as Error | null, pending: null as Promise<void> | null }));
const configureState = vi.hoisted(() => ({ failedCalls: new Set<string>() }));
const platformState = vi.hoisted(() => ({ OS: 'web' }));
const announceForAccessibility = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility },
  Platform: platformState,
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { status: { error: '#f00' }, text: { secondary: '#777' } } } }),
}));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/sync/domains/state/storage', () => ({ useSetting: () => ({ diagnostics }) }));
vi.mock('@/sync/domains/settings/voiceSettings', () => ({
  voiceSettingsParse: (voice: any) => ({
    diagnostics: { ...diagnostics },
    executionMachine: voice?.executionMachine,
  }),
}));
vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({ machineId: machineState.machineId, machineLabel: machineState.machineId }),
}));
vi.mock('@/text', () => ({
  tLoose: (key: string) => key === 'settingsVoice.diagnostics.shutdownFailedIndicator'
    ? 'Speech diagnostics could not be confirmed off'
    : 'Speech diagnostics on',
}));
const modalConfirm = vi.hoisted(() => vi.fn(async () => modalState.confirmed));
vi.mock('@/modal', () => ({ Modal: { confirm: modalConfirm, alert: modalAlert } }));
const revokeCaptureAuthorization = vi.hoisted(() => vi.fn(async () => {
  if (revokeState.pending) await revokeState.pending;
  if (revokeState.error) throw revokeState.error;
}));
const configure = vi.hoisted(() => vi.fn(async (machineId: string, settings: any) => {
  const key = `${machineId}:${settings.enabled ? 'enabled' : 'disabled'}`;
  if (configureState.failedCalls.has(key)) throw new Error(`configure_failed:${key}`);
  return { ok: true, settings };
}));
const createVoiceDiagnosticsClientForMachine = vi.hoisted(() => vi.fn((machineId: string) => ({
  configure: (settings: any) => configure(machineId, settings),
  revokeCaptureAuthorization,
})));
vi.mock('./client', () => ({ createVoiceDiagnosticsClientForMachine }));

import {
  beginVoiceDiagnosticsRevocationObligation,
  clearVoiceDiagnosticsRevocationObligation,
  publishVoiceDiagnosticsRuntimeStatus,
  readVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
  updateVoiceDiagnosticsRevocationObligation,
} from './runtimeStatus';
import { useVoiceDiagnosticsRuntimeSync } from './useVoiceDiagnosticsRuntimeSync';
import { VoiceDiagnosticsIndicator } from './VoiceDiagnosticsIndicator';
import { resetVoiceDiagnosticsRevocationForTests } from './runtimeRevocation';

function RuntimeSyncIndicatorHarness(props: Readonly<{
  voice: unknown;
  sessionId: string;
  includeSecondSurface?: boolean;
}>) {
  useVoiceDiagnosticsRuntimeSync(props.voice);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(VoiceDiagnosticsIndicator, { key: 'primary', sessionId: props.sessionId }),
    props.includeSecondSurface
      ? React.createElement(VoiceDiagnosticsIndicator, { key: 'secondary', sessionId: props.sessionId })
      : null,
  );
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('VoiceDiagnosticsIndicator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    diagnostics.enabled = true;
    diagnostics.consentVersion = 1;
    machineState.machineId = 'm1';
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
    publishVoiceDiagnosticsRuntimeStatus({ phase: 'active', machineId: 'm1' });
    revokeCaptureAuthorization.mockClear();
    configure.mockClear();
    configureState.failedCalls.clear();
    createVoiceDiagnosticsClientForMachine.mockClear();
    modalConfirm.mockClear();
    modalAlert.mockClear();
    announceForAccessibility.mockClear();
    platformState.OS = 'web';
    modalState.confirmed = true;
    revokeState.error = null;
    revokeState.pending = null;
    const { resetVoiceDiagnosticsSessionPolicyForTests } = await import('./capturePolicy');
    resetVoiceDiagnosticsSessionPolicyForTests();
  });

  it('uses persistent text plus color and is removed for a session opt-out', async () => {
    const { VoiceDiagnosticsIndicator } = await import('./VoiceDiagnosticsIndicator');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
    });
    expect(tree.root.findByProps({ accessibilityLabel: 'Speech diagnostics on' })).toBeTruthy();
    expect(JSON.stringify(tree.toJSON())).toContain('Speech diagnostics on');

    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
    });
    expect(tree.toJSON()).toBeNull();
    expect(createVoiceDiagnosticsClientForMachine).toHaveBeenCalledWith('m1');
    expect(revokeCaptureAuthorization).toHaveBeenCalledWith(expect.any(String));
  });

  it('uses the canonical minimum interactive target on web', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
    });

    const action = tree.root.findByType('Pressable' as any);
    const style = typeof action.props.style === 'function'
      ? action.props.style({ pressed: false })
      : action.props.style;
    const frame = flattenStyle(style);
    const expectedMinimum = resolveMinimumInteractiveTargetSize('web');
    expect(frame.minWidth).toBe(expectedMinimum);
    expect(frame.minHeight).toBe(expectedMinimum);
  });

  it('moves web focus to the stable status owner after an acknowledged session opt-out removes the focused action', async () => {
    const actionTarget = { focus: vi.fn(), isConnected: true };
    const statusOwner = { focus: vi.fn(), isConnected: true };
    const focusFallbackRef = { current: statusOwner };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        React.createElement(VoiceDiagnosticsIndicator, {
          sessionId: 'session-1',
          focusFallbackRef,
        }),
        {
          createNodeMock: (element) => element.type === 'Pressable' ? actionTarget : {},
        },
      );
    });
    vi.stubGlobal('document', { activeElement: actionTarget });

    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tree.toJSON()).toBeNull();
    expect(statusOwner.focus).toHaveBeenCalledOnce();
    expect(actionTarget.focus).not.toHaveBeenCalled();
  });

  it('moves web focus to the stable status owner after an acknowledged retry removes the focused action', async () => {
    beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'm-retry-focus' },
      'failed',
    );
    const actionTarget = { focus: vi.fn(), isConnected: true };
    const bodyTarget = { focus: vi.fn(), isConnected: true };
    const statusOwner = { focus: vi.fn(), isConnected: true };
    const focusFallbackRef = { current: statusOwner };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        React.createElement(VoiceDiagnosticsIndicator, { focusFallbackRef }),
        {
          createNodeMock: (element) => element.type === 'Pressable' ? actionTarget : {},
        },
      );
    });
    vi.stubGlobal('document', {
      body: bodyTarget,
      get activeElement() {
        return tree.root.findAllByType('Pressable' as any).length > 0
          ? actionTarget
          : bodyTarget;
      },
    });

    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tree.root.findAllByType('Pressable' as any)).toHaveLength(0);
    expect(statusOwner.focus).toHaveBeenCalledOnce();
    expect(actionTarget.focus).not.toHaveBeenCalled();
    expect(bodyTarget.focus).not.toHaveBeenCalled();
  });

  it('does not steal focus when the user moves elsewhere while session opt-out is pending', async () => {
    const actionTarget = { focus: vi.fn(), isConnected: true };
    const elsewhereTarget = { focus: vi.fn(), isConnected: true };
    const statusOwner = { focus: vi.fn(), isConnected: true };
    const focusFallbackRef = { current: statusOwner };
    let release!: () => void;
    revokeState.pending = new Promise<void>((resolve) => { release = resolve; });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        React.createElement(VoiceDiagnosticsIndicator, {
          sessionId: 'session-1',
          focusFallbackRef,
        }),
        {
          createNodeMock: (element) => element.type === 'Pressable' ? actionTarget : {},
        },
      );
    });
    const documentState = { activeElement: actionTarget as typeof actionTarget | typeof elsewhereTarget };
    vi.stubGlobal('document', documentState);

    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
    });
    documentState.activeElement = elsewhereTarget;
    await act(async () => {
      release();
      await revokeState.pending;
      await Promise.resolve();
    });

    expect(tree.toJSON()).toBeNull();
    expect(statusOwner.focus).not.toHaveBeenCalled();
    expect(elsewhereTarget.focus).not.toHaveBeenCalled();
  });

  it('is absent unless current explicit consent is active', async () => {
    diagnostics.consentVersion = null;
    const { VoiceDiagnosticsIndicator } = await import('./VoiceDiagnosticsIndicator');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('does not claim capture is active until the selected daemon accepted the policy', async () => {
    publishVoiceDiagnosticsRuntimeStatus({ phase: 'inactive_confirmed', machineId: 'm1' });
    const { VoiceDiagnosticsIndicator } = await import('./VoiceDiagnosticsIndicator');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('keeps capture visibly active and offers retry when exact-machine revocation fails', async () => {
    revokeState.error = new Error('daemon disconnected');
    const { VoiceDiagnosticsIndicator } = await import('./VoiceDiagnosticsIndicator');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
    });
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tree.toJSON()).not.toBeNull();
    expect(modalAlert).toHaveBeenCalledWith('Speech diagnostics on', 'Speech diagnostics on');
    expect(JSON.stringify(tree.toJSON())).toContain('Speech diagnostics on');

    revokeState.error = null;
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(revokeCaptureAuthorization).toHaveBeenCalledTimes(2);
    expect(tree.toJSON()).toBeNull();
  });

  it('does not revoke on cancel and suppresses duplicate actions while a revoke is pending', async () => {
    const { VoiceDiagnosticsIndicator } = await import('./VoiceDiagnosticsIndicator');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
    });
    modalState.confirmed = false;
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
    });
    expect(revokeCaptureAuthorization).not.toHaveBeenCalled();

    modalState.confirmed = true;
    let release!: () => void;
    revokeState.pending = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      const press = tree.root.findByType('Pressable' as any).props.onPress;
      press();
      press();
      await Promise.resolve();
    });
    expect(revokeCaptureAuthorization).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await revokeState.pending;
      await Promise.resolve();
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('completes an exact-machine opt-out without disabling a newly selected daemon', async () => {
    const { VoiceDiagnosticsIndicator } = await import('./VoiceDiagnosticsIndicator');
    let tree!: renderer.ReactTestRenderer;
    let release!: () => void;
    revokeState.pending = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
    });
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      publishVoiceDiagnosticsRuntimeStatus({ phase: 'status_unknown', machineId: 'm2' });
      tree.update(React.createElement(VoiceDiagnosticsIndicator, { sessionId: 'session-1' }));
      await Promise.resolve();
    });
    await act(async () => {
      release();
      await revokeState.pending;
      await Promise.resolve();
    });

    expect(tree.toJSON()).toBeNull();
    expect(modalAlert).not.toHaveBeenCalled();
    expect(createVoiceDiagnosticsClientForMachine).toHaveBeenCalledWith('m1');
  });

  it('keeps a failed exact-old-machine shutdown visible and retryable through the real runtime sync path', async () => {
    platformState.OS = 'ios';
    const voiceFor = (machineId: string) => ({
      diagnostics: { ...diagnostics },
      executionMachine: { mode: 'fixed', machineId, autoMachineId: null },
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: voiceFor('m1'),
        sessionId: 'session-1',
      }));
    });
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith('m1', expect.objectContaining({ enabled: true })));

    configureState.failedCalls.add('m1:disabled');
    configureState.failedCalls.add('m2:enabled');
    machineState.machineId = 'm2';
    const m2Voice = voiceFor('m2');
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: m2Voice,
        sessionId: 'session-1',
      }));
    });
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith('m2', expect.objectContaining({ enabled: true })));

    expect(tree.toJSON()).not.toBeNull();
    const renderedFailureLabels = tree.root.findAllByType('Text' as any).filter(
      (node) => node.children.join('') === 'Speech diagnostics could not be confirmed off',
    );
    expect(renderedFailureLabels).toHaveLength(1);
    const accessibleFailureLabels = tree.root.findAll((node) => (
      node.props.accessibilityLabel === 'Speech diagnostics could not be confirmed off'
      || (
        node.props.accessibilityRole === 'alert'
        && node.children.join('') === 'Speech diagnostics could not be confirmed off'
      )
    ));
    expect(accessibleFailureLabels).toHaveLength(1);
    expect(accessibleFailureLabels[0]?.props.accessibilityRole).toBe('alert');
    expect(accessibleFailureLabels[0]?.props.accessibilityLiveRegion).toBe('assertive');
    expect(announceForAccessibility).toHaveBeenCalledOnce();
    expect(announceForAccessibility).toHaveBeenCalledWith('Speech diagnostics could not be confirmed off');
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: m2Voice,
        sessionId: 'session-1',
        includeSecondSurface: true,
      }));
    });
    expect(announceForAccessibility).toHaveBeenCalledOnce();
    await act(async () => {
      tree.update(React.createElement(RuntimeSyncIndicatorHarness, {
        voice: m2Voice,
        sessionId: 'session-1',
      }));
    });
    const failedObligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations.find(
      (candidate) => candidate.status === 'failed',
    )!;
    await act(async () => {
      updateVoiceDiagnosticsRevocationObligation(failedObligation, 'pending');
    });
    await act(async () => {
      updateVoiceDiagnosticsRevocationObligation(failedObligation, 'failed');
    });
    expect(announceForAccessibility).toHaveBeenCalledTimes(2);
    const retryActionStyle = tree.root.findByType('Pressable' as any).props.style;
    expect(retryActionStyle.minWidth).toBeGreaterThanOrEqual(44);
    expect(retryActionStyle.minHeight).toBeGreaterThanOrEqual(44);

    configureState.failedCalls.delete('m1:disabled');
    const oldMachineDisableCallsBeforeRetry = configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm1' && settings.enabled === false,
    ).length;
    await act(async () => {
      tree.root.findByType('Pressable' as any).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm1' && settings.enabled === false,
    )).toHaveLength(oldMachineDisableCallsBeforeRetry + 1);
    expect(configure.mock.calls.filter(
      ([machineId, settings]) => machineId === 'm2' && settings.enabled === false,
    )).toHaveLength(0);
  });

  it('re-arms an iOS failure that transitions through pending while every surface is unmounted', async () => {
    platformState.OS = 'ios';
    const obligation = beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'm-unmounted-transition' },
      'failed',
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(announceForAccessibility).toHaveBeenCalledOnce();

    await act(async () => {
      tree.update(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(announceForAccessibility).toHaveBeenCalledOnce();

    await act(async () => {
      tree.unmount();
    });
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(announceForAccessibility).toHaveBeenCalledOnce();

    await act(async () => {
      tree.unmount();
    });
    updateVoiceDiagnosticsRevocationObligation(obligation, 'pending');
    updateVoiceDiagnosticsRevocationObligation(obligation, 'failed');

    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(announceForAccessibility).toHaveBeenCalledTimes(2);

    await act(async () => {
      updateVoiceDiagnosticsRevocationObligation(obligation, 'failed');
      tree.update(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(announceForAccessibility).toHaveBeenCalledTimes(2);

    await act(async () => {
      clearVoiceDiagnosticsRevocationObligation(obligation);
      beginVoiceDiagnosticsRevocationObligation(
        { kind: 'machine_policy', machineId: 'm-unmounted-transition' },
        'failed',
      );
      tree.update(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(announceForAccessibility).toHaveBeenCalledTimes(3);
  });

  it('announces each concurrent distinct iOS failure occurrence exactly once', async () => {
    platformState.OS = 'ios';
    const first = beginVoiceDiagnosticsRevocationObligation(
      { kind: 'machine_policy', machineId: 'm-concurrent-first' },
      'failed',
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(announceForAccessibility).toHaveBeenCalledOnce();

    let second!: ReturnType<typeof beginVoiceDiagnosticsRevocationObligation>;
    await act(async () => {
      second = beginVoiceDiagnosticsRevocationObligation(
        { kind: 'machine_policy', machineId: 'm-concurrent-second' },
        'failed',
      );
    });
    expect(announceForAccessibility).toHaveBeenCalledTimes(2);

    const snapshotBeforeDuplicateWrites = readVoiceDiagnosticsRuntimeStatus();
    await act(async () => {
      updateVoiceDiagnosticsRevocationObligation(first, 'failed');
      updateVoiceDiagnosticsRevocationObligation(second, 'failed');
      tree.update(React.createElement(VoiceDiagnosticsIndicator));
    });
    expect(readVoiceDiagnosticsRuntimeStatus()).toBe(snapshotBeforeDuplicateWrites);
    expect(announceForAccessibility).toHaveBeenCalledTimes(2);

    let replacement!: ReturnType<typeof beginVoiceDiagnosticsRevocationObligation>;
    await act(async () => {
      replacement = beginVoiceDiagnosticsRevocationObligation(
        { kind: 'machine_policy', machineId: 'm-concurrent-second' },
        'failed',
      );
    });
    expect(updateVoiceDiagnosticsRevocationObligation(second, 'pending')).toBe(false);
    expect(replacement.revision).not.toBe(second.revision);
    expect(announceForAccessibility).toHaveBeenCalledTimes(3);
  });

  it('uses the canonical 48dp Android minimum in an isolated platform module', async () => {
    platformState.OS = 'android';
    vi.resetModules();
    const freshRuntimeStatus = await import('./runtimeStatus');
    freshRuntimeStatus.publishVoiceDiagnosticsRuntimeStatus({ phase: 'active', machineId: 'm1' });
    const { VoiceDiagnosticsIndicator: AndroidVoiceDiagnosticsIndicator } = await import(
      './VoiceDiagnosticsIndicator'
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(AndroidVoiceDiagnosticsIndicator, {
        sessionId: 'session-android',
      }));
    });

    const action = tree.root.findByType('Pressable' as any);
    const style = typeof action.props.style === 'function'
      ? action.props.style({ pressed: false })
      : action.props.style;
    const frame = flattenStyle(style);
    const expectedMinimum = resolveMinimumInteractiveTargetSize('android');
    expect(frame.minWidth).toBe(expectedMinimum);
    expect(frame.minHeight).toBe(expectedMinimum);
  });
});
