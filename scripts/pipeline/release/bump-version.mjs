#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// This writer owns component version paths, including lockstep packages.
export const componentVersionDirectories = Object.freeze({
  app: 'apps/ui', cli: 'apps/cli', server: 'apps/server',
  website: 'apps/website', stack: 'apps/stack',
});

export function validateExactVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
    throw new Error(`Invalid exact semver "${version}"`);
  }
  return version;
}

/** Plan before writing so batch callers can reject conflicting source/index changes first.
 * @param {{repoRoot: string, component: string, version?: string, bump?: string, source?: {readFile: (name: string) => string, exists: (name: string) => boolean, listDirectory: (name: string) => string[]}}} input
 */
export function planComponentVersion({ repoRoot, component, version, bump, source = {
  readFile: (name) => fs.readFileSync(path.join(repoRoot, name), 'utf8'),
  exists: (name) => fs.existsSync(path.join(repoRoot, name)),
  listDirectory: (name) => fs.readdirSync(path.join(repoRoot, name)),
} }) {
  if (!Object.hasOwn(componentVersionDirectories, component)) throw new Error(`--component must be one of: ${Object.keys(componentVersionDirectories).join(', ')}`);
  if ((version === undefined) === (bump === undefined)) throw new Error('Specify exactly one of --version or --bump.');
  if (bump !== undefined && !['none', 'patch', 'minor', 'major'].includes(bump)) throw new Error('--bump must be one of: none, patch, minor, major');
  const dir = componentVersionDirectories[component];
  if (!source.exists(dir)) throw new Error(`Missing component directory: ${dir}`);
  if (bump === 'none') return { version: 'SKIP', changes: [] };
  const read = source.readFile;
  const packagePaths = [`${dir}/package.json`];
  if (component === 'server') packagePaths.push('packages/relay-server/package.json');
  if (component === 'plugin_sdk') packagePaths.push('packages/plugin-ui/package.json');
  const packages = packagePaths.map((name) => ({ name, value: JSON.parse(read(name)) }));
  const currentVersion = String(packages[0].value.version ?? '').trim();
  if (!currentVersion) throw new Error(`Unable to determine current version for ${component}`);
  if (packages.some(({ value }) => value.version !== currentVersion)) {
    throw new Error(component === 'server' ? 'Server app and server runner versions must match.' : 'plugin-sdk and plugin-ui versions must match.');
  }
  let nextVersion = version;
  if (version !== undefined) validateExactVersion(version);
  else {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(currentVersion);
    if (!match) throw new Error(`Invalid semver "${currentVersion}"`);
    const parts = match.slice(1).map(Number);
    const index = { major: 0, minor: 1, patch: 2 }[bump];
    parts[index] += 1;
    for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
    nextVersion = parts.join('.');
  }
  const changes = packages.map(({ name, value }) => ({ path: name, content: `${JSON.stringify({ ...value, version: nextVersion }, null, 2)}\n` }));
  if (component === 'app') {
    const configPath = `${dir}/app.config.js`;
    if (source.exists(configPath)) {
      const config = read(configPath);
      const pattern = /(\bversion\s*:\s*["'])([^"']+)(["'])/u;
      if (pattern.test(config)) changes.push({ path: configPath, content: config.replace(pattern, `$1${nextVersion}$3`) });
    }
    const tauriDir = `${dir}/src-tauri`;
    if (source.exists(tauriDir)) for (const name of source.listDirectory(tauriDir).filter((name) => name.endsWith('.json'))) {
      const file = `${tauriDir}/${name}`;
      const value = JSON.parse(read(file));
      if (typeof value.version === 'string') changes.push({ path: file, content: `${JSON.stringify({ ...value, version: nextVersion }, null, 2)}\n` });
    }
  }
  return { version: nextVersion, changes };
}

function main() {
  const { values } = parseArgs({ options: { component: { type: 'string' }, bump: { type: 'string' }, version: { type: 'string' } }, allowPositionals: false });
  const plan = planComponentVersion({ repoRoot: process.cwd(), component: values.component ?? '', bump: values.bump, version: values.version });
  for (const change of plan.changes) fs.writeFileSync(path.join(process.cwd(), change.path), change.content);
  process.stdout.write(`${plan.version}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { process.stderr.write(`[bump-version] ${error.message}\n`); process.exitCode = 1; }
}
