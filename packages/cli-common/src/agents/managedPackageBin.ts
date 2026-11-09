import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

type ManagedPackageBinRequest = Readonly<{ workspaceDir: string; packageName: string; version: string; bin?: string }>;

/** Installed npm metadata owns its executable name; a missing/ambiguous bin is unavailable. */
function readManagedPackageBin(params: ManagedPackageBinRequest): Readonly<{ name: string; entry: string }> | null {
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(params.workspaceDir, 'node_modules', params.packageName, 'package.json'), 'utf8'));
    if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== params.packageName
      || !('version' in metadata) || metadata.version !== params.version || !('bin' in metadata)) return null;
    const bins = typeof metadata.bin === 'string'
      ? { [params.packageName.split('/').at(-1)!]: metadata.bin }
      : metadata.bin && typeof metadata.bin === 'object' && !Array.isArray(metadata.bin) ? metadata.bin : null;
    if (!bins) return null;
    const candidates = Object.entries(bins).filter(([, path]) => typeof path === 'string' && path.length > 0).map(([name]) => name);
    const bin = params.bin ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!bin || !candidates.includes(bin) || bin === '.' || bin === '..' || /[\\/]/.test(bin)) return null;
    const entry = (bins as Record<string, unknown>)[bin];
    return typeof entry === 'string' ? { name: bin, entry } : null;
  } catch { return null; }
}

export function resolveManagedPackageBin(params: ManagedPackageBinRequest): string | null {
  const selected = readManagedPackageBin(params);
  if (!selected) return null;
  try {
    accessSync(join(params.workspaceDir, 'node_modules', '.bin', process.platform === 'win32' ? `${selected.name}.cmd` : selected.name), process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return selected.name;
  } catch { return null; }
}

/** Select the same pinned npm bin without executing its PATH/shebang shell shim. */
export function resolveManagedPackageJavaScriptEntry(params: ManagedPackageBinRequest): string | null {
  const selected = readManagedPackageBin(params);
  if (!selected || /^(?:[A-Za-z]:)?[\\/]/.test(selected.entry)
    || selected.entry.split(/[\\/]/).some(segment => segment === '..' || segment === '')) return null;
  try {
    const root = realpathSync(join(params.workspaceDir, 'node_modules', params.packageName));
    const entry = realpathSync(join(root, selected.entry));
    const within = relative(root, entry);
    if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) return null;
    accessSync(entry, constants.R_OK);
    return entry;
  } catch { return null; }
}
