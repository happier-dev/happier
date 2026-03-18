import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  getFirstPartyComponentCatalogEntry,
  installVersionedPayload,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { planArchiveExtraction } from '@happier-dev/release-runtime/extractPlan';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import { DEFAULT_MINISIGN_PUBLIC_KEY } from '@happier-dev/release-runtime/minisign';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';

import { findExtractedExecutableByName } from './findExtractedExecutableByName.mjs';

function commandExists(name) {
  if (process.platform === 'win32') {
    return (spawnSync('where', [name], { stdio: 'ignore' }).status ?? 1) === 0;
  }
  return (spawnSync('sh', ['-lc', `command -v ${name} >/dev/null 2>&1`], { stdio: 'ignore' }).status ?? 1) === 0;
}

function normalizeArch() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!arch) {
    throw new Error(`[self-host] unsupported architecture: ${process.arch}`);
  }
  return arch;
}

function normalizeOs(platform = process.platform) {
  const p = String(platform ?? '').trim() || process.platform;
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'darwin';
  if (p === 'win32') return 'windows';
  throw new Error(`[self-host] unsupported platform: ${p}`);
}

function resolveMinisignPublicKeyText(env = process.env) {
  const inline = String(env?.HAPPIER_MINISIGN_PUBKEY ?? '').trim();
  return inline || DEFAULT_MINISIGN_PUBLIC_KEY;
}

function runCheckedCommand(command, args, context) {
  const result = spawnSync(command, args, { stdio: 'ignore', encoding: 'utf-8' });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `[self-host] ${context} failed (${command} ${args.join(' ')}): ${String(result.stderr ?? result.stdout ?? '').trim()}`,
    );
  }
}

export async function installCompanionCliFromBundle({
  bundle,
  processEnv = process.env,
  pubkeyFile = resolveMinisignPublicKeyText(processEnv),
  userAgent = 'happier-self-host-installer',
}) {
  const component = getFirstPartyComponentCatalogEntry('happier-cli');
  const binaryName = process.platform === 'win32' ? `${component.executableBaseName}.exe` : component.executableBaseName;
  const resolvedBundle = bundle;
  if (!resolvedBundle?.archive?.url || !resolvedBundle?.archive?.name) {
    throw new Error('[self-host] invalid companion CLI release bundle (missing archive)');
  }
  if (!resolvedBundle?.checksums?.url || !resolvedBundle?.checksumsSig?.url) {
    throw new Error('[self-host] invalid companion CLI release bundle (missing checksums assets)');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'happier-self-host-companion-cli-'));
  try {
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle: resolvedBundle,
      destDir: tempDir,
      pubkeyFile,
      userAgent,
    });
    const extractDir = join(tempDir, 'extract');
    await mkdir(extractDir, { recursive: true });
    const plan = planArchiveExtraction({
      archiveName: downloaded.archiveName,
      archivePath: downloaded.archivePath,
      destDir: extractDir,
      os: normalizeOs(process.platform),
    });
    if (!commandExists(plan.requiredCommand)) {
      throw new Error(`[self-host] ${plan.requiredCommand} is required to extract companion CLI artifacts`);
    }
    runCheckedCommand(plan.command.cmd, plan.command.args, 'extracting companion CLI release bundle');

    const extractedBinaryPath = await findExtractedExecutableByName(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error('[self-host] failed to locate extracted companion CLI binary');
    }

    const version = downloaded.version || String(resolvedBundle?.version ?? '').trim() || `${Date.now()}`;
    await installVersionedPayload({
      componentId: 'happier-cli',
      versionId: version,
      payloadRoot: dirname(extractedBinaryPath),
      processEnv,
    });

    return {
      installed: true,
      version,
      source: resolvedBundle.archive.url,
      reason: 'installed',
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function maybeInstallCompanionCli({
  channel,
  githubRepo,
  withCli,
  processEnv = process.env,
}) {
  if (!withCli) return { installed: false, reason: 'disabled' };
  if (commandExists('happier')) {
    return { installed: false, reason: 'already-installed' };
  }

  const component = getFirstPartyComponentCatalogEntry('happier-cli');
  const tag = channel === 'preview' ? component.releaseTagPreview : component.releaseTagStable;
  const release = await fetchGitHubReleaseByTag({
    githubRepo,
    tag,
    userAgent: 'happier-self-host-installer',
    githubToken: String(processEnv.GITHUB_TOKEN ?? processEnv.GH_TOKEN ?? ''),
  });
  const bundle = resolveReleaseAssetBundle({
    assets: release?.assets,
    product: component.releaseProductName,
    os: normalizeOs(process.platform),
    arch: normalizeArch(),
  });

  return installCompanionCliFromBundle({
    bundle,
    processEnv,
    pubkeyFile: resolveMinisignPublicKeyText(processEnv),
    userAgent: 'happier-self-host-installer',
  });
}
