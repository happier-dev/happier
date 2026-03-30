import React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installLocalTtsCommonModuleMocks } from './localTtsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const prepareKokoroTtsSpy = vi.fn();
const getModelPackInstallSummarySpy = vi.fn();

installLocalTtsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
            },
        }).module;
    },
});

vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  prepareKokoroTts: (...args: any[]) => prepareKokoroTtsSpy(...args),
}));

vi.mock('@/voice/modelPacks/installer.native', () => ({
  checkModelPackUpdateAvailable: vi.fn(),
  ensureModelPackInstalled: vi.fn(),
  getModelPackInstallSummary: (...args: any[]) => getModelPackInstallSummarySpy(...args),
  removeModelPack: vi.fn(),
}));

vi.mock('@/voice/modelPacks/formatBuildLabel', () => ({
  formatModelPackBuildLabel: () => null,
}));

function createHarness(
  useHook: (props: { packId: string; manifestUrl: string | null; networkTimeoutMs: number }) => { prepareModel: () => Promise<void> },
) {
  return function Harness(props: { packId: string; manifestUrl: string | null; networkTimeoutMs: number }) {
    const state = useHook(props);
    return React.createElement('Harness', { onPrepare: state.prepareModel });
  };
}

describe('useLocalNeuralModelPackState (native)', () => {
  beforeEach(() => {
    modalAlertSpy.mockClear();
    prepareKokoroTtsSpy.mockClear();
    getModelPackInstallSummarySpy.mockClear();
    getModelPackInstallSummarySpy.mockResolvedValue({ installed: false, packDirUri: 'file:///packs', manifest: null });
  });

  it('surfaces prepare errors via Modal.alert', async () => {
    prepareKokoroTtsSpy.mockRejectedValueOnce(new Error('kokoro_native_module_unavailable'));

    const { useLocalNeuralModelPackState } = await import('./useLocalNeuralModelPackState.native');
    const Harness = createHarness(useLocalNeuralModelPackState);

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(Harness, { packId: 'dummy-pack', manifestUrl: null, networkTimeoutMs: 1000 }))).tree;
    await act(async () => {});

    const node = tree.findByType('Harness');
    await act(async () => {
      invokeTestInstanceHandler(await node, 'onPrepare', );
    });

    expect(modalAlertSpy).toHaveBeenCalled();
    expect(String(modalAlertSpy.mock.calls[0]?.[1] ?? '')).toContain('kokoro_native_module_unavailable');
  });
});
