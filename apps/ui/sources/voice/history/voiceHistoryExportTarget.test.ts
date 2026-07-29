import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceHistoryExportArtifact } from './voiceHistoryConsumer';
import {
  saveVoiceHistoryExportArtifactToWeb,
  shareVoiceHistoryExportArtifactNative,
} from './voiceHistoryExportTarget';

const nativeBoundary = vi.hoisted(() => {
  const file = {
    uri: 'file:///cache/happier-voice-history.json',
    write: vi.fn(),
    delete: vi.fn(),
  };
  return {
    file,
    File: vi.fn(function File() {
      return file;
    }),
    isAvailableAsync: vi.fn(async () => true),
    shareAsync: vi.fn(async () => undefined),
  };
});

vi.mock('expo-file-system', () => ({
  File: nativeBoundary.File,
  Paths: { cache: 'file:///cache' },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: nativeBoundary.isAvailableAsync,
  shareAsync: nativeBoundary.shareAsync,
}));

const ARTIFACT: VoiceHistoryExportArtifact = {
  fileName: 'happier-voice-history.json',
  mimeType: 'application/json',
  content: '{"version":1}',
  rowCount: 1,
  range: 'all',
};

describe('Voice History export targets', () => {
  beforeEach(() => {
    nativeBoundary.file.write.mockClear();
    nativeBoundary.file.delete.mockClear();
    nativeBoundary.File.mockClear();
    nativeBoundary.isAvailableAsync.mockClear();
    nativeBoundary.isAvailableAsync.mockResolvedValue(true);
    nativeBoundary.shareAsync.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('downloads JSON through a browser object URL and releases it after navigation starts', async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click,
      remove,
    };
    const createObjectURL = vi.fn(() => 'blob:voice-history');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    await saveVoiceHistoryExportArtifactToWeb(ARTIFACT);

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.href).toBe('blob:voice-history');
    expect(anchor.download).toBe(ARTIFACT.fileName);
    expect(anchor.rel).toBe('noopener noreferrer');
    expect(anchor.style.display).toBe('none');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice-history');
  });

  it('writes, shares, and removes the bounded JSON through native platform boundaries', async () => {
    await shareVoiceHistoryExportArtifactNative(ARTIFACT);

    expect(nativeBoundary.isAvailableAsync).toHaveBeenCalledOnce();
    expect(nativeBoundary.File).toHaveBeenCalledWith('file:///cache', ARTIFACT.fileName);
    expect(nativeBoundary.file.write).toHaveBeenCalledWith(ARTIFACT.content);
    expect(nativeBoundary.shareAsync).toHaveBeenCalledWith(
      nativeBoundary.file.uri,
      expect.objectContaining({ mimeType: ARTIFACT.mimeType }),
    );
    expect(nativeBoundary.file.delete).toHaveBeenCalledOnce();
  });
});
