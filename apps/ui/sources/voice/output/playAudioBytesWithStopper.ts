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
            // Stopped while resuming/decoding: the stopper already resolved; never start audio.
            if (settled) return;
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
    if (settled) {
      clearStopper();
      return;
    }

    const progress: NativePlaybackProgress = { loaded: false, playing: false };
    subscription = player.addListener('playbackStatusUpdate', (status: unknown) => {
      const outcome = classifyNativePlaybackStatus(status, progress);
      if (outcome === 'finished' || outcome === 'interrupted') safeResolve();
      if (outcome === 'failed') safeReject(new Error('audio_playback_failed'));
    });

    try {
      const result = player.play();
      Promise.resolve(result).catch((error) => safeReject(error));
    } catch (error) {
      safeReject(error);
    }
  });
}

type NativePlaybackStatusOutcome = 'pending' | 'finished' | 'interrupted' | 'failed';

type NativePlaybackProgress = { loaded: boolean; playing: boolean };

/** Fields of expo-audio's `AudioStatus` this owner reads; updates may omit any of them. */
type NativePlaybackStatus = Partial<{
  didJustFinish: boolean;
  playbackState: string;
  playing: boolean;
  isBuffering: boolean;
}>;

function readNativePlaybackStatus(status: unknown): NativePlaybackStatus {
  if (!status || typeof status !== 'object') return {};
  const record = status as Record<string, unknown>;
  return {
    didJustFinish: record.didJustFinish === true,
    playbackState: typeof record.playbackState === 'string' ? record.playbackState : undefined,
    playing: typeof record.playing === 'boolean' ? record.playing : undefined,
    isBuffering: record.isBuffering === true,
  };
}

/**
 * Maps an expo-audio status update to a playback outcome, recording progress in `progress`.
 * Besides `didJustFinish`, the player can fail (iOS item `failed`; Android drops back to `idle`
 * after a player error) or be paused by the system (Android permanent audio-focus loss, iOS
 * interruption without resume); no finish event arrives in those cases. A pause after playback
 * started ends this speech segment.
 */
function classifyNativePlaybackStatus(raw: unknown, progress: NativePlaybackProgress): NativePlaybackStatusOutcome {
  const status = readNativePlaybackStatus(raw);
  if (status.didJustFinish) return 'finished';
  const state = status.playbackState;
  if (state === 'failed') return 'failed';
  if (state === 'idle' && progress.loaded) return 'failed';
  if (state === 'ready' || state === 'readyToPlay' || state === 'buffering') progress.loaded = true;

  if (status.playing === true) {
    progress.playing = true;
    return 'pending';
  }
  if (progress.playing && status.playing === false && !status.isBuffering) return 'interrupted';
  return 'pending';
}
