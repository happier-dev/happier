import { createAudioPlayer } from 'expo-audio';
import { Platform } from 'react-native';

import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';

export async function playAudioBytesWithStopper(opts: {
  bytes: ArrayBuffer;
  format: 'mp3' | 'wav';
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  const mimeType = opts.format === 'wav' ? 'audio/wav' : 'audio/mpeg';

  if (Platform.OS === 'web') {
    const blob = new Blob([opts.bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const player = createAudioPlayer(url);
    let subscription: { remove(): void } | null = null;

    const cleanup = () => {
      try {
        subscription?.remove();
      } catch {
        // ignore
      }
      subscription = null;
      try {
        player.remove();
      } catch {
        // ignore
      }
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    };

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      let clearStopper = () => {};
      const safeResolve = () => {
        if (settled) return;
        settled = true;
        clearStopper();
        resolve();
      };
      const safeReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearStopper();
        reject(error);
      };

      const stopPlayback = () => {
        cleanup();
        safeResolve();
      };
      clearStopper = opts.registerPlaybackStopper(stopPlayback);

      subscription = player.addListener('playbackStatusUpdate', (status: any) => {
        if (!status?.didJustFinish) return;
        cleanup();
        safeResolve();
      });

      try {
        player.play();
      } catch (error) {
        cleanup();
        safeReject(error);
      }
    });
  }

  const ext = opts.format === 'wav' ? '.wav' : '.mp3';
  const { File, Paths, deleteAsync } = await import('expo-file-system');
  const file = new File(Paths.cache, `happier-voice-${Date.now()}${ext}`);
  await file.write(new Uint8Array(opts.bytes));

  const player = createAudioPlayer(file.uri);
  let subscription: { remove(): void } | null = null;
  const cleanup = async () => {
    try {
      subscription?.remove();
    } catch {
      // ignore
    }
    subscription = null;
    try {
      player.remove();
    } catch {
      // ignore
    }
    try {
      await deleteAsync(file.uri, { idempotent: true });
    } catch {
      // ignore
    }
  };

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let clearStopper = () => {};
    const safeResolve = () => {
      if (settled) return;
      settled = true;
      clearStopper();
      resolve();
    };
    const safeReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearStopper();
      reject(error);
    };

    const stopPlayback = () => {
      void cleanup()
        .then(() => safeResolve())
        .catch(() => safeResolve());
    };
    clearStopper = opts.registerPlaybackStopper(stopPlayback);

    subscription = player.addListener('playbackStatusUpdate', (status: any) => {
      if (!status?.didJustFinish) return;
      void cleanup()
        .then(() => safeResolve())
        .catch((error) => safeReject(error));
    });

    try {
      player.play();
    } catch (error) {
      void cleanup()
        .then(() => safeReject(error))
        .catch(() => safeReject(error));
    }
  });
}

