export type PypiWheelAssetSupportedPlatform =
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64'
  | 'win32-arm64';

export type PypiWheelAssetHostPlatform =
  | PypiWheelAssetSupportedPlatform
  | 'darwin-x64';

export type PypiWheelAssetLinuxLibc = 'glibc' | 'musl' | 'unknown';

export type PypiWheelAssetHostCompatibility =
  | Readonly<{
    ok: true;
    platform: PypiWheelAssetSupportedPlatform;
    linuxLibc?: PypiWheelAssetLinuxLibc;
  }>
  | Readonly<{
    ok: false;
    code: 'unsupported_platform';
    message: string;
    platform?: PypiWheelAssetHostPlatform;
    linuxLibc?: PypiWheelAssetLinuxLibc;
  }>;

export type PypiWheelAssetDiagnosticCode =
  | 'unsupported_platform'
  | 'unsupported_version_specifier'
  | 'no_compatible_wheel'
  | 'missing_digest'
  | 'wheel_digest_mismatch'
  | 'wheel_download_failed'
  | 'wheel_size_exceeded'
  | 'wheel_asset_not_found'
  | 'wheel_asset_traversal'
  | 'wheel_asset_absolute_path'
  | 'wheel_asset_directory'
  | 'wheel_asset_symlink'
  | 'wheel_asset_duplicate_member'
  | 'wheel_asset_oversize'
  | 'wheel_asset_unsupported_compression'
  | 'wheel_asset_corrupt'
  | 'compatibility_probe_failed'
  | 'promotion_failed';

export class PypiWheelAssetError extends Error {
  public readonly code: PypiWheelAssetDiagnosticCode;

  public constructor(code: PypiWheelAssetDiagnosticCode, message: string) {
    super(message);
    this.name = 'PypiWheelAssetError';
    this.code = code;
  }
}

export type PypiWheelAssetPlatformMap = Readonly<Partial<Record<PypiWheelAssetSupportedPlatform, string>>>;
