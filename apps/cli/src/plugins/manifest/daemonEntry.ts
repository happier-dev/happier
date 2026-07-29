import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative } from 'node:path';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { resolvePortablePluginRelativePath } from './portableRelativePath';
import type { CanonicalPluginManifest } from './types';

const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SUPPORTED_PLUGIN_DEV_DAEMON_ENTRY_EXTENSIONS = new Set([
  ...SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS,
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]);

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function resolveCanonicalExistingPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export type ResolvePluginDaemonEntryPathResult = Readonly<
  | { ok: true; daemonEntryPath: string | null; devDaemonEntryPath: string | null }
  | { ok: false; diagnostic: PluginCompatibilityDiagnostic }
>;

export function shouldResolvePluginDevelopmentEntrypoint(record: Readonly<{
  source: Readonly<{ kind: string; devWatch?: boolean }>;
  install: Readonly<{ mode: string }>;
}>): boolean {
  return record.source.kind === 'path'
    && (record.source.devWatch === true || record.install.mode === 'link');
}

async function resolveEntrypointPath(params: Readonly<{
  pluginRootPath: string;
  entry: string;
  label: 'daemon entry' | 'daemon dev entry';
  supportedExtensions: ReadonlySet<string>;
}>): Promise<Readonly<{ ok: true; entryPath: string } | { ok: false; diagnostic: PluginCompatibilityDiagnostic }>> {
  const portableResolution = resolvePortablePluginRelativePath({
    rootPath: params.pluginRootPath,
    value: params.entry,
    label: params.label,
  });
  if (!portableResolution.ok) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin ${portableResolution.message}`,
      },
    };
  }
  const resolvedPath = portableResolution.path;
  const extension = extname(resolvedPath).toLowerCase();
  if (!params.supportedExtensions.has(extension)) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_source_kind_unsupported',
        message: `Unsupported plugin ${params.label} extension '${extension || '<none>'}' for '${params.entry}'`,
      },
    };
  }

  const canonicalResolvedPath = await resolveCanonicalExistingPath(resolvedPath);
  const containmentPath = canonicalResolvedPath ?? resolvedPath;
  if (!isPathInsideRoot(params.pluginRootPath, containmentPath)) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin ${params.label} '${params.entry}' escapes the plugin root`,
      },
    };
  }

  let daemonEntryStats: Awaited<ReturnType<typeof stat>>;
  try {
    daemonEntryStats = await stat(containmentPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        diagnostic: {
          code: 'plugin_source_missing',
          message: `Plugin ${params.label} does not exist: ${containmentPath}`,
        },
      };
    }
    throw error;
  }

  if (!daemonEntryStats.isFile()) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_source_kind_unsupported',
        message: `Plugin ${params.label} must resolve to a file: ${containmentPath}`,
      },
    };
  }

  return { ok: true, entryPath: containmentPath };
}

export async function resolvePluginDaemonEntryPath(params: Readonly<{
  pluginRootPath: string;
  manifest: CanonicalPluginManifest;
  resolveDevEntrypoint?: boolean;
}>): Promise<ResolvePluginDaemonEntryPathResult> {
  // `realpath(...)` canonicalizes symlinks on macOS (e.g. `/var` -> `/private/var`).
  // Canonicalize the root too so containment checks don't falsely fail due to
  // non-canonical-but-equivalent root strings.
  const canonicalPluginRootPath = await resolveCanonicalExistingPath(params.pluginRootPath) ?? params.pluginRootPath;

  const daemonEntry = params.manifest.entrypoints?.daemon;
  const declaredDevEntry = params.manifest.entrypoints?.development?.trim() ?? '';
  if (!daemonEntry && declaredDevEntry && !params.resolveDevEntrypoint) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_source_kind_unsupported',
        message: 'A development-only daemon entrypoint requires an active development path source',
      },
    };
  }
  let devDaemonEntryPath: string | null = null;
  const devEntry = params.resolveDevEntrypoint ? declaredDevEntry : '';
  if (devEntry) {
    const devEntryResolution = await resolveEntrypointPath({
      pluginRootPath: canonicalPluginRootPath,
      entry: devEntry,
      label: 'daemon dev entry',
      supportedExtensions: SUPPORTED_PLUGIN_DEV_DAEMON_ENTRY_EXTENSIONS,
    });
    if (!devEntryResolution.ok) {
      return devEntryResolution;
    }
    devDaemonEntryPath = devEntryResolution.entryPath;
  }

  let daemonEntryPath: string | null = null;
  if (daemonEntry) {
    const daemonEntryResolution = await resolveEntrypointPath({
      pluginRootPath: canonicalPluginRootPath,
      entry: daemonEntry,
      label: 'daemon entry',
      supportedExtensions: SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS,
    });
    if (!daemonEntryResolution.ok) {
      // A fresh development scaffold intentionally has source before its first
      // production build. Ignore only that missing-build case; malformed,
      // escaping, or unsupported production entries still fail closed.
      if (!(devDaemonEntryPath && daemonEntryResolution.diagnostic.code === 'plugin_source_missing')) {
        return daemonEntryResolution;
      }
    } else {
      daemonEntryPath = daemonEntryResolution.entryPath;
    }
  }

  return {
    ok: true,
    daemonEntryPath,
    devDaemonEntryPath,
  };
}
