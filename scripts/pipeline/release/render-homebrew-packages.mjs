#!/usr/bin/env node

// @ts-check

/**
 * Renders the Homebrew formula (`happier`, CLI, our tap) and cask (`happier`, desktop app,
 * homebrew/cask) from a published stable GitHub release: the real asset URLs, pinned to the
 * sha256 in that release's signed `checksums-*.txt`. GitHub's own asset digest, when present, must
 * agree. Output lands in `dist/homebrew/{Formula,Casks}/happier.rb` by default. The formula is a
 * release product (rendered by `release-channel.yml` for the tap, never checked in); the cask prepared for
 * the homebrew/cask submission is kept at `packaging/homebrew/Casks/happier.rb`
 * (`--desktop-version <v> --out-dir packaging/homebrew`).
 *
 * Usage:
 *   node scripts/pipeline/release/render-homebrew-packages.mjs --cli-version 0.2.13 [--desktop-version 0.2.12]
 *     [--repo happier-dev/happier] [--out-dir dist/homebrew]
 * `GITHUB_TOKEN`/`GH_TOKEN` is used for the release metadata read when set.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_REPO = 'happier-dev/happier';

/**
 * The first CLI release that is correct under Homebrew: `self update` defers to `brew upgrade`
 * for a compiled binary, and its background service records the keg-independent opt path. An
 * older release would install but fight Homebrew, so the formula is never rendered for one.
 */
export const HOMEBREW_FORMULA_MIN_CLI_VERSION = '0.2.13';

/**
 * Happier's one macOS minimum, declared by the formula and the cask alike. The CLI's compiled
 * `happier` (Bun) declares LC_BUILD_VERSION minos 13.0 on arm64 and x64 (observed on the
 * cli-v0.2.12 artifacts), and the desktop app installs that CLI, so it declares the same floor
 * (`bundle.macOS.minimumSystemVersion` in apps/ui/src-tauri/tauri.conf.json).
 */
export const HAPPIER_MIN_MACOS = Object.freeze({ symbol: 'ventura', version: '13.0' });
const GENERATOR_PATH = 'scripts/pipeline/release/render-homebrew-packages.mjs';

/** The CLI payloads Homebrew installs (Windows has no Homebrew). Order is the rendered order. */
const CLI_FORMULA_TARGETS = Object.freeze([
  { os: 'darwin', arch: 'arm64', block: ['on_macos', 'on_arm'] },
  { os: 'darwin', arch: 'x64', block: ['on_macos', 'on_intel'] },
  { os: 'linux', arch: 'arm64', block: ['on_linux', 'on_arm'] },
  { os: 'linux', arch: 'x64', block: ['on_linux', 'on_intel'] },
]);

/** Desktop platform keys (scripts/pipeline/tauri/bundle-candidate.mjs) per Homebrew `arch`. */
const DESKTOP_CASK_ARCHES = Object.freeze({ arm: 'aarch64', intel: 'x86_64' });

/**
 * @typedef {{ name: string; browser_download_url: string; digest?: string | null }} ReleaseAsset
 * @typedef {{ tag_name: string; draft?: boolean; prerelease?: boolean; assets: ReleaseAsset[] }} Release
 */

/** @param {string} text */
export function parseChecksums(text) {
  /** @type {Map<string, string>} */
  const checksums = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match) checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

/** @param {string} left @param {string} right */
function compareStableVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * @param {Release} release
 * @param {string} tagPrefix
 */
function readStableReleaseVersion(release, tagPrefix) {
  const tag = String(release?.tag_name ?? '');
  if (!tag.startsWith(tagPrefix)) {
    throw new Error(`[homebrew] expected a ${tagPrefix}<version> release, got ${tag || '<none>'}`);
  }
  if (release.draft || release.prerelease) {
    throw new Error(`[homebrew] ${tag} is a draft or prerelease; Homebrew packages render only from a published stable release`);
  }
  const version = tag.slice(tagPrefix.length);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`[homebrew] ${tag} is not a stable x.y.z version`);
  }
  return version;
}

/**
 * The asset's download URL and its sha256 from the release's checksums file.
 * @param {{ release: Release; checksums: Map<string, string>; checksumsName: string; assetName: string }} params
 */
function resolvePinnedAsset({ release, checksums, checksumsName, assetName }) {
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(`[homebrew] ${release.tag_name} has no ${assetName} asset`);
  }
  const sha256 = checksums.get(assetName);
  if (!sha256) {
    throw new Error(`[homebrew] ${assetName} has no entry in ${checksumsName}`);
  }
  const digest = String(asset.digest ?? '').trim().toLowerCase();
  if (digest && digest !== `sha256:${sha256}`) {
    throw new Error(`[homebrew] ${assetName}: GitHub asset digest ${digest} does not match ${checksumsName} (${sha256})`);
  }
  return { url: asset.browser_download_url, sha256 };
}

