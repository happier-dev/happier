import { readFile } from 'node:fs/promises';

// `ios.buildReactNativeFromSource` and `ios.deploymentTarget` are owned by the Expo
// config (`apps/ui/app.config.js`, expo-build-properties), so that EVERY prebuild path
// produces them — `yarn prebuild`, `expo run:ios`, this command, and EAS. This step used
// to write them as well, which made the hstack path look healthy while a plain
// `expo prebuild` produced a project that linked prebuilt React Native core and silently
// dropped the native patches under `apps/ui/patches/`. Verify here instead of competing.
//
// (`ios.deploymentTarget` is 16.4 in the Expo config because expo autolinking silently
// drops the expo-glass-effect pod below that target, which then fails at runtime with
// "Cannot find native module 'ExpoGlassEffect'".)
const APP_CONFIG_OWNED_PROPERTIES = ['ios.buildReactNativeFromSource', 'ios.deploymentTarget'];

export async function verifyIosPodfilePropertiesForMobileBuild({ uiDir }) {
  const podPropsPath = `${uiDir}/ios/Podfile.properties.json`;
  let raw;
  try {
    raw = await readFile(podPropsPath, 'utf-8');
  } catch {
    // Not generated (e.g. a non-iOS platform build).
    return false;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return false;
  }

  const missing = APP_CONFIG_OWNED_PROPERTIES.filter((key) => !json[key]);
  if (json['ios.buildReactNativeFromSource'] && json['ios.buildReactNativeFromSource'] !== 'true') {
    missing.push('ios.buildReactNativeFromSource');
  }
  if (missing.length > 0) {
    throw new Error(
      `${podPropsPath} is missing ${missing.join(', ')}.\n`
      + 'These are owned by the expo-build-properties plugin in apps/ui/app.config.js and must be\n'
      + 'declared there, not patched in afterwards. Without ios.buildReactNativeFromSource the build\n'
      + 'links prebuilt React Native core and every native patch under apps/ui/patches/ is discarded\n'
      + 'at compile time.',
    );
  }

  return true;
}
