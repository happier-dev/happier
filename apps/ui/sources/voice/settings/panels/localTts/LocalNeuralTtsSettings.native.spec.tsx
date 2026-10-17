import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
  modelPackDevice as device, modelPackManifest, seedInstalledPack, useModelPackDeviceBoundary, voiceFilesRoot,
} from '../modelPack/modelPackSettings.testHarness';
import { DEFAULT_KOKORO_NATIVE_MODEL_PACK_ID as packId } from '@/voice/kokoro/assets/kokoroAssetSets';
import { t } from '@/text';

const modelTitle = () => t('settingsVoice.local.kokoro.model.title');
const removeTitle = () => t('settingsVoice.local.kokoro.removeAssets.title');
useModelPackDeviceBoundary();

function collectText(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(collectText).join(' ');
}

async function renderSettings() {
  const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');
  const screen = await renderScreen(React.createElement(LocalNeuralTtsSettings, {
    cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
    setKokoro: vi.fn(), networkTimeoutMs: 1000, popoverBoundaryRef: null,
  }));
  const row = (title: string) => screen.findAll(n => n.props.title === title && 'detail' in n.props)[0]!;
  return { screen, row };
}

describe('LocalNeuralTtsSettings through device boundaries', () => {
  it('reports the unavailable native runtime without starting a model download', async () => {
    const { row } = await renderSettings();
    await act(async () => { await pressTestInstanceAsync(row(modelTitle())); });
    expect(device.fetch).not.toHaveBeenCalled();
    expect(device.alert.mock.calls.some(call =>
      call[1] === t('settingsVoice.local.kokoro.alerts.runtimeUnsupported.body'))).toBe(true);
  });

  it('presents native update bytes, file counts and accessible progress while retaining the installed pack on cancellation', async () => {
    seedInstalledPack(packId, 'tts');
    device.fetch.mockImplementation(async () => Response.json(modelPackManifest(packId, 'tts')));
    const { screen, row } = await renderSettings();
    await act(async () => {
      await pressTestInstanceAsync(row(t('settingsVoice.local.kokoro.updates.title')));
      await vi.waitFor(() => expect(device.transfers.length).toBe(2));
    });
    await act(async () => { device.transfers[0]!.report(2, 4); });
    expect(row(modelTitle()).props.detail).toBe('25%');
    expect(collectText(row(modelTitle()))).toContain(t('settingsVoice.local.modelPackDownload.progressWithFiles', {
      loaded: '2 B', total: '8 B', filesDone: 0, filesTotal: 2,
    }));
    expect(screen.findAll(n => n.props.accessibilityRole === 'progressbar')[0]?.props.accessibilityValue)
      .toEqual({ min: 0, max: 100, now: 25 });
    await act(async () => { row(modelTitle()).props.rightElement.props.onPress(); });
    await vi.waitFor(() => expect(row(modelTitle()).props.detail).toBe(t('settingsVoice.local.kokoro.modelStatus.ready')));
    expect(device.files.has(`${voiceFilesRoot}/modelPacks/${packId}/pack.json`)).toBe(true);
    expect([...device.files.keys()].some(path => path.includes('/modelPackUpdates/'))).toBe(false);
  });

  it('shows a partial download from an earlier session and discards its actual files after confirmation', async () => {
    device.files.set(`${voiceFilesRoot}/modelPacks/${packId}/saved.bin`, new Uint8Array(3));
    const { row } = await renderSettings();
    expect(collectText(row(modelTitle()))).toContain('3 B');
    expect(row(removeTitle()).props.detail).toBe('3 B');
    await act(async () => { await pressTestInstanceAsync(row(removeTitle())); });
    await vi.waitFor(() => expect(row(removeTitle()).props.onPress).toBeUndefined());
    expect(device.files.size).toBe(0);
    expect(device.alert.mock.calls.some(call => String(call[1]).includes('3 B'))).toBe(true);
  });

  it('keeps removal inert when no files are present', async () => {
    const { row } = await renderSettings();
    expect(row(removeTitle()).props.onPress).toBeUndefined();
  });
});
