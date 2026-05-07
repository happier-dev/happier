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
      api.cache.using(() => [
        parseBooleanEnv('HAPPIER_UI_WORKLETS_BUNDLE_MODE', false) ? '1' : '0',
        parseBooleanEnv('HAPPIER_UI_KEEP_CONSOLE_IN_RELEASE', false) ? '1' : '0',
      ].join('|'));
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
  const keepConsoleInRelease = parseBooleanEnv('HAPPIER_UI_KEEP_CONSOLE_IN_RELEASE', false);
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
        plugins: keepConsoleInRelease ? [] : ["transform-remove-console"],
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
      ['react-native-unistyles/plugin', { root: 'sources' }],
      workletsPluginConfig // Must be last - automatically selects correct plugin for version
    ],
  };
};
