const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const REPACK_ANDROID_DEPENDENCY_LINE = "    implementation project(':callstack-repack')";
const REPACK_ANDROID_SETTINGS_BLOCK = [
  "include ':callstack-repack'",
  "project(':callstack-repack').projectDir = new File(",
  '  providers.exec {',
  '    workingDir(rootDir)',
  '    commandLine("node", "--print", "require(\'path\').join(require(\'path\').dirname(require.resolve(\'@callstack/repack/package.json\')), \'android\')")',
  '  }.standardOutput.asText.get().trim()',
  ')',
].join('\n');
const REPACK_ANDROID_PROJECT_INCLUDE_PATTERN = /^\s*include\s+['"]:callstack[-_]repack['"]\s*$/u;
const REPACK_ANDROID_PROJECT_DIR_PATTERN = /^\s*project\(\s*['"]:callstack[-_]repack['"]\s*\)\.projectDir\s*=/u;
const REPACK_ANDROID_PROJECT_DEPENDENCY_PATTERN = /^\s*implementation\s+project\(\s*['"]:callstack[-_]repack['"]\s*\)\s*$/u;

function splitLinesPreservingTrailingNewline(source) {
  return {
    lines: source.replace(/\n$/u, '').split('\n'),
    trailing: source.endsWith('\n') ? '\n' : '',
  };
}

function insertAfterLine(source, predicate, insertion) {
  const { lines, trailing } = splitLinesPreservingTrailingNewline(source);
  const index = lines.findIndex(predicate);
  if (index === -1) {
    return `${source}${source.endsWith('\n') || source.length === 0 ? '' : '\n'}${insertion}\n`;
  }
  lines.splice(index + 1, 0, insertion);
  return `${lines.join('\n')}${trailing}`;
}

function applyRepackPodToPodfile(podfile) {
  return podfile
    .split('\n')
    .filter((line) => !/^\s*pod\s+['"]callstack-repack['"]/u.test(line))
    .join('\n');
}

function settingsGradleUsesAndroidAutolinking(settingsGradle) {
  return /\bautolinkLibrariesFromCommand\s*\(/u.test(settingsGradle);
}

function appBuildGradleUsesAndroidAutolinking(appBuildGradle) {
  return /\bautolinkLibrariesWithApp\s*\(/u.test(appBuildGradle);
}

function stripRepackAndroidSettingsGradleBlock(settingsGradle) {
  const { lines, trailing } = splitLinesPreservingTrailingNewline(settingsGradle);
  const filtered = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (REPACK_ANDROID_PROJECT_INCLUDE_PATTERN.test(line)) {
      continue;
    }
    if (REPACK_ANDROID_PROJECT_DIR_PATTERN.test(line)) {
      if (/new\s+File\s*\(\s*$/u.test(line)) {
        while (index + 1 < lines.length) {
          index += 1;
          if (/^\s*\)\s*$/u.test(lines[index])) {
            break;
          }
        }
      }
      continue;
    }
    filtered.push(line);
  }

  return `${filtered.join('\n')}${trailing}`;
}

function stripRepackAndroidAppDependency(appBuildGradle) {
  const { lines, trailing } = splitLinesPreservingTrailingNewline(appBuildGradle);
  return `${lines.filter((line) => !REPACK_ANDROID_PROJECT_DEPENDENCY_PATTERN.test(line)).join('\n')}${trailing}`;
}

function applyRepackAndroidSettingsGradle(settingsGradle) {
  const withoutDirectRepack = stripRepackAndroidSettingsGradleBlock(settingsGradle);
  if (settingsGradleUsesAndroidAutolinking(settingsGradle)) {
    return withoutDirectRepack;
  }
  return insertAfterLine(
    withoutDirectRepack,
    (line) => /^\s*include\s+['"]:app['"]\s*$/u.test(line),
    REPACK_ANDROID_SETTINGS_BLOCK,
  );
}

function applyRepackAndroidAppBuildGradle(appBuildGradle) {
  const withoutDirectRepack = stripRepackAndroidAppDependency(appBuildGradle);
  if (appBuildGradleUsesAndroidAutolinking(appBuildGradle)) {
    return withoutDirectRepack;
  }
  return insertAfterLine(
    withoutDirectRepack,
    (line) => /implementation\(["']com\.facebook\.react:react-android["']\)/u.test(line),
    REPACK_ANDROID_DEPENDENCY_LINE,
  );
}

async function rewriteFile(filePath, transform) {
  const before = await fs.readFile(filePath, 'utf8');
  const after = transform(before);
  if (after !== before) {
    await fs.writeFile(filePath, after, 'utf8');
  }
}

const withReactNativeRepackRuntime = (config) => {
  config = withDangerousMod(config, ['ios', async (modConfig) => {
    await rewriteFile(
      path.join(modConfig.modRequest.platformProjectRoot, 'Podfile'),
      applyRepackPodToPodfile,
    );
    return modConfig;
  }]);

  config = withDangerousMod(config, ['android', async (modConfig) => {
    await Promise.all([
      rewriteFile(
        path.join(modConfig.modRequest.platformProjectRoot, 'settings.gradle'),
        applyRepackAndroidSettingsGradle,
      ),
      rewriteFile(
        path.join(modConfig.modRequest.platformProjectRoot, 'app', 'build.gradle'),
        applyRepackAndroidAppBuildGradle,
      ),
    ]);
    return modConfig;
  }]);

  return config;
};

withReactNativeRepackRuntime.applyRepackPodToPodfile = applyRepackPodToPodfile;
withReactNativeRepackRuntime.applyRepackAndroidSettingsGradle = applyRepackAndroidSettingsGradle;
withReactNativeRepackRuntime.applyRepackAndroidAppBuildGradle = applyRepackAndroidAppBuildGradle;

module.exports = withReactNativeRepackRuntime;
