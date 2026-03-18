export type BinaryTarget = {
  bunTarget: string;
  os: string;
  arch: string;
  exeExt: string;
};

export const CLI_BINARY_TARGETS: BinaryTarget[] = [
  { bunTarget: 'bun-linux-x64-baseline', os: 'linux', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-darwin-x64', os: 'darwin', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-windows-x64', os: 'windows', arch: 'x64', exeExt: '.exe' },
];

export const SERVER_BINARY_TARGETS: BinaryTarget[] = [
  { bunTarget: 'bun-linux-x64-baseline', os: 'linux', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-darwin-x64', os: 'darwin', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-windows-x64', os: 'windows', arch: 'x64', exeExt: '.exe' },
];

function normalizePlatform(platform: string): string {
  return platform === 'win32' ? 'windows' : platform;
}

export function resolveCurrentBinaryTarget({
  availableTargets,
  platform = process.platform,
  arch = process.arch,
}: {
  availableTargets: BinaryTarget[];
  platform?: string;
  arch?: string;
}): BinaryTarget {
  const normalizedPlatform = normalizePlatform(String(platform ?? '').trim() || process.platform);
  const normalizedArch = String(arch ?? '').trim() || process.arch;
  const target = availableTargets.find((candidate) => candidate.os === normalizedPlatform && candidate.arch === normalizedArch);
  if (!target) {
    throw new Error(
      `[component-artifacts] unsupported binary target for current platform: ${normalizedPlatform}-${normalizedArch}`,
    );
  }
  return target;
}

export function resolveExecutableName({ baseName, target }: { baseName: string; target: BinaryTarget }): string {
  return `${baseName}${target.exeExt}`;
}
