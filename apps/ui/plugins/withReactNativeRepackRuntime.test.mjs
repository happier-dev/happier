import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  applyRepackAndroidAppBuildGradle,
  applyRepackAndroidSettingsGradle,
  applyRepackPodToPodfile,
} = require('./withReactNativeRepackRuntime.js');

test('applyRepackPodToPodfile removes stale explicit callstack-repack pods so autolinking owns iOS', () => {
  const podfile = [
    "target 'HappierPublicDevClient' do",
    '  config = use_native_modules!(config_command)',
    '  pod \'callstack-repack\', :path => File.dirname(`node --print "require.resolve(\'@callstack/repack/package.json\')"`)',
    '',
    '  use_react_native!(',
    '    :path => config[:reactNativePath],',
    '  )',
    'end',
  ].join('\n');

  const updated = applyRepackPodToPodfile(podfile);

  assert.doesNotMatch(updated, /pod 'callstack-repack'/);
  assert.equal(applyRepackPodToPodfile(updated), updated);
});

test('applyRepackAndroidSettingsGradle includes the Re.Pack native project once', () => {
  const settings = [
    "rootProject.name = 'Happier'",
    "include ':app'",
    'includeBuild(expoAutolinking.reactNativeGradlePlugin)',
  ].join('\n');

  const updated = applyRepackAndroidSettingsGradle(settings);

  assert.match(updated, /include ':callstack-repack'/);
  assert.match(updated, /require\.resolve\('@callstack\/repack\/package\.json'\)/);
  assert.equal(applyRepackAndroidSettingsGradle(updated), updated);
});

test('applyRepackAndroidSettingsGradle removes the direct project when Android autolinking owns Re.Pack', () => {
  const settings = [
    'extensions.configure(com.facebook.react.ReactSettingsExtension) { ex ->',
    '  ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)',
    '}',
    "include ':app'",
    "include ':callstack-repack'",
    "project(':callstack-repack').projectDir = new File(",
    '  providers.exec {',
    '    workingDir(rootDir)',
    '    commandLine("node", "--print", "require(\'path\').join(require(\'path\').dirname(require.resolve(\'@callstack/repack/package.json\')), \'android\')")',
    '  }.standardOutput.asText.get().trim()',
    ')',
  ].join('\n');

  const updated = applyRepackAndroidSettingsGradle(settings);

  assert.doesNotMatch(updated, /include ':callstack-repack'/);
  assert.doesNotMatch(updated, /project\(':callstack-repack'\)/);
  assert.match(updated, /autolinkLibrariesFromCommand/);
  assert.equal(applyRepackAndroidSettingsGradle(updated), updated);
});

test('applyRepackAndroidAppBuildGradle adds the app dependency once', () => {
  const buildGradle = [
    'dependencies {',
    '    implementation("com.facebook.react:react-android")',
    '}',
  ].join('\n');

  const updated = applyRepackAndroidAppBuildGradle(buildGradle);

  assert.match(updated, /implementation project\(':callstack-repack'\)/);
  assert.equal(applyRepackAndroidAppBuildGradle(updated), updated);
});

test('applyRepackAndroidAppBuildGradle removes the direct dependency when Android autolinking owns Re.Pack', () => {
  const buildGradle = [
    'react {',
    '    autolinkLibrariesWithApp()',
    '}',
    '',
    'dependencies {',
    '    implementation("com.facebook.react:react-android")',
    "    implementation project(':callstack-repack')",
    '}',
  ].join('\n');

  const updated = applyRepackAndroidAppBuildGradle(buildGradle);

  assert.doesNotMatch(updated, /implementation project\(':callstack-repack'\)/);
  assert.match(updated, /autolinkLibrariesWithApp/);
  assert.equal(applyRepackAndroidAppBuildGradle(updated), updated);
});
