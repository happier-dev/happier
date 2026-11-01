import { createHash } from 'node:crypto';
import { beforeEach, vi } from 'vitest';
import type { DownloadOptions, DownloadProgressData, DownloadResumable, FileSystemDownloadResult } from 'expo-file-system/legacy';

export type NativeModelPackTransfer = Readonly<{
  url: string;
  report(loaded: number, total: number): void;
  finish(bytes?: Uint8Array): void;
}>;

const boundary = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  transfers: [] as NativeModelPackTransfer[],
  failDelete: false,
  failDeleteUri: null as string | null,
  failDocumentPath: false,
  availableDiskSpace: null as number | null,
  fetch: vi.fn<typeof fetch>(),
  alert: vi.fn<typeof import('react-native')['Alert']['alert']>(),
}));

// Only device files, native transfers, network and OS dialogs are substituted.
// The screen, lists, catalogs, lifecycle hook, installer, hashing, text and ModalManager stay real.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'android' }, { Alert: { alert: boundary.alert } }));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo/fetch', () => ({ fetch: boundary.fetch }));
vi.mock('expo-file-system', () => {
  const uri = (parts: Array<string | { uri: string }>) =>
    parts.map(part => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  return {
    Paths: { get document() {
      if (boundary.failDocumentPath) throw new Error('storage_unavailable');
      return 'file:///docs';
    },
    get availableDiskSpace() { return boundary.availableDiskSpace; } },
    Directory: class {
      uri: string;
      constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
      get exists() { return [...boundary.files.keys()].some(path => path.startsWith(`${this.uri}/`)); }
      get size() {
        return [...boundary.files].reduce((bytes, [path, data]) =>
          bytes + (path.startsWith(`${this.uri}/`) ? data.length : 0), 0);
      }
      create() {}
      delete() {
        if (boundary.failDelete || boundary.failDeleteUri === this.uri) throw new Error('storage_delete_failed');
        for (const path of boundary.files.keys()) if (path.startsWith(`${this.uri}/`)) boundary.files.delete(path);
      }
    },
    File: class {
      uri: string;
      constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
      get exists() { return boundary.files.has(this.uri); }
      create() { if (!this.exists) boundary.files.set(this.uri, new Uint8Array()); }
      delete() { boundary.files.delete(this.uri); }
      write(data: string | Uint8Array) {
        boundary.files.set(this.uri, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
      }
      async text() { return new TextDecoder().decode(boundary.files.get(this.uri)); }
      move(destination: { uri: string }) {
        const bytes = boundary.files.get(this.uri);
        if (!bytes) throw new Error('file_missing');
        boundary.files.set(destination.uri, bytes);
        boundary.files.delete(this.uri);
        this.uri = destination.uri;
      }
      open() {
        const bytes = boundary.files.get(this.uri) ?? new Uint8Array();
        let offset = 0;
        return {
          readBytes(length: number) {
            const chunk = bytes.slice(offset, offset + length);
            offset += chunk.length;
            return chunk;
          },
          close() {},
        };
      }
    },
  };
});
vi.mock('expo-file-system/legacy', () => ({
  FileSystemSessionType: { FOREGROUND: 1, BACKGROUND: 0 },
  createDownloadResumable: (
    url: string, destination: string, options?: DownloadOptions, onProgress?: (data: DownloadProgressData) => void,
  ): Pick<DownloadResumable, 'downloadAsync' | 'pauseAsync' | 'cancelAsync'> => {
    let finish!: (value: FileSystemDownloadResult | undefined) => void;
    const outcome = new Promise<FileSystemDownloadResult | undefined>(resolve => { finish = resolve; });
    boundary.transfers.push({
      url,
      report(loaded, total) {
        boundary.files.set(destination, new Uint8Array(loaded));
        onProgress?.({ totalBytesWritten: loaded, totalBytesExpectedToWrite: total });
      },
      finish(bytes) {
        if (bytes) boundary.files.set(destination, bytes);
        finish(bytes ? { uri: destination, status: 200, headers: {}, mimeType: null } : undefined);
      },
    });
    return {
      downloadAsync: () => outcome,
      async pauseAsync() { finish(undefined); return { url, fileUri: destination, options: options ?? {} }; },
      async cancelAsync() { finish(undefined); },
    };
  },
}));

export const modelPackDevice = boundary;
export const voiceFilesRoot = 'file:///docs/happier/voice';
export const modelBytes = new Uint8Array([1, 2, 3, 4]);

export function modelPackManifest(packId: string, role: 'stt' | 'tts', hash?: string) {
  const sha256 = hash ?? createHash('sha256').update(modelBytes).digest('hex');
  return {
    packId, kind: role === 'stt' ? 'stt_sherpa' : 'tts_sherpa', model: role === 'stt' ? 'zipformer' : 'kokoro', version: '1',
    files: ['first.bin', 'second.bin'].map(path => ({
      path, url: `https://example.test/${path}`, sha256, sizeBytes: modelBytes.length,
    })),
  };
}

export function seedInstalledPack(packId: string, role: 'stt' | 'tts') {
  const manifest = modelPackManifest(packId, role, 'a'.repeat(64));
  boundary.files.set(`${voiceFilesRoot}/modelPacks/${packId}/pack.json`,
    new TextEncoder().encode(JSON.stringify({ manifest })));
  for (const file of manifest.files) boundary.files.set(`${voiceFilesRoot}/modelPacks/${packId}/${file.path}`, modelBytes.slice());
}

export function useModelPackDeviceBoundary() {
  beforeEach(async () => {
    // Initialize the mocked SDK module before concurrent dynamic imports reach it.
    await import('expo-file-system');
    await import('expo/fetch');
    boundary.files.clear();
    boundary.transfers.length = 0;
    boundary.failDelete = false;
    boundary.failDeleteUri = null;
    boundary.failDocumentPath = false;
    boundary.availableDiskSpace = null;
    boundary.fetch.mockReset();
    boundary.alert.mockReset().mockImplementation((_title, _message, buttons) => {
      buttons?.find(button => button.style !== 'cancel')?.onPress?.();
    });
  });
}
