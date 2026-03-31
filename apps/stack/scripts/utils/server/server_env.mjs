import { resolveServerUiEnv } from './ui_env.mjs';

export function buildServerRuntimeEnv({
  baseEnv,
  serverPort,
  publicServerUrl,
  serveUi = false,
  uiRequired = false,
  uiBuildDir = '',
  uiBuildDirExists = false,
  uiPrefix = '/',
}) {
  const nextEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    HAPPIER_PUBLIC_SERVER_URL: publicServerUrl,
    PUBLIC_URL: publicServerUrl,
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
  };

  if (serveUi) {
    nextEnv.HAPPIER_SERVER_UI_REQUIRED = uiRequired ? '1' : '0';
  }

  return {
    ...nextEnv,
    ...resolveServerUiEnv({
      serveUi,
      uiBuildDir,
      uiPrefix,
      uiBuildDirExists,
    }),
  };
}
