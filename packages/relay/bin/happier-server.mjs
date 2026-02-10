#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { resolveServerReleaseAssets } from '../src/releaseAssets.mjs';
import { lookupSha256 } from '../src/checksums.mjs';
import { verifyMinisign } from '../src/minisign.mjs';

const OWNER = 'happier-dev';
const REPO = 'happier';

function fail(msg) {
  process.stderr.write(`[happier-server] ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const kv = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) {
      kv.set(a, v);
      i += 1;
    } else {
      kv.set(a, 'true');
    }
  }
  return { kv, positionals };
}

function resolveTarget() {
  const os = platform();
  const cpu = arch();
  // Server binaries are currently built for Linux only in CI.
  if (os !== 'linux') {
    fail(`Unsupported platform '${os}'. Server runner currently supports linux only.`);
  }
  if (cpu !== 'x64' && cpu !== 'arm64') {
    fail(`Unsupported architecture '${cpu}'. Expected x64 or arm64.`);
  }
  return { os, arch: cpu };
}

function cacheRoot() {
  const xdg = String(process.env.XDG_CACHE_HOME ?? '').trim();
  if (xdg) return xdg;
  return join(homedir(), '.cache');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'happier-server-runner',
      accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'happier-server-runner' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { headers: { 'user-agent': 'happier-server-runner' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  await writeFile(destPath, Buffer.from(ab));
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { kv, positionals } = parseArgs(process.argv.slice(2));
  const channel = String(kv.get('--channel') ?? '').trim() || 'stable';
  if (channel !== 'stable' && channel !== 'preview') {
    fail(`Invalid --channel '${channel}'. Expected stable|preview.`);
  }
  const tag = String(kv.get('--tag') ?? '').trim() || (channel === 'preview' ? 'server-preview' : 'server-stable');

  const target = resolveTarget();

  const releaseUrl = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const release = await fetchJson(releaseUrl);
  const assets = resolveServerReleaseAssets({ release, os: target.os, arch: target.arch });

  const pubkeyPath = new URL('../assets/happier-release.pub', import.meta.url);
  const pubkeyFile = await readFile(pubkeyPath, 'utf-8');

  const tmp = join(tmpdir(), `happier-server-${process.pid}-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    const checksumsPath = join(tmp, assets.checksums.name);
    const checksumsSigPath = join(tmp, assets.checksumsSig.name);
    await downloadFile(assets.checksums.url, checksumsPath);
    await downloadFile(assets.checksumsSig.url, checksumsSigPath);

    const checksumsText = await readFile(checksumsPath, 'utf-8');
    const sigFile = await readFile(checksumsSigPath, 'utf-8');
    const ok = verifyMinisign({ message: Buffer.from(checksumsText, 'utf-8'), pubkeyFile, sigFile });
    if (!ok) fail('Signature verification failed for checksums file.');

    const expected = lookupSha256({ checksumsText, filename: assets.tarball.name });

    const cacheDir = join(cacheRoot(), 'happier', 'server', tag, assets.version, `${target.os}-${target.arch}`);
    await mkdir(cacheDir, { recursive: true });
    const artifactStem = `happier-server-v${assets.version}-${target.os}-${target.arch}`;
    const serverDir = join(cacheDir, artifactStem);
    const serverBin = join(serverDir, 'happier-server');

    if (!(await pathExists(serverBin))) {
      const tarballPath = join(tmp, assets.tarball.name);
      await downloadFile(assets.tarball.url, tarballPath);
      const actual = await sha256File(tarballPath);
      if (actual !== expected) {
        fail(`SHA256 mismatch for ${assets.tarball.name}: expected ${expected}, got ${actual}`);
      }

      // Extract archive into cache (archive root contains the artifactStem folder).
      const extract = spawn('tar', ['-xzf', tarballPath, '-C', cacheDir], { stdio: 'inherit' });
      await new Promise((resolve, reject) => {
        extract.on('error', reject);
        extract.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
      });
    }

    if (!(await pathExists(serverBin))) {
      fail(`Extracted server binary not found at ${serverBin}`);
    }

    const child = spawn(serverBin, positionals, { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});

