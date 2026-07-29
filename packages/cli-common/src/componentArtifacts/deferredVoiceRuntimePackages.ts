export const CLI_DEFERRED_VOICE_RUNTIME_PACKAGES = Object.freeze([
  '@huggingface/transformers',
  'ffmpeg-static',
  'sherpa-onnx-node',
] as const);

export const CLI_DEFERRED_VOICE_RUNTIME_ARCHIVE_ROOTS = Object.freeze(
  CLI_DEFERRED_VOICE_RUNTIME_PACKAGES.map(
    (packageName) => `node_modules/${packageName}`,
  ),
);
