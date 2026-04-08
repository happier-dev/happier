import type { HappierInstallation, HappierService, HappierServiceRuntimeTarget } from './types.js';
import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from './runtimePathMatching.js';

function pathBasename(pathValue: string): string {
  const normalized = normalizeHappierRuntimePath(pathValue);
  if (!normalized) {
    return '';
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

function deriveStackRuntimeTarget(executablePath: string): HappierServiceRuntimeTarget | null {
  const normalized = normalizeHappierRuntimePath(executablePath);
  const match = normalized.match(/^(.*\/(?:\.happier|happier)\/stacks\/([^/]+)\/(?:cli|runtime\/current\/cli|runtime\/builds\/[^/]+\/cli))(?:\/.*)?$/u);
  if (!match) {
    return null;
  }
  const path = match[1] ?? '';
  const stackName = match[2] ?? '';
  if (!path) {
    return null;
  }
  return {
    id: `stack-runtime:${path}`,
    kind: 'stack-runtime',
    label: `Stack runtime (${stackName || pathBasename(path) || 'unknown'})`,
    path,
    executablePath: normalized,
    installationId: null,
    installationPath: null,
  };
}

function deriveSourceCheckoutTarget(executablePath: string): HappierServiceRuntimeTarget | null {
  const normalized = normalizeHappierRuntimePath(executablePath);
  const suffixes = [
    '/apps/cli/package-dist/index.mjs',
    '/apps/stack/bin/hstack.mjs',
  ];
  for (const suffix of suffixes) {
    if (!normalized.endsWith(suffix)) {
      continue;
    }
    const path = normalized.slice(0, -suffix.length);
    if (!path) {
      continue;
    }
    return {
      id: `source-checkout:${path}`,
      kind: 'source-checkout',
      label: `Source checkout (${pathBasename(path) || 'unknown'})`,
      path,
      executablePath: normalized,
      installationId: null,
      installationPath: null,
    };
  }
  return null;
}

function deriveManagedJsRuntimeTarget(executablePath: string): HappierServiceRuntimeTarget | null {
  const normalized = normalizeHappierRuntimePath(executablePath);
  const match = normalized.match(/^(.*\/(?:\.happier|happier)\/tools\/js-runtime\/current)(?:\/.*)?$/u);
  if (!match) {
    return null;
  }
  const path = match[1] ?? '';
  if (!path) {
    return null;
  }
  return {
    id: `managed-js-runtime:${path}`,
    kind: 'managed-js-runtime',
    label: 'Managed JS runtime',
    path,
    executablePath: normalized,
    installationId: null,
    installationPath: null,
  };
}

function deriveUnmatchedExecutableTarget(executablePath: string): HappierServiceRuntimeTarget | null {
  const normalized = normalizeHappierRuntimePath(executablePath);
  if (!normalized) {
    return null;
  }
  const segments = normalized.split('/');
  if (segments.length <= 1) {
    return null;
  }
  const path = segments.slice(0, -1).join('/') || '/';
  return {
    id: `unmatched-executable:${path}`,
    kind: 'unmatched-executable',
    label: `Executable target (${pathBasename(path) || 'unknown'})`,
    path,
    executablePath: normalized,
    installationId: null,
    installationPath: null,
  };
}

export function resolveHappierServiceRuntimeTarget(params: Readonly<{
  service: HappierService;
  installations: readonly HappierInstallation[];
}>): HappierServiceRuntimeTarget | null {
  const executablePath = normalizeHappierRuntimePath(params.service.executablePath);
  if (!executablePath) {
    return null;
  }

  for (const installation of params.installations) {
    const candidateRoots = [installation.path, installation.realPath]
      .map((value) => normalizeHappierRuntimePath(value))
      .filter(Boolean);
    const matchedRoot = candidateRoots.find((root) => isHappierRuntimePathWithinRoot(executablePath, root));
    if (!matchedRoot) {
      continue;
    }
    return {
      id: `installation:${installation.id}`,
      kind: 'installation',
      label: installation.path,
      path: installation.path,
      executablePath,
      installationId: installation.id,
      installationPath: installation.path,
    };
  }

  return (
    deriveStackRuntimeTarget(executablePath)
    ?? deriveSourceCheckoutTarget(executablePath)
    ?? deriveManagedJsRuntimeTarget(executablePath)
    ?? deriveUnmatchedExecutableTarget(executablePath)
  );
}
