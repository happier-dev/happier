export function resolveServerUiEnv({ serveUi, uiBuildDir, uiPrefix, uiBuildDirExists }) {
  if (!serveUi) return {};
  if (!uiBuildDirExists) return {};
  if (!uiBuildDir) return {};

  // Set both the canonical env vars (new) and legacy keys (for older server builds).
  return {
    HAPPY_SERVER_UI_DIR: uiBuildDir,
    HAPPY_SERVER_UI_PREFIX: uiPrefix,
    HAPPY_SERVER_LIGHT_UI_DIR: uiBuildDir,
    HAPPY_SERVER_LIGHT_UI_PREFIX: uiPrefix,
  };
}

