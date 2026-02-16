import React from 'react';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const prepareKokoroTtsSpy = vi.fn();

vi.mock('react-native-unistyles', () => {
  const theme = { colors: { textSecondary: '#999' } };
  return {
    useUnistyles: () => ({ theme }),
    StyleSheet: {
      create: (factory: any) => (typeof factory === 'function' ? {} : factory),
      absoluteFillObject: {},
    },
  };
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: (...args: any[]) => modalAlertSpy(...args),
  },
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : props.trigger,
    ),
}));

vi.mock('@/voice/kokoro/runtime/kokoroSupport', () => ({
  isKokoroRuntimeSupported: () => true,
}));

vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  prepareKokoroTts: (...args: any[]) => prepareKokoroTtsSpy(...args),
}));

vi.mock('@/voice/output/KokoroTtsController', () => ({
  speakKokoroText: vi.fn(),
}));

vi.mock('@/voice/runtime/VoicePlaybackController', () => ({
  createVoicePlaybackController: () => ({ registerStopper: () => () => {}, interrupt: vi.fn() }),
}));

vi.mock('@/voice/kokoro/assets/kokoroBrowserCache', () => ({
  getKokoroBrowserCacheSummary: vi.fn(async () => ({ transformersCacheCount: 0, kokoroVoicesCacheCount: 0 })),
  clearKokoroBrowserCaches: vi.fn(async () => {}),
}));

let runtimeUrl: string | null = null;
async function ensureTestKokoroWebRuntimeUrl(): Promise<string> {
  if (runtimeUrl) return runtimeUrl;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-kokoro-web-runtime-'));
  const filePath = path.join(dir, 'kokoro.web.mjs');
  const contents = `
export const env = {
  _wasmPaths: null,
  set wasmPaths(v) { this._wasmPaths = v; },
  get wasmPaths() { return this._wasmPaths; },
};
export class KokoroTTS {
  get voices() {
    return { af_heart: { name: 'Heart', language: 'en-us' } };
  }
  static async from_pretrained() {
    return new KokoroTTS();
  }
}
`;
  await fs.writeFile(filePath, contents, 'utf8');
  runtimeUrl = pathToFileURL(filePath).toString();
  return runtimeUrl;
}

describe('LocalNeuralTtsSettings (web)', () => {
  beforeEach(async () => {
    modalAlertSpy.mockClear();
    prepareKokoroTtsSpy.mockClear();
    process.env.EXPO_PUBLIC_KOKORO_WEB_RUNTIME_URL = await ensureTestKokoroWebRuntimeUrl();
  });

  it('surfaces prepare errors via Modal.alert', async () => {
    prepareKokoroTtsSpy.mockRejectedValueOnce(new Error('kokoro_import_failed'));
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.web');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        React.createElement(LocalNeuralTtsSettings, {
          cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
          setKokoro: vi.fn(),
          networkTimeoutMs: 1000,
          popoverBoundaryRef: null,
        }),
      );
    });
    // Flush async effects that load cache summary and voice catalog.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const modelItem = tree.root
      .findAll((n) => n.props?.title === 'Kokoro model')
      .find((n) => typeof n.props?.onPress === 'function');
    expect(modelItem).toBeTruthy();

    await act(async () => {
      modelItem!.props.onPress?.();
    });
    await act(async () => {});

    expect(modalAlertSpy).toHaveBeenCalled();
    expect(String(modalAlertSpy.mock.calls[0]?.[1] ?? '')).toContain('kokoro_import_failed');
  });
});
