export type SessionHandoffWorkspaceTransferPathSafetyReasonCode =
  | 'missing_source_path'
  | 'path_is_not_absolute'
  | 'path_is_filesystem_root'
  | 'path_is_home_directory';

export type SessionHandoffWorkspaceTransferPathSafety = Readonly<
  | {
      allowed: true;
      reasonCode: null;
    }
  | {
      allowed: false;
      reasonCode: SessionHandoffWorkspaceTransferPathSafetyReasonCode;
    }
>;

function normalizePath(value: unknown): string {
  const trimmed = trimPathInput(value);
  if (!trimmed) return '';
  const withForwardSlashes = trimmed.replace(/\\/g, '/');
  const normalizedDrivePrefix = /^[A-Z]:/.test(withForwardSlashes)
    ? `${withForwardSlashes.charAt(0).toLowerCase()}${withForwardSlashes.slice(1)}`
    : withForwardSlashes;
  if (normalizedDrivePrefix === '/') return normalizedDrivePrefix;
  if (/^[a-z]:\/?$/.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.endsWith('/') ? normalizedDrivePrefix : `${normalizedDrivePrefix}/`;
  }
  if (/^\/\/[^/]+\/[^/]+\/?$/.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.endsWith('/') ? normalizedDrivePrefix.slice(0, -1) : normalizedDrivePrefix;
  }
  return canonicalizePath(normalizedDrivePrefix.replace(/\/+$/, ''));
}

function canonicalizePath(path: string): string {
  if (!path) return '';

  const uncMatch = path.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  if (uncMatch) {
    return joinCanonicalPath(uncMatch[1], uncMatch[2] ?? '', true);
  }

  const driveMatch = path.match(/^([a-z]:\/)(.*)$/);
  if (driveMatch) {
    return joinCanonicalPath(driveMatch[1], driveMatch[2], true);
  }

  if (path.startsWith('/')) {
    return joinCanonicalPath('/', path.slice(1), true);
  }

  return joinCanonicalPath('', path, false);
}

function joinCanonicalPath(root: string, remainder: string, absolute: boolean): string {
  const segments: string[] = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
        continue;
      }
      if (!absolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return root;
  }

  if (!root) {
    return segments.join('/');
  }

  return root === '/' ? `/${segments.join('/')}` : `${root}${segments.join('/')}`;
}

function isFilesystemRoot(path: string): boolean {
  if (!path) return false;
  if (path === '/') return true;
  if (/^[a-z]:\/$/.test(path)) return true;
  return /^\/\/[^/]+\/[^/]+$/.test(path);
}

function isHomeDirectoryShorthand(path: string): boolean {
  return path === '~';
}

function trimPathInput(value: unknown): string {
  return String(value ?? '').trim();
}

function isAbsolutePathInput(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/')) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return true;
  }
  return /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(value);
}

export function evaluateSessionHandoffWorkspaceTransferSourcePathSafety(params: Readonly<{
  sourcePath: unknown;
  sourceHomeDir?: unknown;
  fallbackSourceHomeDir?: unknown;
}>): SessionHandoffWorkspaceTransferPathSafety {
  const rawSourcePath = trimPathInput(params.sourcePath);
  const sourcePath = normalizePath(rawSourcePath);
  if (!sourcePath) {
    return {
      allowed: false,
      reasonCode: 'missing_source_path',
    };
  }
  if (isHomeDirectoryShorthand(sourcePath)) {
    return {
      allowed: false,
      reasonCode: 'path_is_home_directory',
    };
  }
  if (!isAbsolutePathInput(rawSourcePath)) {
    return {
      allowed: false,
      reasonCode: 'path_is_not_absolute',
    };
  }
  if (isFilesystemRoot(sourcePath)) {
    return {
      allowed: false,
      reasonCode: 'path_is_filesystem_root',
    };
  }

  const sourceHomeDir = normalizePath(params.sourceHomeDir) || normalizePath(params.fallbackSourceHomeDir);
  if (sourceHomeDir && sourcePath === sourceHomeDir) {
    return {
      allowed: false,
      reasonCode: 'path_is_home_directory',
    };
  }

  return {
    allowed: true,
    reasonCode: null,
  };
}
