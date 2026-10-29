import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRootPath = fileURLToPath(new URL('../../', import.meta.url));

function assertPathWithinRepository(repositoryRoot, candidatePath, use) {
  const relativePath = relative(repositoryRoot, candidatePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`local action path is outside the repository: ${use}`);
  }
}

// The publisher's existing walker is shared by the reviewed-action allowlist and
// the generic security suite. Canonical paths also deduplicate aliased cycles.
export async function collectPublisherExternalActionUses(workflow, {
  repositoryRoot = repoRootPath,
  onLocalAction = () => {},
} = {}) {
  const pendingUses = Object.values(workflow.jobs ?? {}).flatMap((job) => [
    job?.uses,
    ...(job?.steps ?? []).map((step) => step?.uses),
  ]);
  const inspectedLocalActions = new Set();
  const externalUses = [];
  while (pendingUses.length > 0) {
    const use = pendingUses.pop();
    if (typeof use !== 'string') continue;
    if (!use.startsWith('./')) {
      externalUses.push(use);
      continue;
    }
    // Reusable workflow files are checked as workflows, not composite actions.
    if (use.startsWith('./.github/workflows/')) continue;
    const repositoryLocalUse = use.startsWith('./.release-control/')
      ? `./${use.slice('./.release-control/'.length)}` : use;
    const localActionPath = resolve(repositoryRoot, repositoryLocalUse, 'action.yml');
    assertPathWithinRepository(repositoryRoot, localActionPath, use);
    const [canonicalRepositoryRoot, canonicalLocalActionPath] = await Promise.all([
      realpath(repositoryRoot), realpath(localActionPath),
    ]);
    assertPathWithinRepository(canonicalRepositoryRoot, canonicalLocalActionPath, use);
    if (inspectedLocalActions.has(canonicalLocalActionPath)) continue;
    inspectedLocalActions.add(canonicalLocalActionPath);
    const localAction = YAML.parse(await readFile(canonicalLocalActionPath, 'utf8'));
    await onLocalAction(localAction, repositoryLocalUse);
    pendingUses.push(...(localAction.runs?.steps ?? []).map((step) => step?.uses));
  }
  return externalUses;
}
