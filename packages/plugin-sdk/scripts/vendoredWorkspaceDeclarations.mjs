import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const VENDOR_SCOPE = '@happier-dev';
const DECLARATION_SUFFIXES = Object.freeze(['.d.ts', '.d.mts', '.d.cts']);
const REFRESH_COMMAND = 'node ./scripts/bundleWorkspaceDeps.mjs --declarations';
const REPORTED_DIVERGENCE_LIMIT = 5;
const WORKSPACE_SYNC_STAGING_DIRECTORY_PATTERN = /^\.[a-z0-9][a-z0-9._-]*\.__sync_(?:tmp|backup)__\..+$/u;
export const VENDORED_WORKSPACE_DECLARATION_IDENTITY_ENV_VAR = 'HAPPIER_PLUGIN_SDK_VENDORED_DECLARATION_IDENTITY';

function isWorkspaceSyncStagingDirectory(name) {
  return WORKSPACE_SYNC_STAGING_DIRECTORY_PATTERN.test(name);
}

/**
 * Walks up from `startDir` to the repository root — the nearest ancestor that
 * owns `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml`. Returns `null` when
 * there is none, so a caller outside a monorepo checkout (an installed package,
 * a fixture tree) can tell that apart from a located root instead of acting on
 * a guessed ancestor.
 */
export function findRepoRoot(startDir) {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'pnpm-lock.yaml')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function collectDeclarationDigests(distDir) {
  const digests = new Map();
  const pending = [distDir];
  while (pending.length > 0) {
    const current = pending.shift();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!DECLARATION_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      const contents = await readFile(absolutePath).catch(() => null);
      if (contents === null) continue;
      digests.set(
        relative(distDir, absolutePath).split(sep).join('/'),
        createHash('sha256').update(contents).digest('hex'),
      );
    }
  }
  return digests;
}

function describeDivergences(vendored, workspace) {
  const divergences = [];
  for (const [relativePath, digest] of [...vendored].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    const workspaceDigest = workspace.get(relativePath);
    if (workspaceDigest === undefined) {
      divergences.push(`dist/${relativePath} (vendored copy retains a declaration the workspace build no longer produces)`);
    } else if (workspaceDigest !== digest) {
      divergences.push(`dist/${relativePath} (vendored copy differs from the workspace build)`);
    }
  }
  for (const relativePath of [...workspace.keys()].sort()) {
    if (vendored.has(relativePath)) continue;
    divergences.push(`dist/${relativePath} (workspace build produces a declaration the vendored copy is missing)`);
  }
  return divergences;
}

function staleVendoredDeclarationsError(packageName, divergences) {
  const shown = divergences.slice(0, REPORTED_DIVERGENCE_LIMIT);
  const remaining = divergences.length - shown.length;
  return new Error([
    `Vendored ${packageName} declarations under packages/plugin-sdk/node_modules are stale against the workspace build.`,
    'The plugin SDK typechecks and reads types through that physical copy, so a workspace change stays invisible until it is republished.',
    ...shown.map((divergence) => `- ${divergence}`),
    ...(remaining > 0 ? [`- …and ${remaining} more`] : []),
    `Refresh it from packages/plugin-sdk with: ${REFRESH_COMMAND}`,
  ].join('\n'));
}

async function readVendoredWorkspaceDeclarations(packageRoot) {
  const vendorScopeRoot = join(resolve(packageRoot), 'node_modules', VENDOR_SCOPE);
  const entries = await readdir(vendorScopeRoot, { withFileTypes: true }).catch(() => []);
  const declarations = [];
  for (const entry of entries) {
    // Copier staging directories and workspace links are not physical copies.
    if (isWorkspaceSyncStagingDirectory(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const vendoredRoot = join(vendorScopeRoot, entry.name);
    const metadata = await readFile(join(vendoredRoot, 'package.json'), 'utf8')
      .then(contents => JSON.parse(contents)).catch(() => null);
    declarations.push({
      name: entry.name,
      packageName: typeof metadata?.name === 'string' && metadata.name ? metadata.name : `${VENDOR_SCOPE}/${entry.name}`,
      digests: await collectDeclarationDigests(join(vendoredRoot, 'dist')),
    });
  }
  return declarations;
}

function vendoredDeclarationIdentity(packageRoot, declarations) {
  return createHash('sha256').update(JSON.stringify([
    resolve(packageRoot),
    declarations.map(({ name, packageName, digests }) => [name, packageName,
      [...digests].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    ]).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ])).digest('hex');
}

/** Record only the admitted copy. A later producer publication is not a veto. */
export async function captureVendoredWorkspaceDeclarationIdentity({ packageRoot }) {
  return vendoredDeclarationIdentity(packageRoot, await readVendoredWorkspaceDeclarations(packageRoot));
}

/**
 * Fails when the physical `@happier-dev/*` copies `bundleWorkspaceDeps`
 * publishes under this package's own `node_modules` no longer match the
 * workspace build they were copied from.
 *
 * The copies are what the SDK's compiler, tests and API-surface run actually
 * resolve. Live-mode bundling never prunes, so a stale copy silently answers
 * every type question with the previous workspace build — which has already
 * produced one false-green compile-time closure assertion and two failed
 * inventory runs. A resolution that goes through the yarn workspace symlink has
 * no copy to go stale and is accepted unchanged, and outside a monorepo
 * checkout — an installed package, a fixture tree — there is no workspace build
 * for a copy to diverge from, so there is nothing to assert. A prepared writer
 * may retain its admitted copy after a later workspace publication; its exact
 * declaration identity is carried by the SDK adapter. Checks remain strict.
 */
export async function assertVendoredWorkspaceDeclarationsAreCurrent({
  packageRoot,
  repoRoot = findRepoRoot(packageRoot),
  env = process.env,
  allowCapturedPublication = false,
}) {
  if (!repoRoot) return;
  const vendored = await readVendoredWorkspaceDeclarations(packageRoot);
  const staleDeclarations = [];

  for (const { packageName, digests } of vendored) {
    const workspaceRoot = await realpath(join(resolve(repoRoot), 'node_modules', ...packageName.split('/')))
      .catch(() => null);
    if (!workspaceRoot) {
      throw new Error([
        `Vendored ${packageName} declarations under packages/plugin-sdk/node_modules cannot be checked against a workspace build.`,
        `The workspace link ${join('node_modules', ...packageName.split('/'))} is missing, so the vendored copy is the only answer to every type question and its freshness is unknowable.`,
        'Restore the workspace links with: yarn install',
      ].join('\n'));
    }

    const divergences = describeDivergences(
      digests,
      await collectDeclarationDigests(join(workspaceRoot, 'dist')),
    );
    if (divergences.length > 0) staleDeclarations.push(staleVendoredDeclarationsError(packageName, divergences));
  }
  const identity = vendoredDeclarationIdentity(packageRoot, vendored);
  if (staleDeclarations.length > 0) {
    if (!allowCapturedPublication || env[VENDORED_WORKSPACE_DECLARATION_IDENTITY_ENV_VAR] !== identity) {
      throw staleDeclarations[0];
    }
    console.info('[plugin-sdk] Workspace declarations advanced after vendoring; publishing the captured copy. The next demand will refresh it.');
  }
}
