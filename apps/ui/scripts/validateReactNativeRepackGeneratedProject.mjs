import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPACK_PACKAGE_NAME = '@callstack/repack';
const REPACK_POD_NAME = 'callstack-repack';

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  return (await pathExists(filePath)) ? await readFile(filePath, 'utf8') : null;
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  return text ? JSON.parse(text) : null;
}

function includesRepackPod(text) {
  return typeof text === 'string' && new RegExp(`\\b${REPACK_POD_NAME}\\b`, 'i').test(text);
}

function includesDirectIosPodfileRepack(text) {
  return typeof text === 'string' && /^\s*pod\s+['"]callstack-repack['"]/mui.test(text);
}

function includesRepackPackage(value) {
  if (typeof value === 'string') {
    return value.includes(REPACK_PACKAGE_NAME) || value.includes(REPACK_POD_NAME);
  }
  if (Array.isArray(value)) {
    return value.some(includesRepackPackage);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => includesRepackPackage(key) || includesRepackPackage(entry));
  }
  return false;
}

function includesAndroidDirectGradleProject(settingsGradle) {
  if (typeof settingsGradle !== 'string') {
    return false;
  }
  const settingsHasRepackProjectPath = /@callstack\/repack\/android/i.test(settingsGradle)
    || /@callstack\/repack\/package\.json/i.test(settingsGradle);
  return /['"]:callstack[-_]repack['"]/i.test(settingsGradle) && settingsHasRepackProjectPath;
}

function includesAndroidDirectGradleDependency(appBuildGradle) {
  return typeof appBuildGradle === 'string'
    && /implementation\s+project\(\s*['"]:callstack[-_]repack['"]\s*\)/i.test(appBuildGradle);
}

async function assertRepackDependencyDeclared(packageRoot, errors) {
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = await readJsonIfExists(packageJsonPath);
  const declaredVersion = packageJson?.dependencies?.[REPACK_PACKAGE_NAME]
    ?? packageJson?.devDependencies?.[REPACK_PACKAGE_NAME]
    ?? packageJson?.optionalDependencies?.[REPACK_PACKAGE_NAME]
    ?? null;
  if (typeof declaredVersion !== 'string' || declaredVersion.trim().length === 0) {
    errors.push(`package.json must declare ${REPACK_PACKAGE_NAME} before generated native Re.Pack validation can pass.`);
  }
}

async function validateIos(packageRoot, errors) {
  const iosDir = join(packageRoot, 'ios');
  const podfilePath = join(iosDir, 'Podfile');
  const podLockPath = join(iosDir, 'Podfile.lock');
  const manifestLockPath = join(iosDir, 'Pods', 'Manifest.lock');

  const [podfile, podLock, manifestLock] = await Promise.all([
    readTextIfExists(podfilePath),
    readTextIfExists(podLockPath),
    readTextIfExists(manifestLockPath),
  ]);

  const result = {
    podfile: typeof podfile === 'string',
    podLock: includesRepackPod(podLock),
    manifestLock: includesRepackPod(manifestLock),
  };

  if (!podfile) {
    errors.push(`Generated iOS project is missing ${podfilePath}. Run the canonical prebuild/native generation command first.`);
  } else if (includesDirectIosPodfileRepack(podfile)) {
    errors.push(
      `Generated iOS Podfile must not declare ${REPACK_POD_NAME} directly; React Native autolinking must own iOS materialization.`,
    );
  }

  if (!podLock) {
    errors.push(`Generated iOS Podfile.lock is missing; run pod install through the canonical iOS/native build command.`);
  } else if (!result.podLock) {
    errors.push(`Generated iOS Podfile.lock must contain ${REPACK_POD_NAME}; native pods are not materialized.`);
  }

  if (!manifestLock) {
    errors.push(`Generated iOS Pods/Manifest.lock is missing; run pod install through the canonical iOS/native build command.`);
  } else if (!result.manifestLock) {
    errors.push(`Generated iOS Pods/Manifest.lock must contain ${REPACK_POD_NAME}; native pods are not materialized.`);
  }

  return result;
}

async function validateAndroid(packageRoot, errors) {
  const androidDir = join(packageRoot, 'android');
  const settingsGradlePath = join(androidDir, 'settings.gradle');
  const appBuildGradlePath = join(androidDir, 'app', 'build.gradle');
  const autolinkingJsonPath = join(androidDir, 'build', 'generated', 'autolinking', 'autolinking.json');

  const [settingsGradle, appBuildGradle, generatedAutolinking] = await Promise.all([
    readTextIfExists(settingsGradlePath),
    readTextIfExists(appBuildGradlePath),
    readJsonIfExists(autolinkingJsonPath),
  ]);

  const directGradleProject = includesAndroidDirectGradleProject(settingsGradle);
  const directGradleDependency = includesAndroidDirectGradleDependency(appBuildGradle);
  const sourceGradle = directGradleProject && directGradleDependency;
  const generatedAutolinkingHasRepack = includesRepackPackage(generatedAutolinking);
  if (!settingsGradle) {
    errors.push(`Generated Android project is missing ${settingsGradlePath}. Run the canonical prebuild/native generation command first.`);
  }
  if (!appBuildGradle) {
    errors.push(`Generated Android app build.gradle is missing at ${appBuildGradlePath}.`);
  }
  if (generatedAutolinkingHasRepack && (directGradleProject || directGradleDependency)) {
    errors.push(
      `Android generated project has duplicate ${REPACK_POD_NAME} native materialization; use generated React Native autolinking or the direct Gradle include/dependency, not both.`,
    );
  }
  if (!sourceGradle && !generatedAutolinkingHasRepack) {
    errors.push(
      `Android generated project must include ${REPACK_POD_NAME} via a direct Gradle project include/dependency or generated autolinking output.`,
    );
  }

  return {
    sourceGradle,
    generatedAutolinking: generatedAutolinkingHasRepack,
  };
}

export async function assertReactNativeRepackGeneratedProject({
  cwd,
} = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = cwd ?? dirname(scriptsDir);
  const errors = [];

  await assertRepackDependencyDeclared(packageRoot, errors);
  const [ios, android] = await Promise.all([
    validateIos(packageRoot, errors),
    validateAndroid(packageRoot, errors),
  ]);

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return { ios, android };
}

async function runCli() {
  try {
    const summary = await assertReactNativeRepackGeneratedProject();
    console.log(
      [
        'React Native Re.Pack generated native project validated.',
        `iosPodfile=${summary.ios.podfile ? 'ok' : 'missing'}`,
        `iosPodLock=${summary.ios.podLock ? 'ok' : 'missing'}`,
        `iosManifest=${summary.ios.manifestLock ? 'ok' : 'missing'}`,
        `androidSourceGradle=${summary.android.sourceGradle ? 'ok' : 'missing'}`,
        `androidAutolinking=${summary.android.generatedAutolinking ? 'ok' : 'not-used'}`,
      ].join(' '),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