/** @param {Release} release @param {string} checksumsName */
function requireChecksumsAsset(release, checksumsName) {
  if (!release.assets.some((asset) => asset.name === checksumsName)) {
    throw new Error(`[homebrew] ${release.tag_name} has no ${checksumsName}`);
  }
}

/**
 * @param {{ release: Release; checksumsText: string; repo?: string; minimumVersion?: string }} params
 * @returns {string}
 */
export function renderHappierFormulaFromRelease({
  release,
  checksumsText,
  repo = DEFAULT_REPO,
  minimumVersion = HOMEBREW_FORMULA_MIN_CLI_VERSION,
}) {
  const version = readStableReleaseVersion(release, 'cli-v');
  if (compareStableVersions(version, minimumVersion) < 0) {
    throw new Error(`[homebrew] ${release.tag_name} predates the first Homebrew-aware CLI (${minimumVersion}); render the formula from ${minimumVersion} or later`);
  }
  const checksumsName = `checksums-happier-v${version}.txt`;
  requireChecksumsAsset(release, checksumsName);
  const checksums = parseChecksums(checksumsText);

  const pinned = CLI_FORMULA_TARGETS.map((target) => ({
    ...target,
    ...resolvePinnedAsset({
      release,
      checksums,
      checksumsName,
      assetName: `happier-v${version}-${target.os}-${target.arch}.tar.gz`,
    }),
  }));
  const platformBlock = (/** @type {string} */ osBlock) => [
    `  ${osBlock} do`,
    ...(osBlock === 'on_macos' ? [`    depends_on macos: :${HAPPIER_MIN_MACOS.symbol}`, ''] : []),
    ...pinned
      .filter((target) => target.block[0] === osBlock)
      .flatMap((target) => [
        `    ${target.block[1]} do`,
        `      url "${target.url}"`,
        `      sha256 "${target.sha256}"`,
        '    end',
      ]),
    '  end',
  ];

  return [
    `# Generated by ${GENERATOR_PATH} from ${release.tag_name}; do not edit by hand.`,
    'class Happier < Formula',
    '  desc "Run coding agents on your own machines and drive them from any device"',
    '  homepage "https://happier.dev/"',
    `  version "${version}"`,
    '  license "MIT"',
    '',
    '  livecheck do',
    `    url "https://github.com/${repo}/releases/download/cli-stable/latest.json"`,
    '    strategy :json do |json|',
    '      json["version"]',
    '    end',
    '  end',
    '',
    ...platformBlock('on_macos'),
    ...platformBlock('on_linux'),
    '',
    '  # The payload is a self-contained, signed runtime (compiled `happier` plus the `package-dist`,',
    '  # `node_modules`, `tools` and `scripts` it loads beside itself). Keep it byte-for-byte.',
    '  skip_clean "libexec"',
    '',
    '  def install',
    '    libexec.install Dir["*"]',
    '    bin.install_symlink libexec/"happier"',
    '  end',
    '',
    '  # No `service` block: `happier service install` owns the background service.',
    '  def caveats',
    '    <<~EOS',
    '      Run `happier setup` to connect this computer and sign in.',
    '      Homebrew updates this CLI: use `brew upgrade happier` (`happier self update` defers to it).',
    '    EOS',
    '  end',
    '',
    '  test do',
    '    assert_match version.to_s, shell_output("#{bin}/happier --version")',
    '  end',
    'end',
    '',
  ].join('\n');
}

/**
 * @param {{ release: Release; checksumsText: string; repo?: string }} params
 * @returns {string}
 */
