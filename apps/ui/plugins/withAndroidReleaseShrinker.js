const { withGradleProperties } = require('@expo/config-plugins');

function upsertGradleProperty(props, key, value) {
  if (!Array.isArray(props)) {
    throw new Error('Expected gradle.properties modResults to be an array');
  }

  const existing = props.find((p) => p && p.type === 'property' && p.key === key);
  if (existing) {
    existing.value = value;
    return props;
  }

  props.push({ type: 'property', key, value });
  return props;
}

function applyAndroidReleaseShrinkerSettingsToGradleProperties(
  props,
  {
    enableMinifyInReleaseBuilds,
    enableProguardInReleaseBuilds,
    enableShrinkResourcesInReleaseBuilds,
    gradleJvmArgs,
  } = {}
) {
  // Expo/RN templates use android.enableMinifyInReleaseBuilds to control `minifyEnabled`.
  // Keep a small compatibility alias for the old "proguard" naming.
  const minifyEnabled = enableMinifyInReleaseBuilds === true || enableProguardInReleaseBuilds === true;
  const shrinkEnabled = enableShrinkResourcesInReleaseBuilds === true;

  if (shrinkEnabled && !minifyEnabled) {
    // Android requires code shrinking (R8/Proguard) to be enabled when shrinking resources.
    throw new Error(
      '`enableShrinkResourcesInReleaseBuilds` requires `enableMinifyInReleaseBuilds` to be enabled.'
    );
  }

  if (minifyEnabled) {
    upsertGradleProperty(props, 'android.enableMinifyInReleaseBuilds', 'true');
  }
  if (shrinkEnabled) {
    upsertGradleProperty(props, 'android.enableShrinkResourcesInReleaseBuilds', 'true');
  }
  if (typeof gradleJvmArgs === 'string' && gradleJvmArgs.trim()) {
    // R8 can be memory hungry; allow release build profiles to raise the heap.
    upsertGradleProperty(props, 'org.gradle.jvmargs', gradleJvmArgs.trim());
  }

  return props;
}

/**
 * Configure Android release build shrinker settings (R8 + resource shrinking) via `android/gradle.properties`.
 *
 * We do this with a local plugin instead of relying on third-party config plugins because
 * the build-time contract is "if shrinkResources is enabled, minify must also be enabled".
 */
const withAndroidReleaseShrinker = (config, props = {}) => {
  return withGradleProperties(config, (propsConfig) => {
    applyAndroidReleaseShrinkerSettingsToGradleProperties(propsConfig.modResults, props);
    return propsConfig;
  });
};

withAndroidReleaseShrinker.applyAndroidReleaseShrinkerSettingsToGradleProperties =
  applyAndroidReleaseShrinkerSettingsToGradleProperties;

withAndroidReleaseShrinker.upsertGradleProperty = upsertGradleProperty;

module.exports = withAndroidReleaseShrinker;
