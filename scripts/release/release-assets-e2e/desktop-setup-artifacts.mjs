// @ts-check
// Inputs for the desktop-setup suite: the hsetup binary exactly as a desktop artifact ships it, the
// CLI release assets the feed serves, pinned published baselines, and the feed's test TLS material.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export { extractBundledHsetup } from '../../pipeline/tauri/linux-desktop-hsetup.mjs';

const VERSION_RE_SOURCE = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';
const CLI_CHECKSUMS_RE = new RegExp(`^checksums-happier-v(${VERSION_RE_SOURCE})\\.txt$`, 'u');
const DESKTOP_DEB_SHA_RE = new RegExp(`^happier-ui-desktop-linux-x86_64-v(${VERSION_RE_SOURCE})\\.deb\\.sha256$`, 'u');

/** @param {string} path */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The CLI release asset bundle for one platform, named exactly as `resolveReleaseAssetBundle`
 * (`packages/release-runtime/src/assets.ts`) resolves it.
 * @param {{ names: readonly string[]; os?: string; arch?: string }} params
 */
export function resolveCliReleaseAssetNames({ names, os = 'linux', arch = 'x64' }) {
  const versions = [...new Set(names.map((name) => CLI_CHECKSUMS_RE.exec(name)?.[1]).filter(Boolean))];
  if (versions.length !== 1) {
    throw new Error(`expected exactly one checksums-happier-v<version>.txt, found ${versions.length ? versions.join(', ') : 'none'}`);
  }
  const version = /** @type {string} */ (versions[0]);
  const checksums = `checksums-happier-v${version}.txt`;
  const required = [checksums, `${checksums}.minisig`, `happier-v${version}-${os}-${arch}.tar.gz`];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`CLI release assets are missing: ${missing.join(', ')}`);
  return { version, checksums, signature: `${checksums}.minisig`, archive: required[2] };
}

/**
 * Copy one platform's CLI release bundle into a feed stage. The archive checksum is checked here
 * only to fail fast on a torn copy; hsetup's own minisign + checksum verification is the proof.
 * @param {{ sourceDir: string; stageDir: string }} params
 */
export function stageCliReleaseAssets({ sourceDir, stageDir }) {
  const bundle = resolveCliReleaseAssetNames({ names: readdirSync(sourceDir) });
  mkdirSync(stageDir, { recursive: true });
  for (const name of [bundle.checksums, bundle.signature, bundle.archive]) {
    copyFileSync(join(sourceDir, name), join(stageDir, name));
  }
  const expected = readFileSync(join(stageDir, bundle.checksums), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find(([, name]) => name === bundle.archive)?.[0];
  const actual = sha256File(join(stageDir, bundle.archive));
  if (expected !== actual) {
    throw new Error(`${bundle.archive} does not match ${bundle.checksums} (expected ${expected ?? 'no entry'}, got ${actual})`);
  }
  return bundle;
}

/**
 * @param {{ url: string; token?: string; accept?: string }} params
 */
async function githubRequest({ url, token, accept = 'application/vnd.github+json' }) {
  const response = await fetch(url, {
    headers: {
      accept,
      'user-agent': 'happier-release-validation-desktop-setup',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${url}`);
  return response;
}

/**
 * @param {{ repo: string; tag: string; token?: string }} params
 * @returns {Promise<{ name: string; url: string }[]>}
 */
export async function listReleaseAssets({ repo, tag, token }) {
  const response = await githubRequest({ url: `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, token });
  const release = /** @type {{ assets?: { name?: string; url?: string }[] }} */ (await response.json());
  return (release.assets ?? []).map((asset) => ({ name: String(asset.name ?? ''), url: String(asset.url ?? '') }));
}

/**
 * Download named assets of one immutable release tag.
 * @param {{ repo: string; tag: string; names: readonly string[]; destDir: string; token?: string }} params
 */
export async function downloadReleaseAssets({ repo, tag, names, destDir, token }) {
  const assets = await listReleaseAssets({ repo, tag, token });
  mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const asset = assets.find((candidate) => candidate.name === name);
    if (!asset) throw new Error(`release ${tag} has no asset ${name}`);
    const response = await githubRequest({ url: asset.url, token, accept: 'application/octet-stream' });
    if (!response.body) throw new Error(`release ${tag} asset ${name} has no body`);
    await pipeline(Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)), createWriteStream(join(destDir, name)));
  }
}

/**
 * The published stable desktop baseline and the CLI from that desktop's immutable source.
 * The rolling CLI can already have advanced while this desktop's release gate is running.
 * @param {{ repo: string; token?: string }} params
 */
