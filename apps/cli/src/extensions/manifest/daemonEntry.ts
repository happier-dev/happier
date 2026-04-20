import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import type { PluginCompatibilityDiagnostic } from '../diagnostics/types';
import type { CanonicalPluginManifest } from './types';

const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

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
  | { ok: true; daemonEntryPath: string | null }
  | { ok: false; diagnostic: PluginCompatibilityDiagnostic }
>;

export async function resolvePluginDaemonEntryPath(params: Readonly<{
  pluginRootPath: string;
  manifest: CanonicalPluginManifest;
}>): Promise<ResolvePluginDaemonEntryPathResult> {
  // `realpath(...)` canonicalizes symlinks on macOS (e.g. `/var` -> `/private/var`).
  // Canonicalize the root too so containment checks don't falsely fail due to
  // non-canonical-but-equivalent root strings.
  const canonicalPluginRootPath = await resolveCanonicalExistingPath(params.pluginRootPath) ?? params.pluginRootPath;

  const daemonEntry = params.manifest.targets.daemon?.entry;
  if (!daemonEntry) {
    return {
      ok: true,
      daemonEntryPath: null,
    };
  }

  const resolvedPath = resolve(canonicalPluginRootPath, daemonEntry);
  const extension = extname(resolvedPath).toLowerCase();
  if (!SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_source_kind_unsupported',
        message: `Unsupported plugin daemon entry extension '${extension || '<none>'}' for '${daemonEntry}'`,
      },
    };
  }

  const canonicalResolvedPath = await resolveCanonicalExistingPath(resolvedPath);
  const containmentPath = canonicalResolvedPath ?? resolvedPath;
  if (!isPathInsideRoot(canonicalPluginRootPath, containmentPath)) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin daemon entry '${daemonEntry}' escapes the plugin root`,
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
          message: `Plugin daemon entry does not exist: ${containmentPath}`,
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
        message: `Plugin daemon entry must resolve to a file: ${containmentPath}`,
      },
    };
  }

  return {
    ok: true,
    daemonEntryPath: containmentPath,
  };
}
