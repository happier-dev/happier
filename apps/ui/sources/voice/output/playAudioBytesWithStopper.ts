import { Platform } from 'react-native';

import type {
  VoicePlaybackStopperRegistrar,
  VoicePlaybackTarget,
} from '@/voice/runtime/playback/VoicePlaybackController';
import { getOrCreateWebAudioContext } from '@/voice/output/webAudioContext';
import { beginVoiceQaOutputTap, type VoiceQaOutputTapHandle } from '@/voice/qa/voiceQaOutputTap';
import {
  voiceRuntimeLevelStore,
  type VoiceRuntimeLevelWriter,
} from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { acquireVoicePlaybackAudioMode } from '@/voice/runtime/voiceAudioMode';

let webPlaybackMeterSequence = 0;

const OUTPUT_METER_WINDOW_SECONDS = 0.1;
const MAX_METER_SAMPLES_PER_CHANNEL = 1_024;

function computeAudioBufferWindowRms(buffer: AudioBuffer, playbackSeconds: number): number {
  if (typeof buffer.getChannelData !== 'function' || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels <= 0) {
    return 0;
  }
  let squared = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    const sampleRate = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0
      ? buffer.sampleRate
      : samples.length / Math.max(buffer.duration, OUTPUT_METER_WINDOW_SECONDS);
    const start = Math.max(0, Math.min(samples.length, Math.floor(playbackSeconds * sampleRate)));
    const end = Math.max(start, Math.min(samples.length, Math.ceil((playbackSeconds + OUTPUT_METER_WINDOW_SECONDS) * sampleRate)));
    const stride = Math.max(1, Math.ceil((end - start) / MAX_METER_SAMPLES_PER_CHANNEL));
    for (let index = start; index < end; index += stride) {
      const sample = samples[index] ?? 0;
      squared += sample * sample;
      count += 1;
    }
  }
  return count > 0 ? Math.max(0, Math.min(1, Math.sqrt(squared / count))) : 0;
}

