function parseBooleanEnv(name, defaultValue) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return defaultValue;
}

module.exports = function (api) {
  if (api && typeof api.cache === 'function') {
    if (typeof api.cache.using === 'function') {
      api.cache.using(() => String(process.env.HAPPIER_UI_WORKLETS_BUNDLE_MODE ?? ''));
    } else {
      api.cache(true);
    }
  }

  // Determine which worklets plugin to use based on installed versions
  // Reanimated v4+ uses react-native-worklets/plugin
  // Reanimated v3.x uses react-native-reanimated/plugin
  let workletsPlugin = 'react-native-worklets/plugin';
  try {
    const reanimatedVersion = require('react-native-reanimated/package.json').version;
    const majorVersion = parseInt(reanimatedVersion.split('.')[0], 10);

    // For Reanimated v3.x, use the old plugin
    if (majorVersion < 4) {
      workletsPlugin = 'react-native-reanimated/plugin';
    }
  } catch (e) {
    // If reanimated isn't installed, default to newer plugin
    // This won't cause issues since the plugin won't be needed anyway
  }

  const workletsBundleMode = parseBooleanEnv('HAPPIER_UI_WORKLETS_BUNDLE_MODE', false);
  const workletsPluginConfig = workletsPlugin === 'react-native-worklets/plugin'
    ? [
      workletsPlugin,
      {
        bundleMode: workletsBundleMode,
        ...(workletsBundleMode ? { strictGlobal: true } : {}),
        workletizableModules: ['remend'],
      },
    ]
    : workletsPlugin;

  return {
    presets: ['babel-preset-expo'],
    env: {
      production: {
        plugins: ["transform-remove-console"],
      },
    },
    plugins: [
      [
        'module-resolver',
        {
          cwd: 'babelrc',
          alias: {
            '@': './sources',
          },
        },
      ],
      [
        'react-native-unistyles/plugin',
        {
          root: 'sources',
          // Unistyles only rewrites `react-native` host imports in files under
          // `root`. Shared Happier UI primitives (Text, Pressable, StatusDot,
          // Spinner, InfoState) now live in `@happier-dev/plugin-ui` and are
          // rendered INSIDE the core app tree by the adapters in
          // `sources/components/ui/**`, which style them with Unistyles
          // entries. Without this path those files keep the raw react-native
          // components, which silently drop every `unistyles_*` style — the
          // whole app's text typography collapses to react-native-web's
          // 14px/400 default. Forward slashes are correct on every platform:
          // the plugin maps them to the host separator (`toPlatformPath`).
          autoProcessPaths: ['packages/plugin-ui/src'],
        },
      ],
      workletsPluginConfig // Must be last - automatically selects correct plugin for version
    ],
  };
};
