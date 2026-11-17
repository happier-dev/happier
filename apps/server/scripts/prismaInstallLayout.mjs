import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {string} serverRoot */
function serverPackageResolver(serverRoot) {
  const requireFromServer = createRequire(pathToFileURL(join(serverRoot, 'package.json')).href);
  return (/** @type {string} */ specifier) => requireFromServer.resolve(specifier);
}

/** Real path of `path`, or of its nearest existing ancestor joined with the rest. */
function realPathOrSelf(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (existsSync(absolute)) return realpathSync(absolute);
  return parent === absolute ? absolute : join(realPathOrSelf(parent), absolute.slice(parent.length));
}

/** @param {string} root @param {string} path */
function isWithin(root, path) {
  const rel = relative(realPathOrSelf(root), realPathOrSelf(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where the server's Prisma client lives. The package manager decides where `@prisma/client` is
 * installed (the hoisted pnpm linker keeps it under apps/server/node_modules), so generation,
 * packaging and the source runtime resolve it from the server package. Prisma generates the
 * default client into `.prisma/client` of the `node_modules` that holds `@prisma/client`
 * (`@prisma/client/default.js` requires `.prisma/client/default`).
 *
 * That installed client belongs to this checkout only when it is installed inside it. A snapshot
 * or worktree whose `node_modules` links into another checkout must never regenerate that
 * checkout's client from its own schema (it silently swaps the live server's model for every
 * lane), so its default client is run-local: `apps/server/generated/default-client`, beside the
 * SQLite/MySQL clients.
 *
 * @param {{ serverRoot: string; resolveInstalledPath?: (specifier: string) => string }} params
 */
export function resolveServerPrismaInstallLayout({ serverRoot, resolveInstalledPath }) {
  const resolvePath = resolveInstalledPath ?? serverPackageResolver(serverRoot);
  const clientPackageDir = dirname(resolvePath('@prisma/client/package.json'));
  const installedDefaultClientDir = join(clientPackageDir, '..', '..', '.prisma', 'client');
  const ownsInstalledClient = isWithin(join(serverRoot, '..', '..'), clientPackageDir);
  return {
    clientPackageDir,
    clientRuntimePath: join(clientPackageDir, 'runtime', 'client.js'),
    ownsInstalledClient,
    defaultClientDir: ownsInstalledClient ? installedDefaultClientDir : join(serverRoot, 'generated', 'default-client'),
  };
}

/**
 * The packaged `prisma-migrate` tool. It stays on the Prisma 6.19.2 CLI (declared by the server
 * under the `prisma-migrate-cli` alias) because the 7.x schema engine runs a PostgreSQL
 * migration.sql statement by statement instead of as one implicit transaction. The CLI reads
 * its schema WASM beside its build output; its bundle takes node-fetch-native's proxy stub from
 * the node-fetch-native installed for it.
 *
 * @param {{ serverRoot: string; resolveInstalledPath?: (specifier: string) => string }} params
 */
export function resolveServerPrismaMigrationToolLayout({ serverRoot, resolveInstalledPath }) {
  const resolvePath = resolveInstalledPath ?? serverPackageResolver(serverRoot);
  const cliPackageJsonPath = resolvePath('prisma-migrate-cli/package.json');
  const cliPackageDir = dirname(cliPackageJsonPath);
  const nodeFetchNativeDir = (createRequire(cliPackageJsonPath).resolve.paths('node-fetch-native') ?? [])
    .map((searchPath) => join(searchPath, 'node-fetch-native'))
    .find((candidate) => existsSync(join(candidate, 'dist', 'proxy-stub.mjs')));
  if (!nodeFetchNativeDir) {
    throw new Error(`node-fetch-native is not installed for the Prisma migration CLI at ${cliPackageDir}`);
  }
  return {
    cliPackageJsonPath,
    cliPackageDir,
    cliEntrypoint: join(cliPackageDir, 'build', 'index.js'),
    schemaWasmPath: join(cliPackageDir, 'build', 'prisma_schema_build_bg.wasm'),
    nodeFetchNativeDir,
    proxyStubPath: join(nodeFetchNativeDir, 'dist', 'proxy-stub.mjs'),
  };
}