const NOOP_QA_OUTPUT_TAP: VoiceQaOutputTapHandle = Object.freeze({
  markPlaying: () => {},
  markCompleted: () => {},
  markCancelled: () => {},
  markFailed: () => {},
});

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
        let decodedBuffer: AudioBuffer | null = null;
        let playbackOffsetSeconds = 0;
        let sourceStartedAtSeconds = 0;
        let candidatePaused = false;
        let qaOutputTap = NOOP_QA_OUTPUT_TAP;
        let outputLevelWriter: VoiceRuntimeLevelWriter | null = null;
        let outputLevelTimer: ReturnType<typeof setInterval> | null = null;

        const stopOutputMeter = (close: boolean): void => {
          if (outputLevelTimer !== null) clearInterval(outputLevelTimer);
          outputLevelTimer = null;
          if (close) {
            outputLevelWriter?.close();
            outputLevelWriter = null;
          } else {
            outputLevelWriter?.reset();
          }
        };

        const startOutputMeter = (): void => {
          outputLevelWriter ??= voiceRuntimeLevelStore.open({
            channel: 'output',
            sourceId: `local-web-audio:${++webPlaybackMeterSequence}`,
          });
          if (outputLevelTimer !== null) clearInterval(outputLevelTimer);
          const publishCurrentWindow = (): void => {
            const audioBuffer = decodedBuffer;
            if (!audioBuffer || settled || candidatePaused || !source) return;
            const playbackSeconds = Math.max(0, (Number(ctx.currentTime) || 0) - sourceStartedAtSeconds);
            outputLevelWriter?.write(computeAudioBufferWindowRms(audioBuffer, playbackSeconds));
          };
          publishCurrentWindow();
          outputLevelTimer = setInterval(() => {
            publishCurrentWindow();
          }, 100);
        };

        const safeResolve = () => {
          if (settled) return;
          settled = true;
          stopOutputMeter(true);
          clearStopper();
          resolve();
        };
        const safeReject = (error: unknown) => {
          if (settled) return;
          settled = true;
          stopOutputMeter(true);
          clearStopper();
          reject(error);
        };

        const detachSource = (stop: boolean) => {
          const s = source;
          source = null;
          if (s) s.onended = null;
          if (stop) {
            try { s?.stop?.(); } catch {}
          }
          try {
            s?.disconnect?.();
          } catch {
            // ignore
          }
        };

        const startDecodedSource = (offsetSeconds: number): void => {
          const audioBuffer = decodedBuffer;
          if (!audioBuffer || settled || candidatePaused) return;
          const s = ctx.createBufferSource();
          source = s;
          s.buffer = audioBuffer;
          if (typeof s.connect === 'function') s.connect(ctx.destination);
          sourceStartedAtSeconds = (Number(ctx.currentTime) || 0) - offsetSeconds;
          s.onended = () => {
            if (source !== s || candidatePaused) return;
            qaOutputTap.markCompleted();
            detachSource(false);
            safeResolve();
          };
          s.start(0, offsetSeconds);
          qaOutputTap.markPlaying();
          startOutputMeter();
          notifyPlaybackStarted();
        };

        const target: VoicePlaybackTarget = {
          stop: () => {
            qaOutputTap.markCancelled();
            candidatePaused = false;
            decodedBuffer = null;
            detachSource(true);
            safeResolve();
          },
          beginCandidate: () => {
            if (settled) return 'unsupported';
            candidatePaused = true;
            stopOutputMeter(false);
            if (decodedBuffer && source) {
              const elapsed = Math.max(0, (Number(ctx.currentTime) || 0) - sourceStartedAtSeconds);
              playbackOffsetSeconds = Math.min(decodedBuffer.duration, elapsed);
              detachSource(true);
            }
            return 'retained';
          },
          resolveCandidate: (resolution) => {
            if (!candidatePaused) return;
            candidatePaused = false;
            if (resolution === 'false_alarm') {
              startDecodedSource(playbackOffsetSeconds);
            } else {
              decodedBuffer = null;
            }
          },
        };

        clearStopper = opts.registerPlaybackStopper.registerTarget?.(target)
          ?? opts.registerPlaybackStopper(target.stop);
        if (settled) {
          clearStopper();
          return;
        }

        (async () => {
          try {
            if (typeof ctx.resume === 'function') {
              await ctx.resume();
            }
            if (settled) return;

            // WebAudio is allowed to detach the buffer passed to
            // decodeAudioData(). Observe the stable caller-owned bytes first,
            // then decode a disposable copy so QA evidence cannot collapse to
            // an empty detached artifact.
            qaOutputTap = beginVoiceQaOutputTap({ bytes: opts.bytes, format: opts.format });
            const decodeBytes = opts.bytes.slice(0);
            const decoded = await ctx.decodeAudioData(decodeBytes);
            if (settled) return;
            decodedBuffer = decoded;
            playbackOffsetSeconds = 0;
            startDecodedSource(0);
          } catch (error) {
            if (settled) return;
            qaOutputTap.markFailed('audio_playback_failed');
            detachSource(true);
            safeReject(error);
          }
        })();
      });
    }

    const blob = new Blob([opts.bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    let audio: HTMLAudioElement | null = null;
    let cleanupComplete = false;
    const cleanup = () => {
      if (cleanupComplete) return;
      cleanupComplete = true;
      try {
        audio?.pause();
      } catch {
        // ignore
      }
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    };
    try {
      audio = new Audio(url);
    } catch (error) {
      cleanup();
      throw error;
    }
    const playbackAudio = audio;
    if (!playbackAudio) {
      cleanup();
      throw new Error('audio_playback_initialization_failed');
    }

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      let clearStopper = () => {};
      const qaOutputTap = beginVoiceQaOutputTap({ bytes: opts.bytes, format: opts.format });
      const safeResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        clearStopper();
        resolve();
      };
      const safeReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearStopper();
        reject(error);
      };

      const stopPlayback = () => {
        qaOutputTap.markCancelled();
        cleanup();
        safeResolve();
      };
      const target: VoicePlaybackTarget = {
        stop: stopPlayback,
        beginCandidate: () => {
          if (settled) return 'unsupported';
          try { playbackAudio.pause(); } catch {}
          return 'retained';
        },
        resolveCandidate: (resolution) => {
          if (settled || resolution !== 'false_alarm') return;
          try { void Promise.resolve(playbackAudio.play()).catch(() => safeReject(new Error('audio_playback_resume_failed'))); } catch (error) { safeReject(error); }
        },
      };
      clearStopper = opts.registerPlaybackStopper.registerTarget?.(target)
        ?? opts.registerPlaybackStopper(stopPlayback);
      if (settled) {
        clearStopper();
        return;
      }

      playbackAudio.onended = () => {
        if (settled) return;
        qaOutputTap.markCompleted();
        cleanup();
        safeResolve();
      };
      playbackAudio.onerror = () => {
        if (settled) return;
        qaOutputTap.markFailed('audio_playback_failed');
        cleanup();
        safeReject(new Error('audio_playback_failed'));
      };

      try {
        const result = playbackAudio.play();
        Promise.resolve(result)
          .then(() => {
            if (settled) return;
            qaOutputTap.markPlaying();
            notifyPlaybackStarted();
          })
          .catch((error) => {
            if (settled) return;
            qaOutputTap.markFailed('audio_playback_failed');
            cleanup();
            safeReject(error);
          });
      } catch (error) {
        qaOutputTap.markFailed('audio_playback_failed');
        cleanup();
        safeReject(error);
      }
    });
  }

  const { createAudioPlayer } = await import('expo-audio');
  const playbackLease = await acquireVoicePlaybackAudioMode('audio-bytes');
  try {
    const ext = opts.format === 'wav' ? '.wav' : '.mp3';
    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.cache, `happier-voice-${Date.now()}${ext}`);
    let player: ReturnType<typeof createAudioPlayer> | null = null;
    let subscription: { remove(): void } | null = null;
    let cleanupPromise: Promise<void> | null = null;
    const runCleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        try {
          subscription?.remove();
        } catch {
          // ignore
        }
        subscription = null;
        try {
          player?.remove();
        } catch {
          // ignore
        }
        try {
          await file.delete();
        } catch {
          // ignore
        }
      })();
      return cleanupPromise;
    };

    try {
      await file.write(new Uint8Array(opts.bytes));
      // The native coordinator owns the AVAudioSession lease. Expo's default
      // player deactivates that session after playback finishes, so its iOS
      // player must remain only a lease consumer until the coordinator releases.
      player = createAudioPlayer(
        file.uri,
        Platform.OS === 'ios' ? { keepAudioSessionActive: true } : undefined,
      );
      const playbackPlayer = player;
      const qaOutputTap = beginVoiceQaOutputTap({ bytes: opts.bytes, format: opts.format });

      return await new Promise<void>((resolve, reject) => {
        let settled = false;
        let clearStopper = () => {};
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
          qaOutputTap.markCancelled();
          safeResolve();
        };
        const target: VoicePlaybackTarget = {
          stop: stopPlayback,
          beginCandidate: () => {
            if (settled || typeof (playbackPlayer as { pause?: unknown }).pause !== 'function') return 'unsupported';
            try { (playbackPlayer as { pause: () => void }).pause(); } catch { return 'unsupported'; }
            return 'retained';
          },
          resolveCandidate: (resolution) => {
            if (settled || resolution !== 'false_alarm') return;
            try {
              const resumed = playbackPlayer.play();
              void Promise.resolve(resumed).catch((error) => safeReject(error));
            } catch (error) {
              safeReject(error);
            }
          },
        };
        clearStopper = opts.registerPlaybackStopper.registerTarget?.(target)
          ?? opts.registerPlaybackStopper(stopPlayback);
        if (settled) {
          clearStopper();
          return;
        }

        subscription = playbackPlayer.addListener('playbackStatusUpdate', (status: any) => {
          if (settled) return;
          // Settle on a post-play() failure surfaced via status (corrupt bytes,
          // decode error, failed load) instead of leaving the promise unsettled.
          // Because the streaming chunk queue is serial, a hung chunk would block
          // every subsequent chunk until an interrupt (audit Finding 4).
          const failed =
            status?.error != null
            || status?.reasonForWaitingToPlay === 'error';
          if (failed) {
            qaOutputTap.markFailed('audio_playback_failed');
            safeReject(new Error('audio_playback_failed'));
            return;
          }
          if (nativeStatusShowsPlaybackStarted(status)) {
            qaOutputTap.markPlaying();
            notifyPlaybackStarted();
          }
          if (!status?.didJustFinish) return;
          qaOutputTap.markCompleted();
          safeResolve();
        });

        try {
          const result = playbackPlayer.play();
          Promise.resolve(result).catch((error) => {
            if (settled) return;
            qaOutputTap.markFailed('audio_playback_failed');
            safeReject(error);
          });
        } catch (error) {
          qaOutputTap.markFailed('audio_playback_failed');
          safeReject(error);
        }
      });
    } catch (error) {
      void runCleanup().catch(() => {});
      throw error;
    }
  } finally {
    await playbackLease.release();
  }
}
