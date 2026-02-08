import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computePreviewVersion,
  compareVersions,
  normalizeSemverBase,
  acquireSingleFlightLock,
  resolveNpmPackageNameOverride,
  shouldNotifyUpdate,
  readUpdateCache,
  writeUpdateCache,
} from '../dist/update/index.js';

test('normalizeSemverBase strips prerelease', () => {
  assert.equal(normalizeSemverBase('1.2.3-preview.4'), '1.2.3');
});

test('computePreviewVersion returns X.Y.Z-preview.N', () => {
  assert.equal(computePreviewVersion({ baseVersion: '1.2.3', runNumber: 7 }), '1.2.3-preview.7');
});

test('shouldNotifyUpdate respects interval and command exclusions', () => {
  const now = 100_000;
  assert.equal(
    shouldNotifyUpdate({
      isTTY: true,
      cmd: 'self',
      updateAvailable: true,
      latest: '9.9.9',
      notifiedAt: null,
      notifyIntervalMs: 1000,
      nowMs: now,
    }),
    false,
  );
  assert.equal(
    shouldNotifyUpdate({
      isTTY: true,
      cmd: 'start',
      updateAvailable: true,
      latest: '9.9.9',
      notifiedAt: now - 500,
      notifyIntervalMs: 1000,
      nowMs: now,
    }),
    false,
  );
  assert.equal(
    shouldNotifyUpdate({
      isTTY: true,
      cmd: 'start',
      updateAvailable: true,
      latest: '9.9.9',
      notifiedAt: now - 2000,
      notifyIntervalMs: 1000,
      nowMs: now,
    }),
    true,
  );
});

test('readUpdateCache/writeUpdateCache round-trip JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cli-common-'));
  const path = join(dir, 'update.json');
  try {
    writeUpdateCache(path, {
      checkedAt: 1,
      latest: '2.0.0',
      current: '1.0.0',
      runtimeVersion: null,
      invokerVersion: '1.0.0',
      updateAvailable: true,
      notifiedAt: null,
    });
    const cache = readUpdateCache(path);
    assert.equal(cache?.latest, '2.0.0');

    // ensure file is valid JSON too
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.latest, '2.0.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compareVersions orders preview prereleases by numeric run number', () => {
  assert.equal(compareVersions('1.2.3-preview.10', '1.2.3-preview.2') > 0, true);
  assert.equal(compareVersions('1.2.3-preview.2', '1.2.3-preview.10') < 0, true);
});

test('resolveNpmPackageNameOverride uses fallback for invalid overrides', () => {
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '@company/happier-cli', fallback: '@happier-dev/cli' }),
    '@company/happier-cli',
  );
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '../evil', fallback: '@happier-dev/cli' }),
    '@happier-dev/cli',
  );
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '@scope/../evil', fallback: '@happier-dev/cli' }),
    '@happier-dev/cli',
  );
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '', fallback: '@happier-dev/cli' }),
    '@happier-dev/cli',
  );
});

test('acquireSingleFlightLock prevents duplicate spawns until ttl expires', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cli-common-lock-'));
  const lockPath = join(dir, 'update.check.lock.json');
  try {
    const pid = 12345;
    assert.equal(acquireSingleFlightLock({ lockPath, nowMs: 10_000, ttlMs: 60_000, pid }), true);
    assert.equal(acquireSingleFlightLock({ lockPath, nowMs: 10_100, ttlMs: 60_000, pid }), false);

    // After TTL, we should be able to acquire again.
    assert.equal(acquireSingleFlightLock({ lockPath, nowMs: 100_000, ttlMs: 60_000, pid }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
