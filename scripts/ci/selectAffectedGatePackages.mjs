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

const UI_GATE_PARTS = 8;

/**
 * The gate-unit matrix. Without an affected-unit plan every selected package runs whole: one
 * grouped host job plus eight disjoint UI ranges (they reduce per-job retention and share
 * preparation). With a plan (`runAffectedTests.ts --units`), a package whose every graph owner
 * reached no test drops out, the grouped job narrows to the selected files when none of its
 * packages needs a whole run, and UI keeps the selection's measured share of the eight parts.
 * @param {{ packages: string[]; units: Record<string, { full: boolean; files?: string[]; total?: number }>;
 *   directories: Record<string, string[]>; uiWeights: Map<string, number> }} input
 */
export function planGateUnitMatrix({ packages, units, directories, uiWeights }) {
  const status = (gatePackage) => {
    const entries = (directories[gatePackage] ?? []).map((directory) => units[directory]);
    if (entries.length === 0 || entries.some((entry) => !entry || entry.full)) return 'full';
    return entries.some((entry) => entry.files.length > 0) ? 'files' : 'none';
  };
  const grouped = packages.filter((name) => name !== 'ui' && status(name) !== 'none');
  const include = grouped.length ? [{ package: 'group', packages: grouped, part: 1, parts: 1,
    selected: grouped.every((name) => status(name) === 'files') }] : [];
  let uiParts = 0;
  if (packages.includes('ui')) {
    const ui = status('ui');
    if (ui === 'full') uiParts = UI_GATE_PARTS;
    else if (ui === 'files') {
      const { files, total } = units['apps/ui'];
      const measured = [...uiWeights.values()].sort((a, b) => a - b);
      const median = measured.length ? measured[Math.floor(measured.length / 2)] : 1;
      const weightOf = (file) => uiWeights.get(file.replace(/^apps\/ui\//u, '')) ?? median;
      const selected = files.reduce((sum, file) => sum + weightOf(file), 0);
      const selectedKeys = new Set(files.map((file) => file.replace(/^apps\/ui\//u, '')));
      const knownOther = [...uiWeights].filter(([file]) => !selectedKeys.has(file));
      const other = knownOther.reduce((sum, [, value]) => sum + value, 0)
        + Math.max(0, total - files.length - knownOther.length) * median;
      uiParts = Math.min(files.length, UI_GATE_PARTS,
        Math.max(1, Math.ceil(UI_GATE_PARTS * selected / (selected + other))));
    }
  }
  for (let index = 0; index < uiParts; index += 1) include.push({ package: 'ui', packages: ['ui'], part: index + 1, parts: uiParts });
  return { include };
}

async function gateDirectories(rootDir) {
  const directories = {};
  for (const path of await collectWorkspacePackageJsonPaths(rootDir)) {
    const directory = relative(rootDir, dirname(path)).replaceAll('\\', '/');
    const gatePackage = resolveGatePackageForWorkspaceDirectory(directory);
    if (gatePackage) (directories[gatePackage] ??= []).push(directory);
  }
  return directories;
}

async function main() {
  const planIndex = process.argv.indexOf('--unit-plan');
  if (planIndex >= 0) {
    // After installation: narrow the matrix with the affected-unit plan written by the Gate.
    const { loadVitestUnitDurations } = await import('../../apps/ui/scripts/vitestUnitDurations.mjs');
    const planPath = process.argv[planIndex + 1];
    const units = planPath ? JSON.parse(await readFile(planPath, 'utf8')).units : {};
    const unitMatrix = planGateUnitMatrix({ packages: JSON.parse(process.env.GATE_PACKAGES ?? '[]'), units,
      directories: await gateDirectories(process.cwd()), uiWeights: loadVitestUnitDurations() });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `unit_matrix=${JSON.stringify(unitMatrix)}\n`);
    process.stdout.write(`${JSON.stringify(unitMatrix)}\n`);
    return;
  }
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
    const unitMatrix = planGateUnitMatrix({ packages, units: {}, directories: {}, uiWeights: new Map() });
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
