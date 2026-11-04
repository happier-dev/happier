import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { quoteRemotePathWithHomeExpansion } from '../../ssh/shellQuote.js';
import { resolveRetainedVersionIds } from '../../firstPartyRuntime/retentionPolicy.js';
import { FIRST_PARTY_VERSION_UNUSED_SHELL_FUNCTION } from '../../firstPartyRuntime/versionUse.js';
import { compareVersions } from '../../update/compareVersions.js';

import {
  getFirstPartyComponentCatalogEntry,
  resolveFirstPartyComponentPublicReleaseVariant,
  type FirstPartyComponentId,
} from '../../firstPartyRuntime/componentCatalog.js';

function normalizeBootstrapReleaseChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
}

export function normalizeRemoteFirstPartyHomeDir(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  const normalized = trimmed || '$HOME/.happier';
  if (normalized === '~') {
    return '$HOME';
  }
  if (normalized.startsWith('~/')) {
    return normalizeRemoteFirstPartyHomeDir(`$HOME${normalized.slice(1)}`);
  }
  if (normalized.startsWith('$HOME')) {
    const rest = normalized.slice('$HOME'.length);
    if (rest && !rest.startsWith('/')) {
      throw new Error(`Unsupported remote home dir: ${normalized}`);
    }
    const segments = rest
      ? rest.slice(1).split('/').filter(Boolean)
      : [];
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  if (normalized.startsWith('/')) {
    const segments = normalized.slice(1).split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  throw new Error(`Unsupported remote home dir: ${normalized}`);
}

export function sanitizeRemoteFirstPartyPathSegment(value: string): string {
  const sanitized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  if (sanitized === '.' || sanitized === '..') throw new Error('Invalid remote first-party path segment.');
  return sanitized || 'payload';
}

export type RemoteFirstPartyInstallLayout = Readonly<{
  remoteHomeDir: string;
  installRoot: string;
  versionsDir: string;
  versionDir: string;
  currentPath: string;
  previousPath: string;
  binaryPath: string;
}>;

export function resolveRemoteFirstPartyInstallLayout(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  versionId: string;
  remoteHomeDir?: string;
}>): RemoteFirstPartyInstallLayout {
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel,
  });
  const remoteHomeDir = normalizeRemoteFirstPartyHomeDir(params.remoteHomeDir);
  const installRoot = `${remoteHomeDir}/${variant.installRootName}`;
  const versionsDir = `${installRoot}/versions`;
  const currentPath = `${installRoot}/current`;
  return {
    remoteHomeDir,
    installRoot,
    versionsDir,
    versionDir: `${versionsDir}/${sanitizeRemoteFirstPartyPathSegment(params.versionId)}`,
    currentPath,
    previousPath: `${installRoot}/previous`,
    binaryPath: `${currentPath}/${component.binaryRelativePath}`,
  };
}

export function buildRemoteFirstPartyPromotionCommand(params: Readonly<{
  layout: RemoteFirstPartyInstallLayout;
  payloadRootExpression: string;
}>): string {
  const payloadRootExpression = String(params.payloadRootExpression ?? '').trim();
  if (!payloadRootExpression) {
    throw new Error('Remote first-party payload root is required.');
  }
  const layout = params.layout;
  const versionsDir = quoteRemotePathWithHomeExpansion(layout.versionsDir);
  const versionDir = quoteRemotePathWithHomeExpansion(layout.versionDir);
  const currentPath = quoteRemotePathWithHomeExpansion(layout.currentPath);
  const previousPath = quoteRemotePathWithHomeExpansion(layout.previousPath);
  const versionBinaryPath = quoteRemotePathWithHomeExpansion(`${layout.versionDir}${layout.binaryPath.slice(layout.currentPath.length)}`);
  return [
    'set -eu',
    buildRemoteFirstPartyProtectedVersionFunction(layout),
    // Validate before touching a version or either activation pointer.
    `test -f ${payloadRootExpression}${layout.binaryPath.slice(layout.currentPath.length)}`,
    `if is_protected_version ${versionDir}; then test -x ${versionBinaryPath}; else mkdir -p ${versionsDir}`,
    `test ! -L ${versionsDir}`,
    `rm -rf ${versionDir}`,
    // Both remote strategies stage under the install home; consume that extracted
    // tree without allocating a second full payload on the guest filesystem.
    `mv ${payloadRootExpression} ${versionDir}`,
    `chmod +x ${versionBinaryPath}`,
    'fi',
    `if [ ! ${versionDir} -ef ${currentPath} ]; then if [ -L ${currentPath} ]; then prev="$(readlink ${currentPath} || true)"; if [ -n "$prev" ]; then ln -sfn "$prev" ${previousPath}; fi; fi`,
    `ln -sfn ${versionDir} ${currentPath}`,
    'fi',
  ].join('; ');
}

