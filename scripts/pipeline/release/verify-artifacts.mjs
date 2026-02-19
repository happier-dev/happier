#!/usr/bin/env node

// @ts-check

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { commandExists, execOrThrow, fileSha256, parseArgs } from './lib/binary-release.mjs';

function parseChecksums(raw) {
  const lines = String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const match = /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(`[release] invalid checksum line: ${line}`);
    }
    return { sha256: match[1].toLowerCase(), name: match[2] };
  });
}

function fileExists(path) {
  return spawnSync('bash', ['-lc', `test -f "${path.replaceAll('"', '\\"')}"`], { stdio: 'ignore' }).status === 0;
}

async function smokeTestArchive({ archivePath }) {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-release-smoke-'));
  try {
    execOrThrow('tar', ['-xzf', archivePath, '-C', scratch], { stdio: 'ignore' });
    const roots = await readdir(scratch);
    if (roots.length === 0) {
      throw new Error(`[release] extracted archive is empty: ${archivePath}`);
    }
    const root = join(scratch, roots[0]);
    const files = await readdir(root);
    const candidate = files.find((name) => !name.endsWith('.txt') && !name.endsWith('.json'));
    if (!candidate) {
      throw new Error(`[release] no executable found in archive: ${archivePath}`);
    }
    if (candidate.endsWith('.exe') && process.platform !== 'win32') {
      return;
    }
    const binPath = join(root, candidate);
    const args = candidate.startsWith('happier-server') ? ['--help'] : ['--version'];
    const result = spawnSync(binPath, args, {
      encoding: 'utf-8',
      timeout: 20_000,
    });
    const timedOut = result.error && result.error.code === 'ETIMEDOUT';
    if (timedOut) {
      const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
      if (candidate.startsWith('happier-server')) {
        if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(output)) {
          throw new Error(`[release] smoke test failed for ${archivePath}: ${output.trim()}`);
        }
        return;
      }
      if (/version/i.test(output)) {
        return;
      }
      throw new Error(`[release] smoke test timed out for ${archivePath}: ${output.trim()}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`[release] smoke test failed for ${archivePath}: ${String(result.stderr ?? '').trim()}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { kv, flags } = parseArgs(process.argv.slice(2));
  const artifactsDir = resolve(String(kv.get('--artifacts-dir') ?? '').trim() || join(process.cwd(), 'dist', 'release-assets'));
  const checksumsPathInput = String(kv.get('--checksums') ?? '').trim();
  const checksumsPath = checksumsPathInput || (() => {
    const result = spawnSync('bash', ['-lc', `ls "${artifactsDir}"/checksums-*.txt 2>/dev/null | head -n 1`], { encoding: 'utf-8' });
    return String(result.stdout ?? '').trim();
  })();
  if (!checksumsPath) {
    throw new Error(`[release] no checksums file found in ${artifactsDir}`);
  }

  const checksumsRaw = await readFile(checksumsPath, 'utf-8');
  const entries = parseChecksums(checksumsRaw);
  for (const entry of entries) {
    const path = join(artifactsDir, entry.name);
    const hash = await fileSha256(path);
    if (hash !== entry.sha256) {
      throw new Error(`[release] checksum mismatch for ${entry.name}`);
    }
  }

  const minisigPath = `${checksumsPath}.minisig`;
  const pubKeyPath = String(kv.get('--public-key') ?? process.env.MINISIGN_PUBLIC_KEY ?? '').trim();
  if (fileExists(minisigPath)) {
    if (!pubKeyPath) {
      throw new Error('[release] signature found but no --public-key/MINISIGN_PUBLIC_KEY provided');
    }
    if (!commandExists('minisign')) {
      throw new Error('[release] minisign required to verify signatures');
    }
    execOrThrow('minisign', ['-Vm', checksumsPath, '-p', pubKeyPath], { stdio: 'inherit' });
  }

  if (!flags.has('--skip-smoke')) {
    for (const entry of entries) {
      if (!entry.name.endsWith('.tar.gz')) continue;
      await smokeTestArchive({ archivePath: join(artifactsDir, entry.name) });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    artifactsDir,
    checksumsPath,
    verified: entries.map((entry) => entry.name),
    smoke: !flags.has('--skip-smoke'),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
