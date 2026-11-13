import { appendFile, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveReleaseMetadataCi } from './classify-source-ci-paths.mjs';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import {
  collectInternalWorkspaceDependencyNames,
  collectAdmittedInternalWorkspacePeerDependencyNames,
} from '../workspaces/workspacePackageDependencies.mjs';

const gatePackages = ['cli', 'plugins', 'protocol', 'server', 'stack', 'ui'];

export function resolveGatePackageForWorkspaceDirectory(directory) {
  if (directory.startsWith('packages/plugins/')) return 'plugins';
  if (directory === 'packages/protocol') return 'protocol';
  if (directory === 'apps/cli') return 'cli';
  if (directory === 'apps/ui') return 'ui';
  if (directory === 'apps/server') return 'server';
  if (directory === 'apps/stack') return 'stack';
  return null;
}

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
    const gatePackage = resolveGatePackageForWorkspaceDirectory(directory);
    if (gatePackage) selected.add(gatePackage);
  }
  return [...selected].sort();
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const changedPaths = input.split('\0').filter(Boolean);
  const metadata = process.env.GITHUB_EVENT_NAME === 'push'
    ? await resolveReleaseMetadataCi({
      repoRoot: process.cwd(), repository: String(process.env.GITHUB_REPOSITORY ?? ''),
      sourceBranch: String(process.env.GITHUB_REF_NAME ?? ''),
      baseSha: String(process.env.BASE_SHA ?? ''), sourceSha: String(process.env.GITHUB_SHA ?? ''),
    })
    : { metadataOnly: false, baseSha: '', baseRunId: '' };
  const packages = metadata.metadataOnly ? [] : await selectAffectedGatePackages({ changedPaths });
  if (process.env.GITHUB_OUTPUT) {
    const serverDbContract = changedPaths.some((path) => path.startsWith('apps/server/prisma/'));
    // Eight disjoint UI ranges reduce per-job retention and share preparation.
    // Host suites retain their existing grouped runner and terminal verdict.
    const groupedPackages = packages.filter((packageName) => packageName !== 'ui');
    const unitMatrix = { include: [
      ...(groupedPackages.length ? [{ package: 'group', packages: groupedPackages, part: 1, parts: 1 }] : []),
      ...(packages.includes('ui') ? Array.from({ length: 8 }, (_, index) => ({
        package: 'ui', packages: ['ui'], part: index + 1, parts: 8,
      })) : []),
    ] };
    await appendFile(process.env.GITHUB_OUTPUT,
      `packages=${JSON.stringify(packages)}\nunit_matrix=${JSON.stringify(unitMatrix)}\nserver_db_contract=${serverDbContract}\nmetadata_only=${metadata.metadataOnly}\nmetadata_base_sha=${metadata.baseSha}\nmetadata_base_run_id=${metadata.baseRunId}\n`);
  }
  process.stdout.write(`${JSON.stringify(packages)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
