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

  it('keeps download cancellation outside the row with named button semantics', async () => {
    const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.native');
    const setCfg = vi.fn();
    const { tree } = await renderScreen(<LocalNeuralSttSettings
      cfg={{
        provider: 'local_neural',
        localNeural: {
          assetId: 'stt-pack',
          language: null,
          execution: 'device',
        },
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

    const cancelButton = tree.root.findAllByProps({ accessibilityLabel: 'common.cancel' })
      .find((node) => String(node.type) === 'Pressable');
    expect(cancelButton).toBeTruthy();
    expect(cancelButton!.props.accessibilityRole).toBe('button');

    const signal = installerSpies.ensureInstalled.mock.calls[0]?.[0]?.signal as AbortSignal;
    const stopPropagation = vi.fn();
    await act(async () => {
      cancelButton!.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    expect(installerSpies.ensureInstalled).toHaveBeenCalledOnce();
    expect(setCfg).not.toHaveBeenCalled();
  });

  it('types a custom language inline after choosing Custom in the language menu', async () => {
    const { Modal } = await import('@/modal');
    const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.native');
    const setCfg = vi.fn();
    const cfg = {
      provider: 'local_neural' as const,
      localNeural: { assetId: 'stt-pack', language: null, execution: 'device' as const },
    };
    const { tree } = await renderScreen(<LocalNeuralSttSettings cfg={cfg} setCfg={setCfg} popoverBoundaryRef={null} />);
    await act(async () => {});

    const languageMenu = tree.root.findAll((node) => (
      node.props.itemTrigger?.title === 'settingsVoice.local.localNeuralStt.language.title'
      && typeof node.props.onSelect === 'function'
    ))[0];
    await act(async () => { languageMenu!.props.onSelect('__custom__'); });

    const field = () => tree.root.findAll((node) => (
      node.props.testID === 'settings.voice.localNeuralStt.language.custom.field'
      && typeof node.props.onChangeText === 'function'
    ))[0]!;
    await act(async () => { field().props.onChangeText('fr-CA'); });
    await act(async () => { field().props.onBlur(); });

    expect(Modal.prompt).not.toHaveBeenCalled();
    expect(setCfg).toHaveBeenLastCalledWith({ ...cfg, localNeural: { ...cfg.localNeural, language: 'fr-CA' } });
  });
});
