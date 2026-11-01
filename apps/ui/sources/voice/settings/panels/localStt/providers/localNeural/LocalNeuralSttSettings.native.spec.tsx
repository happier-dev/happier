import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
  modelPackDevice as device, modelPackManifest, useModelPackDeviceBoundary, voiceFilesRoot,
} from '../../../modelPack/modelPackSettings.testHarness';
import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';

const packId = 'stt-pack';
const modelTitle = () => t('settingsVoice.local.localNeuralStt.modelFiles.title');
const removeTitle = () => t('settingsVoice.local.localNeuralStt.removeModelFiles.title');
useModelPackDeviceBoundary();

function collectText(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(collectText).join(' ');
}

async function renderSettings() {
  const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.native');
  const screen = await renderScreen(React.createElement(LocalNeuralSttSettings, {
    cfg: VoiceLocalSttSchema.parse({ provider: 'local_neural', localNeural: { assetId: packId } }),
    setCfg: vi.fn(), popoverBoundaryRef: null,
  }));
  const row = (title: string) => screen.findAll(n => n.props.title === title && 'detail' in n.props)[0]!;
  return { screen, row };
}

describe('LocalNeuralSttSettings through device boundaries', () => {
  it('presents native transfer bytes, file counts and accessible progress, then clears cancelled partial files', async () => {
    device.fetch.mockImplementation(async () => Response.json(modelPackManifest(packId, 'stt')));
    const { screen, row } = await renderSettings();
    await act(async () => {
      await pressTestInstanceAsync(row(modelTitle()));
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
    await vi.waitFor(() => expect(row(removeTitle()).props.onPress).toBeUndefined());
    expect([...device.files.keys()].some(path => path.includes(`/modelPacks/${packId}/`))).toBe(false);
  });

  it('retains saved bytes after a manifest failure and discards them after confirmation', async () => {
    device.files.set(`${voiceFilesRoot}/modelPacks/${packId}/saved.bin`, new Uint8Array(3));
    device.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    const { row } = await renderSettings();
    await act(async () => {
      await pressTestInstanceAsync(row(modelTitle()));
      await vi.waitFor(() => expect(device.alert).toHaveBeenCalled());
    });
    expect(collectText(row(modelTitle()))).toContain('3 B');
    expect(typeof row(modelTitle()).props.onPress).toBe('function');
    expect(row(removeTitle()).props.detail).toBe('3 B');
    await act(async () => { await pressTestInstanceAsync(row(removeTitle())); });
    await vi.waitFor(() => expect(row(removeTitle()).props.onPress).toBeUndefined());
    expect(device.files.size).toBe(0);
    expect(device.alert.mock.calls.some(call => String(call[1]).includes('3 B'))).toBe(true);
  });
});