export async function resolvePublishedStableBaseline({ repo, token }) {
  const desktopNames = (await listReleaseAssets({ repo, tag: 'ui-desktop-stable', token })).map((asset) => asset.name);
  const desktopVersion = desktopNames.map((name) => DESKTOP_DEB_SHA_RE.exec(name)?.[1]).find(Boolean);
  if (!desktopVersion) throw new Error('could not resolve the published stable desktop baseline');
  const desktopTag = `ui-desktop-v${desktopVersion}`;
  const response = await githubRequest({
    url: `https://api.github.com/repos/${repo}/contents/apps/cli/package.json?ref=${encodeURIComponent(desktopTag)}`,
    token,
    accept: 'application/vnd.github.raw+json',
  });
  const manifest = await response.json();
  const cliVersion = typeof manifest?.version === 'string' ? manifest.version : '';
  if (!new RegExp(`^${VERSION_RE_SOURCE}$`, 'u').test(cliVersion)) throw new Error(`invalid CLI version in ${desktopTag}'s source`);
  return { cliTag: `cli-v${cliVersion}`, desktopTag };
}

/**
 * The immutable `cli-v<version>` a rolling `cli-<channel>` release currently points at.
 * @param {{ repo: string; channel: string; token?: string }} params
 */
export async function resolvePublishedCliTag({ repo, channel, token }) {
  const names = (await listReleaseAssets({ repo, tag: `cli-${channel}`, token })).map((asset) => asset.name);
  const version = names.map((name) => CLI_CHECKSUMS_RE.exec(name)?.[1]).find(Boolean);
  if (!version) throw new Error(`could not resolve the published cli-${channel} release to a cli-v<version> tag`);
  return `cli-v${version}`;
}

/**
 * Download a pinned desktop `.deb` and check it against the release's own `.sha256` asset.
 * @param {{ repo: string; tag: string; destDir: string; token?: string }} params
 */
export async function downloadPinnedDesktopDeb({ repo, tag, destDir, token }) {
  const version = /^ui-desktop-v(.+)$/u.exec(tag)?.[1];
  if (!version) throw new Error(`desktop baseline must be an immutable ui-desktop-v<version> tag (got ${tag})`);
  const deb = `happier-ui-desktop-linux-x86_64-v${version}.deb`;
  await downloadReleaseAssets({ repo, tag, names: [deb, `${deb}.sha256`], destDir, token });
  const expected = readFileSync(join(destDir, `${deb}.sha256`), 'utf8').trim().split(/\s+/u)[0];
  const actual = sha256File(join(destDir, deb));
  if (expected !== actual) throw new Error(`${deb} does not match its published sha256`);
  return join(destDir, deb);
}

/**
 * Download a pinned CLI release's Linux x64 bundle.
 * @param {{ repo: string; tag: string; destDir: string; token?: string }} params
 */
export async function downloadPinnedCliAssets({ repo, tag, destDir, token }) {
  const version = /^cli-v(.+)$/u.exec(tag)?.[1];
  if (!version) throw new Error(`CLI baseline must be an immutable cli-v<version> tag (got ${tag})`);
  const checksums = `checksums-happier-v${version}.txt`;
  await downloadReleaseAssets({
    repo,
    tag,
    names: [checksums, `${checksums}.minisig`, `happier-v${version}-linux-x64.tar.gz`],
    destDir,
    token,
  });
  return destDir;
}

/**
 * A throwaway CA and an `api.github.com` server certificate for the feed. The CA reaches only the
 * processes the suite starts (NODE_EXTRA_CA_CERTS); nothing is installed into a trust store.
 * @param {{ dir: string; exec?: typeof execFileSync }} params
 */
export function createFeedTlsMaterial({ dir, exec = execFileSync }) {
  mkdirSync(dir, { recursive: true });
  const run = (/** @type {string[]} */ args) => exec('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2',
    '-subj', '/CN=Happier desktop-setup e2e CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=api.github.com']);
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=DNS:api.github.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt',
    '-days', '2', '-extfile', 'server.ext']);
  rmSync(join(dir, 'ca.key'), { force: true });
  chmodSync(join(dir, 'server.key'), 0o644);
  return { caCert: join(dir, 'ca.crt') };
}

/**
 * The ring a CLI build belongs to, from its version: the spec's `channel` must match the CLI the
 * feed serves, or the managed layout and service label would belong to another ring.
 * @param {string} version
 * @returns {'stable' | 'preview' | 'dev'}
 */
export function resolveChannelForCliVersion(version) {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/u.exec(version)?.[1] ?? '';
  if (!prerelease) return 'stable';
  if (/^dev\b/u.test(prerelease)) return 'dev';
  return 'preview';
}
