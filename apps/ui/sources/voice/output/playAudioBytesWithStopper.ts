import { Platform } from 'react-native';

import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { getOrCreateWebAudioContext } from '@/voice/output/webAudioContext';

export async function playAudioBytesWithStopper(opts: {
  bytes: ArrayBuffer;
  format: 'mp3' | 'wav';
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  const mimeType = opts.format === 'wav' ? 'audio/wav' : 'audio/mpeg';

  if (Platform.OS === 'web') {
    const ctx = getOrCreateWebAudioContext();
    if (ctx) {
      return await new Promise<void>((resolve, reject) => {
        let settled = false;
        let clearStopper = () => {};
        let source: any | null = null;

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

        const cleanup = () => {
          const s = source;
          source = null;
          try {
            s?.disconnect?.();
          } catch {
            // ignore
          }
        };

        const stopPlayback = () => {
          try {
            source?.stop?.();
          } catch {
            // ignore
          }
          cleanup();
          safeResolve();
        };
        clearStopper = opts.registerPlaybackStopper(stopPlayback);

        (async () => {
          try {
            if (typeof ctx.resume === 'function') {
              await ctx.resume();
            }

            const bytesCopy = opts.bytes.slice(0);
            const audioBuffer = await ctx.decodeAudioData(bytesCopy);
            const s = ctx.createBufferSource();
            source = s;
            s.buffer = audioBuffer;
            if (typeof s.connect === 'function') s.connect(ctx.destination);
            s.onended = () => {
              cleanup();
              safeResolve();
            };
            s.start(0);
          } catch (error) {
            cleanup();
            safeReject(error);
          }
        })();
      });
    }

    const blob = new Blob([opts.bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    const cleanup = () => {
      try {
        audio.pause();
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

      audio.onended = () => {
        cleanup();
        safeResolve();
      };
      audio.onerror = () => {
        cleanup();
        safeReject(new Error('audio_playback_failed'));
      };

      try {
        const result = audio.play();
        Promise.resolve(result).catch((error) => {
          cleanup();
          safeReject(error);
        });
      } catch (error) {
        cleanup();
        safeReject(error);
      }
    });
  }

  const { createAudioPlayer } = await import('expo-audio');
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
      const result = player.play();
      Promise.resolve(result).catch((error) => {
        void cleanup()
          .then(() => safeReject(error))
          .catch(() => safeReject(error));
      });
    } catch (error) {
      void cleanup()
        .then(() => safeReject(error))
        .catch(() => safeReject(error));
    }
  });
}
