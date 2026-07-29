export const PI_REQUEST_AUTH_MINIMUM_VERSION = '0.81.0';

export type PiRequestAuthCompatibility =
  | Readonly<{
      supported: true;
      version: string;
    }>
  | Readonly<{
      supported: false;
      reason: 'version_too_old';
      version: string;
      minimumVersion: typeof PI_REQUEST_AUTH_MINIMUM_VERSION;
    }>
  | Readonly<{
      supported: false;
      reason: 'version_unreadable';
      minimumVersion: typeof PI_REQUEST_AUTH_MINIMUM_VERSION;
    }>;

export class PiRequestAuthCompatibilityError extends Error {
  readonly code = 'pi_request_auth_version_unsupported';

  constructor(readonly compatibility: Exclude<PiRequestAuthCompatibility, { supported: true }>) {
    const observed = compatibility.reason !== 'version_unreadable'
      ? ` (observed ${compatibility.version})`
      : '';
    super(
      'Connected-account request auth requires Pi '
      + `${PI_REQUEST_AUTH_MINIMUM_VERSION} or newer${observed}. `
      + 'Select a supported Pi release or a direct/native credential.',
    );
    this.name = 'PiRequestAuthCompatibilityError';
  }
}

type ParsedVersion = Readonly<{
  version: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}>;

// Restrict matches to observed CLI token boundaries so malformed suffixes cannot
// be truncated into an exact version admitted by the pinned Level-B frontier.
const SEMANTIC_VERSION_PATTERN =
  /(?:^|[\s/])v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?=$|\s)/g;

function parseVersionOutput(output: string): ParsedVersion | null {
  const matches = [...output.trim().matchAll(SEMANTIC_VERSION_PATTERN)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.slice(1) ?? null;
  const buildMetadata = match[5] ?? '';
  return {
    version:
      `${major}.${minor}.${patch}${prerelease === null ? '' : `-${prerelease}`}${buildMetadata}`,
    major,
    minor,
    patch,
    prerelease,
  };
}

function isAtLeastMinimum(version: ParsedVersion): boolean {
  if (version.prerelease !== null) return false;
  const minimum = [0, 81, 0] as const;
  const candidate = [version.major, version.minor, version.patch] as const;
  for (let index = 0; index < minimum.length; index += 1) {
    if (candidate[index] > minimum[index]) return true;
    if (candidate[index] < minimum[index]) return false;
  }
  return true;
}

export function resolvePiRequestAuthCompatibility(output: string): PiRequestAuthCompatibility {
  const parsed = parseVersionOutput(output);
  if (!parsed) {
    return {
      supported: false,
      reason: 'version_unreadable',
      minimumVersion: PI_REQUEST_AUTH_MINIMUM_VERSION,
    };
  }
  if (!isAtLeastMinimum(parsed)) {
    return {
      supported: false,
      reason: 'version_too_old',
      version: parsed.version,
      minimumVersion: PI_REQUEST_AUTH_MINIMUM_VERSION,
    };
  }
  return {
    supported: true,
    version: parsed.version,
  };
}
