import { Platform } from 'react-native';

import { t } from '@/text';

import type { VoiceHistoryExportArtifact } from './voiceHistoryConsumer';

const NATIVE_EXPORT_WRITE_BUFFER_BYTES = 64 * 1024;

export type VoiceHistoryExportTargetRuntime = Readonly<{
  platformOS: string;
  saveWeb(artifact: VoiceHistoryExportArtifact): Promise<void>;
  shareNative(artifact: VoiceHistoryExportArtifact): Promise<void>;
}>;

export async function saveVoiceHistoryExportArtifactWithRuntime(
  artifact: VoiceHistoryExportArtifact,
  runtime: VoiceHistoryExportTargetRuntime,
): Promise<void> {
  if (runtime.platformOS === 'web') {
    await runtime.saveWeb(artifact);
    return;
  }
  await runtime.shareNative(artifact);
}

export async function saveVoiceHistoryExportArtifactToWeb(
  artifact: VoiceHistoryExportArtifact,
): Promise<void> {
  if (
    typeof document === 'undefined'
    || typeof Blob === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) {
    throw new Error('Voice History export is unavailable on this platform');
  }
  // The chunk sequence is handed straight to Blob as its part list: the browser
  // copies each part once, and no concatenated whole-document string is built
  // alongside it.
  const objectUrl = URL.createObjectURL(new Blob([...artifact.chunks()], {
    type: artifact.mimeType,
  }));
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = artifact.fileName;
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    document.body?.appendChild(anchor);
    anchor.click();
    setTimeout(() => anchor.remove(), 0);
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export async function shareVoiceHistoryExportArtifactNative(
  artifact: VoiceHistoryExportArtifact,
): Promise<void> {
  const FileSystem = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const baseDirectory = FileSystem.Paths.cache ?? FileSystem.Paths.document;
  if (!baseDirectory || typeof Sharing.shareAsync !== 'function') {
    throw new Error('Voice History export is unavailable on this platform');
  }
  if (
    typeof Sharing.isAvailableAsync === 'function'
    && !await Sharing.isAvailableAsync()
  ) {
    throw new Error('Voice History export is unavailable on this platform');
  }

  const file = new FileSystem.File(baseDirectory, artifact.fileName);
  try {
    // Keep the existing target as the streaming owner, but coalesce the
    // producer's small JSON fragments before crossing the native file boundary.
    // Oversized producer chunks split only between Unicode code points, so every
    // native write is actually bounded without changing document order.
    let bufferedChunks: string[] = [];
    let bufferedBytes = 0;
    let isFirstChunk = true;
    const flush = (): void => {
      if (bufferedChunks.length === 0) return;
      file.write(bufferedChunks.join(''), isFirstChunk ? undefined : { append: true });
      isFirstChunk = false;
      bufferedChunks = [];
      bufferedBytes = 0;
    };
    const utf8ByteLength = (codePoint: number): number => {
      if (codePoint <= 0x7f) return 1;
      if (codePoint <= 0x7ff) return 2;
      return codePoint <= 0xffff ? 3 : 4;
    };
    const appendChunk = (chunk: string): void => {
      let segmentStart = 0;
      let segmentBytes = 0;
      for (let index = 0; index < chunk.length;) {
        const codePoint = chunk.codePointAt(index);
        if (codePoint === undefined) break;
        const codePointWidth = codePoint > 0xffff ? 2 : 1;
        const codePointBytes = utf8ByteLength(codePoint);
        if (bufferedBytes + segmentBytes + codePointBytes > NATIVE_EXPORT_WRITE_BUFFER_BYTES) {
          if (segmentStart < index) {
            bufferedChunks.push(chunk.slice(segmentStart, index));
            bufferedBytes += segmentBytes;
          }
          flush();
          segmentStart = index;
          segmentBytes = 0;
        }
        segmentBytes += codePointBytes;
        index += codePointWidth;
        if (bufferedBytes + segmentBytes >= NATIVE_EXPORT_WRITE_BUFFER_BYTES) {
          bufferedChunks.push(chunk.slice(segmentStart, index));
          bufferedBytes += segmentBytes;
          flush();
          segmentStart = index;
          segmentBytes = 0;
        }
      }
      if (segmentStart < chunk.length) {
        bufferedChunks.push(chunk.slice(segmentStart));
        bufferedBytes += segmentBytes;
      }
    };
    for (const chunk of artifact.chunks()) {
      appendChunk(chunk);
    }
    flush();
    await Sharing.shareAsync(file.uri, {
      mimeType: artifact.mimeType,
      dialogTitle: t('settingsVoice.history.exportTitle'),
    });
  } finally {
    try {
      file.delete();
    } catch {
      // The share boundary may have moved or already removed the cache file.
    }
  }
}

export async function saveVoiceHistoryExportArtifact(
  artifact: VoiceHistoryExportArtifact,
): Promise<void> {
  await saveVoiceHistoryExportArtifactWithRuntime(artifact, {
    platformOS: Platform.OS,
    saveWeb: saveVoiceHistoryExportArtifactToWeb,
    shareNative: shareVoiceHistoryExportArtifactNative,
  });
}
