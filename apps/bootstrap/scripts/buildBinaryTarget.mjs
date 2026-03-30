const CLI_BINARY_TARGETS = [
  { bunTarget: 'bun-linux-x64-baseline', os: 'linux', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-darwin-x64', os: 'darwin', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-windows-x64', os: 'windows', arch: 'x64', exeExt: '.exe' },
];

function normalizePlatform(platform) {
  return platform === 'win32' ? 'windows' : platform;
}

export function resolveBuildBinaryTarget(params = {}) {
  const bunTargetOverride = typeof params.bunTargetOverride === 'string'
    ? params.bunTargetOverride.trim()
    : '';

  if (bunTargetOverride.length > 0) {
    const overriddenTarget = CLI_BINARY_TARGETS.find((candidate) => candidate.bunTarget === bunTargetOverride);
    if (!overriddenTarget) {
      throw new Error(`[bootstrap] unsupported HAPPIER_BUN_TARGET override: ${bunTargetOverride}`);
    }
    return overriddenTarget;
  }

  const platform = normalizePlatform(String(params.platform ?? process.platform).trim() || process.platform);
  const arch = String(params.arch ?? process.arch).trim() || process.arch;
  const target = CLI_BINARY_TARGETS.find((candidate) => candidate.os === platform && candidate.arch === arch);
  if (!target) {
    throw new Error(`[bootstrap] unsupported binary target: ${platform}-${arch}`);
  }
  return target;
}
