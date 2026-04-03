const { withGradleProperties } = require('@expo/config-plugins');

function readCsvEnv(name) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function applyReactNativeArchitecturesToGradleProperties(props, archs) {
  if (!Array.isArray(props)) {
    throw new Error('Expected gradle.properties modResults to be an array');
  }
  if (!Array.isArray(archs) || archs.length === 0) {
    return props;
  }

  const key = 'reactNativeArchitectures';
  const value = archs.join(',');

  const existing = props.find((p) => p && p.type === 'property' && p.key === key);
  if (existing) {
    existing.value = value;
    return props;
  }

  props.push({ type: 'property', key, value });
  return props;
}

/**
 * Configure the ABIs that React Native builds into Android artifacts by setting the
 * Gradle project property `reactNativeArchitectures` in `android/gradle.properties`.
 *
 * This is primarily useful for direct-download APK distribution (GitHub artifacts),
 * where shipping a universal APK with x86/x86_64 + 32-bit ARM significantly inflates
 * the download size.
 */
const withAndroidReactNativeArchitectures = (config) => {
  return withGradleProperties(config, (propsConfig) => {
    const archs = readCsvEnv('HAPPIER_ANDROID_BUILD_ARCHS');
    if (archs.length === 0) {
      return propsConfig;
    }
    applyReactNativeArchitecturesToGradleProperties(propsConfig.modResults, archs);
    return propsConfig;
  });
};

withAndroidReactNativeArchitectures.applyReactNativeArchitecturesToGradleProperties =
  applyReactNativeArchitecturesToGradleProperties;

module.exports = withAndroidReactNativeArchitectures;
