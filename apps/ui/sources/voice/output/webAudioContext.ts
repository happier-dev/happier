import { Platform } from 'react-native';

let cachedWebAudioContext: any | null = null;

function getWebAudioContextCtor(): any | null {
  return (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext ?? null;
}

export function getOrCreateWebAudioContext(): any | null {
  if (Platform.OS !== 'web') return null;
  const Ctor = getWebAudioContextCtor();
  if (typeof Ctor !== 'function') return null;
  if (cachedWebAudioContext) return cachedWebAudioContext;
  try {
    cachedWebAudioContext = new Ctor();
  } catch {
    cachedWebAudioContext = null;
  }
  return cachedWebAudioContext;
}

// Call this from a direct user gesture (e.g. button press) before doing async work.
// This is important because browsers may block audio output unless a user gesture
// has "unlocked" audio playback.
export function primeWebAudioPlayback(): void {
  if (Platform.OS !== 'web') return;
  const ctx = getOrCreateWebAudioContext();
  if (!ctx) return;

  try {
    void ctx.resume?.();
  } catch {
    // ignore
  }

  // Best-effort: play a tiny silent buffer to prime the audio graph.
  try {
    const buffer = ctx.createBuffer?.(1, 1, 22050);
    const source = ctx.createBufferSource?.();
    if (!buffer || !source) return;
    source.buffer = buffer;
    source.connect?.(ctx.destination);
    source.start?.(0);
    source.disconnect?.();
  } catch {
    // ignore
  }
}

