// @ts-check

import { normalizePublicReleaseChannel, resolveRollingReleaseTagSuffix } from '../lib/public-release-rings.mjs';

function replacePowerShellDefaultChannel(raw, channel) {
  return raw.replace(
    /(^.*\$Channel\s*=\s*\$\(\s*if \(\$env:HAPPIER_CHANNEL\) \{\s*\$env:HAPPIER_CHANNEL\s*\} else \{\s*)"stable"(\s*\}\s*\).*$)/m,
    `$1"${channel}"$2`,
  );
}

export const INSTALLER_PUBLISH_SPECS = [
  { source: 'install.sh', targets: ['install.sh', 'install'] },
  { source: 'install.sh', targets: ['install-preview.sh', 'install-preview'], transform: 'preview-default-channel' },
  { source: 'install.sh', targets: ['install-dev.sh', 'install-dev'], transform: 'publicdev-default-channel' },
  { source: 'install-server', targets: ['install-server'] },
  { source: 'install-server.sh', targets: ['install-server.sh'] },
  { source: 'install.ps1', targets: ['install.ps1'] },
  { source: 'install.ps1', targets: ['install-preview.ps1'], transform: 'preview-default-channel' },
  { source: 'install.ps1', targets: ['install-dev.ps1'], transform: 'publicdev-default-channel' },
  { source: 'happier-release.pub', targets: ['happier-release.pub'] },
];

export const INSTALLER_FILENAMES = INSTALLER_PUBLISH_SPECS.flatMap((spec) => spec.targets);

/**
 * @param {{ platform: 'linux' | 'darwin' | 'win32'; channel: string }} params
 */
export function resolvePublishedInstallerAsset({ platform, channel }) {
  const normalizedChannel = normalizePublicReleaseChannel(channel);
  if (!normalizedChannel) {
    throw new Error(`Unsupported installer release channel: ${channel}`);
  }

  const installerBase =
    normalizedChannel === 'stable'
      ? 'install'
      : normalizedChannel === 'preview'
        ? 'install-preview'
        : 'install-dev';

  return {
    tag: `cli-${resolveRollingReleaseTagSuffix(normalizedChannel)}`,
    installer: platform === 'win32' ? `${installerBase}.ps1` : `${installerBase}.sh`,
  };
}

/**
 * @param {string} tag
 * @returns {'stable' | 'preview' | 'publicdev'}
 */
export function resolvePublishedInstallerChannelForTag(tag) {
  const value = String(tag ?? '').trim();
  if (!value) {
    throw new Error('Missing published installer tag');
  }
  if (value === 'cli-stable' || /^cli-v\d+\.\d+\.\d+$/.test(value)) {
    return 'stable';
  }
  if (value === 'cli-preview' || /^cli-v\d+\.\d+\.\d+-preview\./.test(value)) {
    return 'preview';
  }
  if (value === 'cli-dev' || /^cli-v\d+\.\d+\.\d+-dev\./.test(value)) {
    return 'publicdev';
  }
  throw new Error(`Unsupported installer release tag: ${value}`);
}

/**
 * @param {{ platform: 'linux' | 'darwin' | 'win32'; tag: string }} params
 */
export function resolvePublishedInstallerAssetForTag({ platform, tag }) {
  const channel = resolvePublishedInstallerChannelForTag(tag);
  const resolved = resolvePublishedInstallerAsset({ platform, channel });
  return {
    tag: String(tag ?? '').trim(),
    installer: resolved.installer,
  };
}

export function applyInstallerPublishTransform(contents, transform) {
  if (!transform) return contents;
  const raw = contents.toString('utf8');
  if (transform === 'preview-default-channel') {
    const shellUpdated = raw.replaceAll('HAPPIER_CHANNEL:-stable', 'HAPPIER_CHANNEL:-preview');
    const ps1Updated = replacePowerShellDefaultChannel(shellUpdated, 'preview');
    return Buffer.from(ps1Updated, 'utf8');
  }
  if (transform === 'publicdev-default-channel') {
    const shellUpdated = raw.replaceAll('HAPPIER_CHANNEL:-stable', 'HAPPIER_CHANNEL:-dev');
    const ps1Updated = replacePowerShellDefaultChannel(shellUpdated, 'dev');
    return Buffer.from(ps1Updated, 'utf8');
  }
  throw new Error(`[release] unknown installer transform: ${transform}`);
}
