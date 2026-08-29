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
    const createObjectURL = vi.fn((_value: Blob) => 'blob:voice-history');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    await saveVoiceHistoryExportArtifactToWeb(ARTIFACT);

    expect(createObjectURL).toHaveBeenCalledOnce();
    // Every chunk reaches the Blob, in order: a lazy export that dropped or
    // reordered a chunk would still download as invalid JSON.
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

  it('keeps the unavoidable whole-export materialization at the web Blob boundary', async () => {
    vi.useFakeTimers();
    const chunks = {
      *[Symbol.iterator]() {
        yield '{"version":1,"entries":[';
        yield ']}';
      },
    };
    const artifact: VoiceHistoryExportArtifact = {
      ...ARTIFACT,
      chunks: () => chunks,
    };
    const receivedParts: unknown[] = [];
    class TestBlob {
      constructor(parts: unknown) {
        receivedParts.push(parts);
      }
    }
    vi.stubGlobal('Blob', TestBlob);
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: vi.fn(),
        remove: vi.fn(),
      })),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:voice-history'),
      revokeObjectURL: vi.fn(),
    });

    await saveVoiceHistoryExportArtifactToWeb(artifact);

    // The standard object-URL download path cannot append/stream to disk. The
    // platform owner therefore materializes one parts sequence and one Blob;
    // this is a truthful web limitation, not permission to cap "all".
    expect(receivedParts).toEqual([[...chunks]]);
    await vi.runAllTimersAsync();
  });

  it('coalesces ordered native writes to a bounded buffer, shares the result, and removes it', async () => {
    const chunks = [
      'a'.repeat(32 * 1024),
      'b'.repeat(32 * 1024),
      'c'.repeat(32 * 1024),
    ];
    const artifact: VoiceHistoryExportArtifact = {
      ...ARTIFACT,
      chunks: () => chunks,
    };
    await shareVoiceHistoryExportArtifactNative(artifact);

    expect(nativeBoundary.isAvailableAsync).toHaveBeenCalledOnce();
    expect(nativeBoundary.File).toHaveBeenCalledWith('file:///cache', ARTIFACT.fileName);
    // The existing target remains the ordered streaming sink, but coalesces
    // small producer chunks so the native file boundary is not invoked once per
    // row. The final partial buffer must still be appended in order.
    expect(nativeBoundary.file.write.mock.calls).toEqual([
      [`${chunks[0]}${chunks[1]}`, undefined],
      [chunks[2], { append: true }],
    ]);
    expect(nativeBoundary.shareAsync).toHaveBeenCalledWith(
      nativeBoundary.file.uri,
      expect.objectContaining({ mimeType: ARTIFACT.mimeType }),
    );
    expect(nativeBoundary.file.delete).toHaveBeenCalledOnce();
  });

  it('keeps every native write UTF-8 bounded across awkward code-point boundaries', async () => {
    const boundaryChunk = `${'a'.repeat((64 * 1024) - 1)}😀`;
    const mixedChunk = Array.from(
      { length: 24_000 },
      (_value, index) => ['b', 'é', '漢', '😀', '🫠'][index % 5],
    ).join('');
    const artifact: VoiceHistoryExportArtifact = {
      ...ARTIFACT,
      chunks: () => [boundaryChunk, mixedChunk],
    };

    await shareVoiceHistoryExportArtifactNative(artifact);

    const writes = nativeBoundary.file.write.mock.calls.map(([contents]) => contents as string);
    expect(writes.length).toBeGreaterThan(1);
    // 65,535 ASCII bytes cannot absorb the following four-byte emoji. The
    // first write must flush before the emoji, rather than emitting 65,539 B.
    expect(writes[0]).toBe('a'.repeat((64 * 1024) - 1));
    expect(writes.join('')).toBe(`${boundaryChunk}${mixedChunk}`);
    for (const write of writes) {
      expect(new TextEncoder().encode(write).byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(new TextDecoder().decode(new TextEncoder().encode(write))).toBe(write);
    }
  });

  it('removes the native cache file when a buffered write fails before sharing', async () => {
    nativeBoundary.file.write.mockImplementationOnce(() => {
      throw new Error('write_failed');
    });

    await expect(shareVoiceHistoryExportArtifactNative(ARTIFACT)).rejects.toThrow('write_failed');

    expect(nativeBoundary.shareAsync).not.toHaveBeenCalled();
    expect(nativeBoundary.file.delete).toHaveBeenCalledOnce();
  });

  it('removes the native cache file when the export producer throws before sharing', async () => {
    const artifact: VoiceHistoryExportArtifact = {
      ...ARTIFACT,
      chunks: function* () {
        yield '{"version":1';
        throw new Error('producer_failed');
      },
    };

    await expect(shareVoiceHistoryExportArtifactNative(artifact)).rejects.toThrow('producer_failed');

    expect(nativeBoundary.shareAsync).not.toHaveBeenCalled();
    expect(nativeBoundary.file.delete).toHaveBeenCalledOnce();
  });
});
