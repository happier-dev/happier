// Web bundle stub for kokoro-js. The real package pulls in ESM code paths that rely on
// `import.meta`, which Metro's current web export output executes as a classic script.
// This keeps the app bundle runnable on web; Kokoro local TTS is treated as unsupported.

export const env: Record<string, unknown> = {};

export const TextSplitterStream: undefined = undefined;

export const KokoroTTS: undefined = undefined;

export default {
  env,
  TextSplitterStream,
  KokoroTTS,
};

