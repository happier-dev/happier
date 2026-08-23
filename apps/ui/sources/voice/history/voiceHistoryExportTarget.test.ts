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

const ARTIFACT_CHUNKS = Object.freeze([
  '{"version":1,"entries":[',
  '{"id":"a"}',
  ',{"id":"b"}',
  ']}',
]);
const ARTIFACT: VoiceHistoryExportArtifact = {
  fileName: 'happier-voice-history.json',
  mimeType: 'application/json',
  chunks: () => ARTIFACT_CHUNKS,
  rowCount: 2,
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
    // Every chunk reaches the Blob, in order: a streamed export that dropped or
    // reordered a chunk would still download, as invalid JSON.
    expect(await (createObjectURL.mock.calls[0]![0] as unknown as Blob).text())
      .toBe(ARTIFACT_CHUNKS.join(''));
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

  it('streams every chunk into the native file, shares it, and removes it', async () => {
    await shareVoiceHistoryExportArtifactNative(ARTIFACT);

    expect(nativeBoundary.isAvailableAsync).toHaveBeenCalledOnce();
    expect(nativeBoundary.File).toHaveBeenCalledWith('file:///cache', ARTIFACT.fileName);
    // The first write replaces the file; every later chunk appends, so the file
    // holds the whole document instead of only its last chunk.
    expect(nativeBoundary.file.write.mock.calls).toEqual([
      [ARTIFACT_CHUNKS[0], undefined],
      [ARTIFACT_CHUNKS[1], { append: true }],
      [ARTIFACT_CHUNKS[2], { append: true }],
      [ARTIFACT_CHUNKS[3], { append: true }],
    ]);
    expect(nativeBoundary.shareAsync).toHaveBeenCalledWith(
      nativeBoundary.file.uri,
      expect.objectContaining({ mimeType: ARTIFACT.mimeType }),
    );
    expect(nativeBoundary.file.delete).toHaveBeenCalledOnce();
  });
});
