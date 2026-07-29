import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const installerSpies = vi.hoisted(() => ({
  ensureInstalled: vi.fn(),
  getInstallSummary: vi.fn(),
}));

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/voice/modelPacks/installer.native', () => ({
  checkModelPackUpdateAvailable: vi.fn(),
  ensureModelPackInstalled: (...args: any[]) => installerSpies.ensureInstalled(...args),
  getModelPackInstallSummary: (...args: any[]) => installerSpies.getInstallSummary(...args),
  removeModelPack: vi.fn(),
}));

vi.mock('@/voice/modelPacks/manifests', () => ({
  resolveModelPackManifestUrl: () => 'https://example.com/stt-pack.json',
}));

vi.mock('@/voice/runtime/daemonInference/daemonVoiceInferencePolicy', () => ({
  resolveLocalNeuralExecutionPolicy: () => ({
    allowDeviceSelection: true,
    preferredExecution: 'device',
    requestedExecution: 'device',
    selectableExecution: 'device',
  }),
}));

vi.mock('@/voice/sherpa/stt/sherpaStreamingSttPacks', () => ({
  getSherpaStreamingSttPackOptions: () => [{
    id: 'stt-pack',
    title: 'STT pack',
    subtitle: 'Local',
  }],
}));

vi.mock('@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown', () => ({
  DaemonVoiceInferenceExecutionDropdown: (props: any) => React.createElement('ExecutionDropdown', props),
}));

vi.mock('@/voice/settings/panels/modelCatalog/DaemonModelPackRow', () => ({
  SelectedDaemonModelPackRow: (props: any) => React.createElement('DaemonModelPackRow', props),
}));

function expectAtLeast44PointTarget(style: unknown): void {
  const flattened = (Array.isArray(style) ? style : [style]).reduce<Record<string, unknown>>(
    (result, entry) => entry && typeof entry === 'object' ? { ...result, ...entry } : result,
    {},
  );
  const width = Math.max(
    typeof flattened.width === 'number' ? flattened.width : 0,
    typeof flattened.minWidth === 'number' ? flattened.minWidth : 0,
  );
  const height = Math.max(
    typeof flattened.height === 'number' ? flattened.height : 0,
    typeof flattened.minHeight === 'number' ? flattened.minHeight : 0,
  );
  expect(width).toBeGreaterThanOrEqual(44);
  expect(height).toBeGreaterThanOrEqual(44);
}

type AccessoryButtonProps = {
  accessibilityRole?: string;
  accessibilityLabel?: string;
  style?: unknown;
  onPress: (event: { stopPropagation?: () => void }) => void;
};

function requireAccessoryButton(node: unknown): React.ReactElement<AccessoryButtonProps> {
  if (!React.isValidElement<AccessoryButtonProps>(node)) {
    throw new Error('Expected an accessory button element');
  }
  return node;
}

describe('LocalNeuralSttSettings native model download accessory', () => {
  beforeEach(() => {
    installerSpies.ensureInstalled.mockReset();
    installerSpies.ensureInstalled.mockImplementation(() => new Promise(() => {}));
    installerSpies.getInstallSummary.mockReset();
    installerSpies.getInstallSummary.mockResolvedValue({
      installed: false,
      manifest: null,
    });
  });

  it('keeps download cancellation outside the row with named 44pt button semantics', async () => {
    const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.native');
    const setCfg = vi.fn();
    const { tree } = await renderScreen(<LocalNeuralSttSettings
      cfg={{
        provider: 'local_neural',
        openaiCompat: {
          baseUrl: null,
          insecureLocalOriginConsent: null,
          insecureLocalConsentMachineId: null,
          apiKey: null,
          model: 'whisper-1',
        },
        localNeural: {
          assetId: 'stt-pack',
          language: null,
          execution: 'device',
        },
        providers: {},
      }}
      setCfg={setCfg}
      popoverBoundaryRef={null}
    />);
    await act(async () => {});

    const findModelRow = () => tree.root.findAll((node) => (
      node.props.title === 'settingsVoice.local.localNeuralStt.modelFiles.title'
      && typeof node.props.onPress === 'function'
      && node.props.rightElement !== undefined
    ))[0];
    expect(findModelRow()).toBeTruthy();
    await act(async () => {
      findModelRow()?.props.onPress();
      await Promise.resolve();
    });

    const modelRow = findModelRow();
    expect(modelRow).toBeTruthy();
    expect(modelRow?.props.rightElementOutsidePressable).toBe(true);

    const cancelButton = requireAccessoryButton(modelRow?.props.rightElement);
    expect(cancelButton.props.accessibilityRole).toBe('button');
    expect(cancelButton.props.accessibilityLabel).toBe('common.cancel');
    expectAtLeast44PointTarget(cancelButton.props.style);

    const signal = installerSpies.ensureInstalled.mock.calls[0]?.[0]?.signal as AbortSignal;
    const stopPropagation = vi.fn();
    await act(async () => {
      cancelButton.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    expect(installerSpies.ensureInstalled).toHaveBeenCalledOnce();
    expect(setCfg).not.toHaveBeenCalled();
  });
});
