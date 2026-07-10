import type {
  PypiWheelAssetHostCompatibility,
  PypiWheelAssetHostPlatform,
  PypiWheelAssetLinuxLibc,
  PypiWheelAssetSupportedPlatform,
} from './types.js';

type HostPlatformInput = Readonly<{
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  linuxLibc?: PypiWheelAssetLinuxLibc;
  report?: unknown;
}>;

function unsupported(params: Readonly<{
  platform?: PypiWheelAssetHostPlatform;
  linuxLibc?: PypiWheelAssetLinuxLibc;
  message: string;
}>): PypiWheelAssetHostCompatibility {
  return {
    ok: false,
    code: 'unsupported_platform',
    message: params.message,
    ...(params.platform ? { platform: params.platform } : {}),
    ...(params.linuxLibc ? { linuxLibc: params.linuxLibc } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readReport(inputReport: unknown): unknown {
  if (inputReport !== undefined) return inputReport;
  try {
    return process.report?.getReport?.();
  } catch {
    return null;
  }
}

function detectLinuxLibc(input: HostPlatformInput): PypiWheelAssetLinuxLibc {
  if (input.linuxLibc) return input.linuxLibc;
  const report = readReport(input.report);
  if (!isRecord(report)) return 'unknown';
  const header = isRecord(report.header) ? report.header : {};
  if (typeof header.glibcVersionRuntime === 'string' && header.glibcVersionRuntime.trim()) {
    return 'glibc';
  }

  const sharedObjects = Array.isArray(report.sharedObjects) ? report.sharedObjects : [];
  if (sharedObjects.some((entry) => typeof entry === 'string' && /(?:ld-musl|libc\.musl|musl-)/i.test(entry))) {
    return 'musl';
  }
  return 'unknown';
}

function supported(platform: PypiWheelAssetSupportedPlatform, linuxLibc?: PypiWheelAssetLinuxLibc): PypiWheelAssetHostCompatibility {
  return {
    ok: true,
    platform,
    ...(linuxLibc ? { linuxLibc } : {}),
  };
}

export function resolvePypiWheelAssetHostCompatibility(input: HostPlatformInput = {}): PypiWheelAssetHostCompatibility {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;

  if (platform === 'darwin' && arch === 'arm64') return supported('darwin-arm64');
  if (platform === 'darwin' && arch === 'x64') {
    return unsupported({
      platform: 'darwin-x64',
      message: '[pypi-wheel-asset] unsupported platform darwin-x64',
    });
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    const hostPlatform = arch === 'x64' ? 'linux-x64' : 'linux-arm64';
    const linuxLibc = detectLinuxLibc(input);
    if (linuxLibc !== 'glibc' && linuxLibc !== 'musl') {
      return unsupported({
        platform: hostPlatform,
        linuxLibc,
        message: `[pypi-wheel-asset] unsupported Linux libc for ${hostPlatform}: ${linuxLibc}`,
      });
    }
    return supported(hostPlatform, linuxLibc);
  }
  if (platform === 'win32' && arch === 'x64') return supported('win32-x64');
  if (platform === 'win32' && arch === 'arm64') return supported('win32-arm64');

  return unsupported({
    message: `[pypi-wheel-asset] unsupported platform ${platform}/${arch}`,
  });
}
