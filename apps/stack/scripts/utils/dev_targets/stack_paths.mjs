// Remote managed Stack state and validation caches share the explicit target
// home selected by both dispatchers. Keep its state location source-only so
// stage-zero dependency admission does not need the compiled command owner.
export function resolveRemoteStackStorageDir(targetHomeDir) {
  return `${String(targetHomeDir).replace(/[\\/]+$/, '')}/stack-state`;
}
