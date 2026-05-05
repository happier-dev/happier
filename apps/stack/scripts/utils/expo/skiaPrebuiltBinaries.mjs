import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathExists } from '../fs/fs.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { run } from '../proc/proc.mjs';

const DEFAULT_SKIA_RELEASE_BASE_URL = 'https://github.com/shopify/react-native-skia/releases/download';
const DEFAULT_ANDROID_ARCHITECTURES = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);

function uniqueDirs(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir) continue;
    const key = resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function findReactNativeSkiaPackageDir({ projectDir, runnerDir }) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(projectDir) ?? coerceHappyMonorepoRootFromPath(runnerDir);
  for (const root of uniqueDirs([projectDir, runnerDir, monorepoRoot])) {
    const packageDir = join(root, 'node_modules', '@shopify', 'react-native-skia');
    if (await pathExists(join(packageDir, 'package.json'))) {
      return packageDir;
    }
  }
  return null;
}

async function readSkiaPackageJson(packageDir) {
  return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8'));
}

function isTruthy(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveSkiaArtifactConfig(packageJson, env = process.env) {
  const graphite = isTruthy(env.SK_GRAPHITE);
  const field = graphite ? 'skia-graphite' : 'skia';
  const prefix = graphite ? 'skia-graphite' : 'skia';
  const version = packageJson?.[field]?.version ?? packageJson?.skiaVersion;
  if (!version) {
    throw new Error('@shopify/react-native-skia package.json is missing a Skia version');
  }
  return {
    graphite,
    prefix,
    releaseTag: `${prefix}-${version}`,
  };
}

function resolveSkiaReleaseBaseUrl(env = process.env) {
  const explicit = String(env.HAPPIER_STACK_SKIA_RELEASE_BASE_URL ?? '').trim();
  return explicit || DEFAULT_SKIA_RELEASE_BASE_URL;
}

function resolveSkiaDownloadRetryConfig(env = process.env) {
  const maxRetries = Number.parseInt(String(env.HAPPIER_STACK_SKIA_DOWNLOAD_MAX_RETRIES ?? '5'), 10);
  const retryDelayMs = Number.parseInt(String(env.HAPPIER_STACK_SKIA_DOWNLOAD_RETRY_DELAY_MS ?? '1000'), 10);
  return {
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 5,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 1000,
  };
}

function joinUrl(baseUrl, ...parts) {
  return [String(baseUrl ?? '').replace(/\/+$/u, ''), ...parts.map((part) => encodeURIComponent(part))].join('/');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isTransientDownloadError(error) {
  if (TRANSIENT_STATUS_CODES.has(Number(error?.statusCode))) return true;
  if (TRANSIENT_ERROR_CODES.has(String(error?.code ?? ''))) return true;
  return /rate limit|socket hang up|network/i.test(String(error?.message ?? ''));
}

async function downloadHttpsToFile(url, destinationPath) {
  await mkdir(dirname(destinationPath), { recursive: true });
  await new Promise((resolvePromise, rejectPromise) => {
    const request = (currentUrl) => {
      const req = https.get(currentUrl, { headers: { 'User-Agent': 'node' } }, (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          const nextUrl = res.headers.location;
          res.resume();
          if (!nextUrl) {
            rejectPromise(new Error(`Redirect without location for ${currentUrl}`));
            return;
          }
          request(nextUrl);
          return;
        }

        if (res.statusCode !== 200) {
          const error = new Error(`Failed to download: ${res.statusCode} ${res.statusMessage}`);
          error.statusCode = res.statusCode;
          res.resume();
          rejectPromise(error);
          return;
        }

        const file = createWriteStream(destinationPath);
        const cleanup = (error) => {
          file.destroy();
          rm(destinationPath, { force: true }).finally(() => rejectPromise(error));
        };
        res.on('error', cleanup);
        file.on('error', cleanup);
        file.on('finish', () => {
          file.close((error) => {
            if (error) {
              cleanup(error);
              return;
            }
            resolvePromise();
          });
        });
        res.pipe(file);
      });
      req.on('error', rejectPromise);
    };
    request(url);
  });
}

async function downloadToFile(url, destinationPath, { env = process.env, quiet = false } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol === 'file:') {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(fileURLToPath(parsed), destinationPath);
    return;
  }

  const { maxRetries, retryDelayMs } = resolveSkiaDownloadRetryConfig(env);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await downloadHttpsToFile(url, destinationPath);
      return;
    } catch (error) {
      if (attempt >= maxRetries || !isTransientDownloadError(error)) {
        throw error;
      }
      const delay = retryDelayMs * Math.pow(2, attempt);
      if (!quiet) {
        console.log(`[mobile] Skia download failed (${error.message}); retrying in ${delay}ms`);
      }
      await sleep(delay);
    }
  }
}

async function extractTarGz(archivePath, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  await run('tar', ['-xzf', archivePath, '-C', destinationDir], { stdio: 'ignore' });
}

