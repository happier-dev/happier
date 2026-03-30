import { buildStackTauriDevConfig } from './dev_runtime.mjs';

export function createStackTauriDevConfig({
  baseConfig = {},
  env = process.env,
  devUrl = 'http://localhost:8081',
  enableDevtools = false,
} = {}) {
  const config = buildStackTauriDevConfig({
    baseConfig,
    overlayConfig: {},
    devUrl,
    env,
  });

  config.build.beforeDevCommand = '';
  config.build.beforeBuildCommand = '';

  if (config.bundle && typeof config.bundle === 'object') {
    config.bundle = {
      ...config.bundle,
      createUpdaterArtifacts: false,
    };
  }

  if (config.app?.windows?.length) {
    config.app.windows = config.app.windows.map((windowConfig) => ({
      ...windowConfig,
      ...(enableDevtools ? { devtools: true } : {}),
    }));
  }

  return config;
}
