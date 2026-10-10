import { appendFile, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import {
  collectInternalWorkspaceDependencyNames,
  collectAdmittedInternalWorkspacePeerDependencyNames,
} from '../workspaces/workspacePackageDependencies.mjs';

const gatePackages = ['cli', 'plugins', 'protocol', 'server', 'ui'];

export async function selectAffectedGatePackages({ rootDir = process.cwd(), changedPaths }) {
  const paths = await collectWorkspacePackageJsonPaths(rootDir);
  const workspaces = await Promise.all(paths.map(async (path) => ({
    directory: relative(rootDir, dirname(path)).replaceAll('\\', '/'),
    manifest: JSON.parse(await readFile(path, 'utf8')),
  })));
  const workspacePackageNames = new Set(workspaces.map(({ manifest }) => manifest.name));
  const affected = new Set();
  const selected = new Set();
  for (const rawPath of changedPaths) {
    const path = rawPath.replaceAll('\\', '/');
    const owner = workspaces
      .filter(({ directory }) => path === directory || path.startsWith(`${directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length)[0];
    if (owner) {
      affected.add(owner.manifest.name);
    } else if (!path.startsWith('docs/') && !path.startsWith('.project/') && !/^[^/]+\.md$/i.test(path)) {
      // Global tooling, lockfiles and removed workspaces can affect any gate package.
      return gatePackages;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { manifest } of workspaces) {
      if (affected.has(manifest.name)) continue;
      const dependencies = [
        ...collectInternalWorkspaceDependencyNames(manifest, manifest.name, { workspacePackageNames }),
        ...collectAdmittedInternalWorkspacePeerDependencyNames(manifest, manifest.name, {
          workspacePackageNames, admittedWorkspacePackageNames: workspacePackageNames,
        }),
      ];
      if (dependencies.some((name) => affected.has(name))) {
        affected.add(manifest.name);
        changed = true;
      }
    }
  }
  for (const { directory, manifest } of workspaces) {
    if (!affected.has(manifest.name)) continue;
    if (directory.startsWith('packages/plugins/')) selected.add('plugins');
    else if (directory === 'packages/protocol') selected.add('protocol');
    else if (directory === 'apps/cli') selected.add('cli');
    else if (directory === 'apps/ui') selected.add('ui');
    else if (directory === 'apps/server') selected.add('server');
  }
  return [...selected].sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const changedPaths = input.split('\0').filter(Boolean);
  const packages = await selectAffectedGatePackages({ changedPaths });
  if (process.env.GITHUB_OUTPUT) {
    const serverDbContract = changedPaths.some((path) => path.startsWith('apps/server/prisma/'));
    // Four UI ranges retain all canonical sub-shards. Group the other suites
    // so independent selection and compilation stay within the 10-job budget.
    // P3 still owns duration validation against GitHub's execution window.
    const groupedPackages = packages.filter((packageName) => packageName !== 'ui');
    const unitMatrix = { include: [
      ...(groupedPackages.length ? [{ package: 'group', packages: groupedPackages, part: 1, parts: 1 }] : []),
      ...(packages.includes('ui') ? Array.from({ length: 4 }, (_, index) => ({
        package: 'ui', packages: ['ui'], part: index + 1, parts: 4,
      })) : []),
    ] };
    await appendFile(process.env.GITHUB_OUTPUT,
      `packages=${JSON.stringify(packages)}\nunit_matrix=${JSON.stringify(unitMatrix)}\nserver_db_contract=${serverDbContract}\n`);
  }
  process.stdout.write(`${JSON.stringify(packages)}\n`);
}
