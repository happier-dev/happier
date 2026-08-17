/**
 * @vitest-environment jsdom
 *
 * This exercises the real Settings consumer, the diagnostics action, and the
 * real react-native-web Switch. The daemon/status transport is the only
 * boundary replaced: focus must return to a control that still exists after a
 * successful per-session opt-out removes the action that had focus.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boundary = vi.hoisted(() => ({
  voice: null as VoiceSettings | null,
  sessionId: 'focused-diagnostics-session' as string | null,
  revokeCaptureAuthorization: vi.fn(async () => {}),
}));

vi.mock('react-native', async () => {
  const actual: Record<string, unknown> = await vi.importActual('react-native-web');
  return {
    ...actual,
    Platform: {
      ...(actual.Platform as object ?? {}),
      OS: 'web',
      select: (values: Record<string, unknown>) =>
        values?.web ?? values?.default ?? values?.native ?? values?.ios ?? values?.android,
    },
  };
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Icon: () => null,
}));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({ SafeIonicons: () => null }));

vi.mock('@/modal', () => ({
  Modal: {
    confirm: vi.fn(async () => true),
    alert: vi.fn(async () => {}),
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: (key: string) => key === 'voice' ? boundary.voice : undefined,
  useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : undefined,
  storage: {
    getState: () => ({ settings: { voice: boundary.voice } }),
  },
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
  getStorage: () => ({
    getState: () => ({ localSettings: { uiContentWidthMode: undefined } }),
  }),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useActiveServerAccountScope: () => null,
  useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : undefined,
}));

vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({ machineId: 'm1', machineLabel: 'm1' }),
}));

vi.mock('@/components/voice/attempt/useVoiceAttemptControl', () => ({
  useVoiceAttemptControl: () => ({ sessionId: boundary.sessionId }),
  VOICE_ATTEMPT_IDLE_TARGET_GLOBAL: { kind: 'global' },
}));

vi.mock('./artifactExportTarget', () => ({
  createVoiceDiagnosticArtifactExportTarget: vi.fn(),
}));

vi.mock('./client', () => ({
  createVoiceDiagnosticsClientForMachine: () => ({
    status: async () => ({
      ok: true as const,
      root: '/private/m1',
      settings: boundary.voice!.diagnostics,
      artifacts: [],
      health: {
        captureFailure: false,
        cleanup: { status: 'healthy' as const, code: null, ownedEntryCount: 0 },
      },
      backupPolicy: {
        status: 'best_effort' as const,
        storage: 'private_cache' as const,
        mechanism: 'cachedir_tag' as const,
        automaticSync: 'not_implemented' as const,
      },
    }),
    configure: vi.fn(),
    deleteAll: vi.fn(),
    downloadArtifact: vi.fn(),
    revokeCaptureAuthorization: boundary.revokeCaptureAuthorization,
  }),
}));

import { VoiceDiagnosticsSettingsSection } from './VoiceDiagnosticsSettingsSection';
import {
  publishVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
} from './runtimeStatus';
import { resetVoiceDiagnosticsRevocationForTests } from './runtimeRevocation';
import { resetVoiceDiagnosticsSessionPolicyForTests } from './capturePolicy';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function requireElement(selector: string): HTMLElement {
  const element = container?.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function pressWithPointer(node: HTMLElement): void {
  const base = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
  node.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
  node.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  node.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  });
}

async function renderSettings(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <VoiceDiagnosticsSettingsSection
        voice={boundary.voice!}
        setVoice={vi.fn()}
      />,
    );
  });
  await flush();
}

describe('VoiceDiagnosticsSettingsSection web focus return', () => {
  beforeEach(() => {
    boundary.voice = voiceSettingsParse({
      diagnostics: {
        v: 1,
        enabled: true,
        consentVersion: 1,
        captureSttInput: true,
        captureTtsOutput: false,
        maxAgeMs: 86_400_000,
        maxFiles: 20,
        maxBytes: 104_857_600,
        maxDurationMs: 300_000,
      },
    });
    boundary.sessionId = 'focused-diagnostics-session';
    boundary.revokeCaptureAuthorization.mockClear();
    resetVoiceDiagnosticsRuntimeStatusForTests();
    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsSessionPolicyForTests();
    publishVoiceDiagnosticsRuntimeStatus({ machineId: 'm1', phase: 'active' });
  });

  afterEach(async () => {
    const activeRoot = root;
    if (activeRoot) {
      await act(async () => {
        activeRoot.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  it('returns focus to the persistent diagnostics-enabled Switch after session opt-out removes its focused action', async () => {
    await renderSettings();

    const sessionOptOut = requireElement('[aria-label="settingsVoice.diagnostics.sessionOptOut"]');
    const diagnosticsEnabledSwitch = requireElement('[aria-label="settingsVoice.diagnostics.enabled"]');
    sessionOptOut.focus();
    expect(document.activeElement).toBe(sessionOptOut);

    await act(async () => {
      pressWithPointer(sessionOptOut);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(boundary.revokeCaptureAuthorization).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('[aria-label="settingsVoice.diagnostics.sessionOptOut"]')).toBeNull();
    expect(document.activeElement).toBe(diagnosticsEnabledSwitch);
  });
});
