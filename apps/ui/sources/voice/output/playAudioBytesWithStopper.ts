import { Platform } from 'react-native';

import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { getOrCreateWebAudioContext } from '@/voice/output/webAudioContext';

export async function playAudioBytesWithStopper(opts: {
  bytes: ArrayBuffer;
  format: 'mp3' | 'wav';
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onPlaybackStarted?: () => void;
}): Promise<void> {
  const mimeType = opts.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
  const nativeStatusShowsPlaybackStarted = (status: any) =>
    status?.playing === true
    || status?.timeControlStatus === 'playing'
    || status?.didJustFinish === true;
  let playbackStartedNotified = false;
  const notifyPlaybackStarted = () => {
    if (playbackStartedNotified) {
      return;
    }
    playbackStartedNotified = true;
    try {
      opts.onPlaybackStarted?.();
    } catch {
      // State notification must not break already-started playback.
    }
  };

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
            notifyPlaybackStarted();
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
        Promise.resolve(result)
          .then(() => {
            notifyPlaybackStarted();
          })
          .catch((error) => {
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
  const { File, Paths } = await import('expo-file-system');
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
      await file.delete();
    } catch {
      // ignore
    }
  };

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let clearStopper = () => {};
    let cleanupPromise: Promise<void> | null = null;
    const runCleanup = () => {
      cleanupPromise ??= cleanup();
      return cleanupPromise;
    };
    const safeResolve = () => {
      if (settled) return;
      void runCleanup().catch(() => {});
      settled = true;
      clearStopper();
      resolve();
    };
    const safeReject = (error: unknown) => {
      if (settled) return;
      void runCleanup().catch(() => {});
      settled = true;
      clearStopper();
      reject(error);
    };

    const stopPlayback = () => {
      safeResolve();
    };
    clearStopper = opts.registerPlaybackStopper(stopPlayback);

    subscription = player.addListener('playbackStatusUpdate', (status: any) => {
      // Settle on a post-play() failure surfaced via status (corrupt bytes,
      // decode error, failed load) instead of leaving the promise unsettled.
      // Because the streaming chunk queue is serial, a hung chunk would block
      // every subsequent chunk until an interrupt (audit Finding 4).
      const failed =
        status?.error != null
        || status?.reasonForWaitingToPlay === 'error';
      if (failed) {
        safeReject(new Error('audio_playback_failed'));
        return;
      }
      if (nativeStatusShowsPlaybackStarted(status)) {
        notifyPlaybackStarted();
      }
      if (!status?.didJustFinish) return;
      safeResolve();
    });

    try {
      const result = player.play();
      Promise.resolve(result).catch((error) => safeReject(error));
    } catch (error) {
      safeReject(error);
    }
  });
}
