export const WORKSPACE_BUNDLE_PUBLICATION_MODES = Object.freeze({
  LIVE: 'live',
  ARTIFACT: 'artifact',
});

export function resolveWorkspaceBundlePublicationMode({ mode = '', argv = [], env = {} } = {}) {
  const explicitMode = String(mode ?? '').trim();
  if (explicitMode) {
    if (explicitMode === WORKSPACE_BUNDLE_PUBLICATION_MODES.LIVE) return explicitMode;
    if (explicitMode === WORKSPACE_BUNDLE_PUBLICATION_MODES.ARTIFACT) return explicitMode;
    throw new Error(`Unknown workspace bundle publication mode: ${explicitMode}`);
  }

  if (argv.some((value) => String(value).trim() === '--artifact')) {
    return WORKSPACE_BUNDLE_PUBLICATION_MODES.ARTIFACT;
  }
  if (String(env?.npm_lifecycle_event ?? '').trim() === 'prepack') {
    return WORKSPACE_BUNDLE_PUBLICATION_MODES.ARTIFACT;
  }
  return WORKSPACE_BUNDLE_PUBLICATION_MODES.LIVE;
}