export function renderHappierCaskFromRelease({ release, checksumsText, repo = DEFAULT_REPO }) {
  const version = readStableReleaseVersion(release, 'ui-desktop-v');
  const checksumsName = `checksums-happier-ui-desktop-v${version}.txt`;
  requireChecksumsAsset(release, checksumsName);
  const checksums = parseChecksums(checksumsText);

  const urlTemplate = `https://github.com/${repo}/releases/download/ui-desktop-v#{version}/happier-ui-desktop-darwin-#{arch}-v#{version}.dmg`;
  const sha256ByArch = Object.fromEntries(Object.entries(DESKTOP_CASK_ARCHES).map(([homebrewArch, platformArch]) => {
    const assetName = `happier-ui-desktop-darwin-${platformArch}-v${version}.dmg`;
    const pinned = resolvePinnedAsset({ release, checksums, checksumsName, assetName });
    const expanded = urlTemplate.replaceAll('#{version}', version).replaceAll('#{arch}', platformArch);
    if (pinned.url !== expanded) {
      throw new Error(`[homebrew] ${assetName} is published at ${pinned.url}, not the cask URL ${expanded}`);
    }
    return [homebrewArch, pinned.sha256];
  }));

  // No generated-file header: after the first homebrew/cask submission BrewTestBot's autobump
  // owns this file there, and this rendering only prepares a submission or a manual bump.
  return [
    'cask "happier" do',
    `  arch arm: "${DESKTOP_CASK_ARCHES.arm}", intel: "${DESKTOP_CASK_ARCHES.intel}"`,
    '',
    `  version "${version}"`,
    `  sha256 arm:   "${sha256ByArch.arm}",`,
    `         intel: "${sha256ByArch.intel}"`,
    '',
    `  url "${urlTemplate}"`,
    '  name "Happier"',
    '  desc "Cross-device client for coding agents"',
    '  homepage "https://happier.dev/"',
    '',
    '  livecheck do',
    `    url "https://github.com/${repo}/releases/download/ui-desktop-stable/latest.json"`,
    '    strategy :json do |json|',
    '      json["version"]',
    '    end',
    '  end',
    '',
    '  # The app updates itself from the same stable feed. This keeps a plain `brew upgrade` from',
    '  # replacing it; `brew upgrade --greedy` (or `--greedy-auto-updates`) still upgrades it.',
    '  auto_updates true',
    `  depends_on macos: :${HAPPIER_MIN_MACOS.symbol}`,
    '',
    '  app "Happier.app"',
    '',
    '  uninstall quit: "dev.happier.app"',
    '',
    '  # ~/.happier is deliberately absent: it is the Happier CLI\'s home (account, machine and',
    '  # daemon state) and is shared with any CLI installed on this computer.',
    '  zap trash: [',
    '    "~/Library/Caches/dev.happier.app",',
    '    "~/Library/HTTPStorages/dev.happier.app",',
    '    "~/Library/LaunchAgents/Happier.plist",',
    '    "~/Library/Preferences/dev.happier.app.plist",',
    '    "~/Library/Saved Application State/dev.happier.app.savedState",',
    '    "~/Library/WebKit/dev.happier.app",',
    '  ]',
    'end',
    '',
  ].join('\n');
}

/**
 * Reads a release and the exact signed checksums file its package pins to. A release can carry
 * other checksums files (component products), so the file is chosen by name, never by pattern.
 * @param {{ repo: string; tag: string; checksumsName: string; token?: string; fetchImpl?: typeof fetch }} params
 * @returns {Promise<{ release: Release; checksumsText: string }>}
 */
export async function readReleaseWithChecksums({ repo, tag, checksumsName, token = '', fetchImpl = fetch }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'happier-homebrew-render',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
  if (!response.ok) {
    throw new Error(`[homebrew] reading ${repo} release ${tag} failed: HTTP ${response.status}`);
  }
  /** @type {Release} */
  const release = await response.json();
  const checksumsAsset = release.assets.find((asset) => asset.name === checksumsName);
  if (!checksumsAsset) {
    throw new Error(`[homebrew] ${tag} has no ${checksumsName}`);
  }
  const checksumsResponse = await fetchImpl(checksumsAsset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!checksumsResponse.ok) {
    throw new Error(`[homebrew] downloading ${checksumsName} failed: HTTP ${checksumsResponse.status}`);
  }
  return { release, checksumsText: await checksumsResponse.text() };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'cli-version': { type: 'string', default: '' },
      'desktop-version': { type: 'string', default: '' },
      repo: { type: 'string', default: DEFAULT_REPO },
      'out-dir': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const cliVersion = String(values['cli-version']).trim();
  const desktopVersion = String(values['desktop-version']).trim();
  if (!cliVersion && !desktopVersion) {
    throw new Error('[homebrew] pass --cli-version and/or --desktop-version');
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const outDir = resolve(String(values['out-dir']).trim() || join(repoRoot, 'dist', 'homebrew'));
  const repo = String(values.repo).trim() || DEFAULT_REPO;
  const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();

  const written = [];
  if (cliVersion) {
    const source = await readReleaseWithChecksums({ repo, tag: `cli-v${cliVersion}`, checksumsName: `checksums-happier-v${cliVersion}.txt`, token });
    const path = join(outDir, 'Formula', 'happier.rb');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderHappierFormulaFromRelease({ ...source, repo }), 'utf8');
    written.push(path);
  }
  if (desktopVersion) {
    const source = await readReleaseWithChecksums({ repo, tag: `ui-desktop-v${desktopVersion}`, checksumsName: `checksums-happier-ui-desktop-v${desktopVersion}.txt`, token });
    const path = join(outDir, 'Casks', 'happier.rb');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderHappierCaskFromRelease({ ...source, repo }), 'utf8');
    written.push(path);
  }
  console.log(JSON.stringify({ written }, null, 2));
}

const invokedPath = typeof process.argv[1] === 'string' ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
