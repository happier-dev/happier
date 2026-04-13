import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sourceRoot = join(repoRoot, 'scripts', 'release', 'installers');
const websiteRoot = join(repoRoot, 'apps', 'website', 'public');
const { INSTALLER_FILENAMES, INSTALLER_PUBLISH_SPECS } = await import('../pipeline/release/sync-installers.mjs');

function applyPowerShellChannelDefaultTransform(source, channelDefault) {
  return source.replace(
    /(^.*\$Channel\s*=\s*\$\(\s*if \(\$env:HAPPIER_CHANNEL\) \{\s*\$env:HAPPIER_CHANNEL\s*\} else \{\s*)"stable"(\s*\}\s*\).*$)/m,
    `$1"${channelDefault}"$2`,
  );
}

function applyTransform({ source, transform }) {
  if (transform === 'preview-default-channel') {
    const shellUpdated = source.replaceAll('HAPPIER_CHANNEL:-stable', 'HAPPIER_CHANNEL:-preview');
    return applyPowerShellChannelDefaultTransform(shellUpdated, 'preview');
  }
  if (transform === 'publicdev-default-channel') {
    const shellUpdated = source.replaceAll('HAPPIER_CHANNEL:-stable', 'HAPPIER_CHANNEL:-dev');
    return applyPowerShellChannelDefaultTransform(shellUpdated, 'dev');
  }
  return source;
}

test('published website installers stay in sync with release-owned installer sources', async () => {
  const expectedInstallerNames = [...INSTALLER_FILENAMES].sort();
  const actualInstallerNames = (await readdir(websiteRoot))
    .filter((name) => name.startsWith('install') || name === 'happier-release.pub')
    .sort();

  assert.deepEqual(actualInstallerNames, expectedInstallerNames, 'expected website/public installer filenames to match the canonical publish spec exactly');

  const forbidden = [
    'self-host',
    'self-host.sh',
    'self-host-preview',
    'self-host-preview.sh',
    'self-host-dev',
    'self-host-dev.sh',
    'self-host.ps1',
    'self-host-preview.ps1',
    'self-host-dev.ps1',
  ];

  for (const name of forbidden) {
    await assert.rejects(() => access(join(websiteRoot, name)), /ENOENT/, `expected ${name} to be removed from apps/website/public`);
  }

  for (const spec of INSTALLER_PUBLISH_SPECS) {
    const rawSource = await readFile(join(sourceRoot, spec.source), 'utf8');
    const source = applyTransform({ source: rawSource, transform: spec.transform });
    for (const target of spec.targets) {
      const published = await readFile(join(websiteRoot, target), 'utf8');
      assert.equal(published, source, `${target} is out of sync with scripts/release/installers/${spec.source}`);
    }
  }
});