async function copyExtractedSubdirectory({ archivePath, artifactName, sourceSubdir, destinationDir }) {
  const extractDir = await mkdtemp(join(tmpdir(), 'happier-skia-extract-'));
  try {
    await extractTarGz(archivePath, extractDir);
    const sourceCandidates = [
      join(extractDir, artifactName, sourceSubdir),
      join(extractDir, sourceSubdir),
    ];
    let sourceDir = '';
    for (const candidate of sourceCandidates) {
      if (await pathExists(candidate)) {
        sourceDir = candidate;
        break;
      }
    }
    if (!(await pathExists(sourceDir))) {
      throw new Error(
        `Skia artifact ${basename(archivePath)} did not contain ${artifactName}/${sourceSubdir} or ${sourceSubdir}`,
      );
    }
    await mkdir(dirname(destinationDir), { recursive: true });
    await cp(sourceDir, destinationDir, { recursive: true, force: true });
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

async function installSkiaArtifact({ packageDir, artifactName, sourceSubdir, destinationDir, env, quiet }) {
  const packageJson = await readSkiaPackageJson(packageDir);
  const { releaseTag } = resolveSkiaArtifactConfig(packageJson, env);
  const assetName = `${artifactName}-${releaseTag}.tar.gz`;
  const archiveUrl = joinUrl(resolveSkiaReleaseBaseUrl(env), releaseTag, assetName);
  const downloadDir = await mkdtemp(join(tmpdir(), 'happier-skia-download-'));
  const archivePath = join(downloadDir, assetName);
  try {
    if (!quiet) {
      console.log(`[mobile] downloading Skia artifact ${assetName}`);
    }
    await downloadToFile(archiveUrl, archivePath, { env, quiet });
    await copyExtractedSubdirectory({ archivePath, artifactName, sourceSubdir, destinationDir });
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

async function hasIosXcframeworks(packageDir) {
  const iosLibsDir = join(packageDir, 'libs', 'apple', 'ios');
  try {
    const entries = await readdir(iosLibsDir, { withFileTypes: true });
    return entries.some((entry) => entry.name.endsWith('.xcframework') && entry.isDirectory());
  } catch {
    return false;
  }
}

function normalizeAndroidArchitectures(architectures) {
  const out = [];
  const seen = new Set();
  for (const architecture of architectures ?? DEFAULT_ANDROID_ARCHITECTURES) {
    const normalized = String(architecture ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out : [...DEFAULT_ANDROID_ARCHITECTURES];
}

export function resolveReactNativeSkiaAndroidArchitecturesFromEnv(env = process.env) {
  const raw = String(env.HAPPIER_ANDROID_BUILD_ARCHS ?? env.REACT_NATIVE_ARCHITECTURES ?? '').trim();
  if (!raw) return DEFAULT_ANDROID_ARCHITECTURES;
  return normalizeAndroidArchitectures(raw.split(','));
}

function resolveAndroidArtifact({ architecture, graphite, prefix }) {
  const nonGraphite = {
    'armeabi-v7a': { artifactName: `${prefix}-android-arm`, sourceSubdir: 'armeabi-v7a' },
    'arm64-v8a': { artifactName: `${prefix}-android-arm-64`, sourceSubdir: 'arm64-v8a' },
    x86: { artifactName: `${prefix}-android-arm-x86`, sourceSubdir: 'x86' },
    x86_64: { artifactName: `${prefix}-android-arm-x64`, sourceSubdir: 'x86_64' },
  };
  const graphiteArtifacts = {
    'armeabi-v7a': { artifactName: `${prefix}-android-arm`, sourceSubdir: 'arm' },
    'arm64-v8a': { artifactName: `${prefix}-android-arm-64`, sourceSubdir: 'arm64' },
    x86: { artifactName: `${prefix}-android-arm-x86`, sourceSubdir: 'x86' },
    x86_64: { artifactName: `${prefix}-android-arm-x64`, sourceSubdir: 'x64' },
  };
  const artifact = (graphite ? graphiteArtifacts : nonGraphite)[architecture];
  if (!artifact) {
    throw new Error(`Unsupported Android Skia architecture: ${architecture}`);
  }
  return artifact;
}

async function hasAndroidArchitectureBinaries(packageDir, architecture) {
  return await pathExists(join(packageDir, 'libs', 'android', architecture, 'libskia.a'));
}

export async function ensureReactNativeSkiaIosBinaries({
  projectDir,
  runnerDir,
  env = process.env,
  quiet = false,
} = {}) {
  const packageDir = await findReactNativeSkiaPackageDir({ projectDir, runnerDir });
  if (!packageDir) {
    return { repaired: false, packageDir: null };
  }

  if (await hasIosXcframeworks(packageDir)) {
    return { repaired: false, packageDir };
  }

  const packageJson = await readSkiaPackageJson(packageDir);
  const { prefix } = resolveSkiaArtifactConfig(packageJson, env);
  await installSkiaArtifact({
    packageDir,
    artifactName: `${prefix}-apple-ios-xcframeworks`,
    sourceSubdir: 'ios',
    destinationDir: join(packageDir, 'libs', 'apple', 'ios'),
    env,
    quiet,
  });
  return { repaired: true, packageDir };
}

export async function ensureReactNativeSkiaAndroidBinaries({
  projectDir,
  runnerDir,
  architectures,
  env = process.env,
  quiet = false,
} = {}) {
  const packageDir = await findReactNativeSkiaPackageDir({ projectDir, runnerDir });
  if (!packageDir) {
    return { repaired: false, packageDir: null, architectures: [] };
  }

  const packageJson = await readSkiaPackageJson(packageDir);
  const { graphite, prefix } = resolveSkiaArtifactConfig(packageJson, env);
  let repaired = false;
  const requestedArchitectures = normalizeAndroidArchitectures(architectures);

  for (const architecture of requestedArchitectures) {
    if (await hasAndroidArchitectureBinaries(packageDir, architecture)) {
      continue;
    }
    const { artifactName, sourceSubdir } = resolveAndroidArtifact({ architecture, graphite, prefix });
    await installSkiaArtifact({
      packageDir,
      artifactName,
      sourceSubdir,
      destinationDir: join(packageDir, 'libs', 'android', architecture),
      env,
      quiet,
    });
    repaired = true;
  }

  return { repaired, packageDir, architectures: requestedArchitectures };
}