function buildRemoteFirstPartyProtectedVersionFunction(layout: RemoteFirstPartyInstallLayout): string {
  const current = quoteRemotePathWithHomeExpansion(layout.currentPath);
  const previous = quoteRemotePathWithHomeExpansion(layout.previousPath);
  return `is_protected_version() { current_target="$(readlink ${current} || true)"; previous_target="$(readlink ${previous} || true)"; [ "$1" -ef ${current} ] || [ "$1" -ef ${previous} ] || [ "\${1##*/}" = "\${current_target##*/}" ] || [ "\${1##*/}" = "\${previous_target##*/}" ]; }`;
}

export function buildRemoteFirstPartyVersionInventoryCommand(layout: RemoteFirstPartyInstallLayout): string {
  const versions = quoteRemotePathWithHomeExpansion(layout.versionsDir);
  return [
    'set -eu',
    `test ! -L ${versions}`,
    `current_target="$(readlink ${quoteRemotePathWithHomeExpansion(layout.currentPath)} || true)"`,
    `previous_target="$(readlink ${quoteRemotePathWithHomeExpansion(layout.previousPath)} || true)"`,
    'printf "current=%s\\nprevious=%s\\n" "${current_target##*/}" "${previous_target##*/}"',
    `for version_path in ${versions}/*; do if [ -d "$version_path" ] && [ ! -L "$version_path" ]; then printf 'version=%s\\n' "\${version_path##*/}"; fi; done`,
  ].join('; ');
}

/** The controller evaluates the local retention owner; the remote shell only applies its prune set. */
export function buildRemoteFirstPartyRetentionCommand(params: Readonly<{
  layout: RemoteFirstPartyInstallLayout;
  inventory: string;
}>): string | null {
  let currentVersionId: string | null = null;
  let previousVersionId: string | null = null;
  const versionIds: string[] = [];
  for (const line of params.inventory.split('\n').filter(Boolean)) {
    const match = /^(current|previous|version)=([A-Za-z0-9._-]*)$/u.exec(line);
    if (!match || match[2] === '.' || match[2] === '..') throw new Error('Invalid remote version inventory.');
    const id = match[2] || null;
    if (match[1] === 'current') currentVersionId = id;
    if (match[1] === 'previous') previousVersionId = id;
    if (match[1] === 'version' && id) versionIds.push(id);
  }
  const { prune } = resolveRetainedVersionIds({
    orderedVersionIdsNewestFirst: versionIds.sort((left, right) => compareVersions(right, left)),
    currentVersionId,
    previousVersionId,
  });
  if (prune.length === 0) return null;
  return [
    'set -eu',
    `test ! -L ${quoteRemotePathWithHomeExpansion(params.layout.versionsDir)}`,
    buildRemoteFirstPartyProtectedVersionFunction(params.layout),
    FIRST_PARTY_VERSION_UNUSED_SHELL_FUNCTION,
    ...prune.map((id) => {
      // Keep the candidate out of this shell's argv as a complete path, so
      // native PID observation does not mistake the reaper for a payload user.
      const path = `${quoteRemotePathWithHomeExpansion(params.layout.versionsDir)}/${quoteRemotePathWithHomeExpansion(id)}`;
      return `retention_path=${path}; if [ -d "$retention_path" ] && [ ! -L "$retention_path" ] && ! is_protected_version "$retention_path" && is_version_unused "$retention_path"; then rm -rf "$retention_path"; fi`;
    }),
  ].join('; ');
}

export async function pruneRemoteFirstPartyVersions(params: Readonly<{
  layout: RemoteFirstPartyInstallLayout;
  runRemoteText: (command: string) => Promise<Readonly<{ status: number; stdout: string }>>;
}>): Promise<void> {
  const inventory = await params.runRemoteText(buildRemoteFirstPartyVersionInventoryCommand(params.layout));
  if (inventory.status !== 0) throw new Error('Remote version inventory failed.');
  const command = buildRemoteFirstPartyRetentionCommand({ layout: params.layout, inventory: inventory.stdout });
  if (!command) return;
  const result = await params.runRemoteText(command);
  if (result.status !== 0) throw new Error('Remote version retention failed.');
}

export function resolveRemoteInstalledFirstPartyBinaryPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  remoteHomeDir?: string;
}>): string {
  return resolveRemoteFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    versionId: 'current',
    remoteHomeDir: params.remoteHomeDir,
  }).binaryPath;
}

export function normalizeRemoteReleaseOs(value: unknown): 'linux' | 'darwin' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('darwin')) return 'darwin';
  if (normalized.includes('linux')) return 'linux';
  throw new Error(`Unsupported remote bootstrap platform: ${normalized || 'unknown'}`);
}

export function normalizeRemoteReleaseArch(value: unknown): 'x64' | 'arm64' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64' || normalized === 'x64') return 'x64';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  throw new Error(`Unsupported remote bootstrap architecture: ${normalized || 'unknown'}`);
}
