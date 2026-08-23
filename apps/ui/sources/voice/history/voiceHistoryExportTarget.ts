import { Platform } from 'react-native';

import { t } from '@/text';

import type { VoiceHistoryExportArtifact } from './voiceHistoryConsumer';

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
  // Appending chunk by chunk keeps at most one chunk resident: the first write
  // creates/replaces the file exactly as a whole-document write did.
  let isFirstChunk = true;
  for (const chunk of artifact.chunks()) {
    file.write(chunk, isFirstChunk ? undefined : { append: true });
    isFirstChunk = false;
  }
  try {
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
