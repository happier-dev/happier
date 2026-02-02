export function resolveServerUiEnv({ serveUi, uiBuildDir, uiPrefix, uiBuildDirExists }) {
  if (!serveUi) return {};
  if (!uiBuildDirExists) return {};
  if (!uiBuildDir) return {};

  // Set both full and light UI env vars (full/light share UI config resolution).
  return {
    HAPPIER_SERVER_UI_DIR: uiBuildDir,
    HAPPIER_SERVER_UI_PREFIX: uiPrefix,
    HAPPIER_SERVER_LIGHT_UI_DIR: uiBuildDir,
    HAPPIER_SERVER_LIGHT_UI_PREFIX: uiPrefix,
  };
}
