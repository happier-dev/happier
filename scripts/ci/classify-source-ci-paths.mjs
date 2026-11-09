// @ts-check
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { buildReleaseNotesBundle } from '../pipeline/release/release-notes/project-release-notes.mjs';
import { verifyCanonicalGateBaseline } from '../pipeline/release/verify-existing-ci.mjs';

/** Only JSON version fields emitted by bump-version.mjs are metadata.
 * Native configuration, dependencies, scripts and generated inputs stay on source gates.
 * @param {{repoRoot: string; repository: string; sourceBranch: string; baseSha: string; sourceSha: string}} input
 */
export async function resolveReleaseMetadataCi(input) {
  const broad = { metadataOnly: false, baseSha: '', baseRunId: '' };
  if (!/^[0-9a-f]{40}$/u.test(input.baseSha) || /^0+$/u.test(input.baseSha)
    || !/^[0-9a-f]{40}$/u.test(input.sourceSha) || input.baseSha === input.sourceSha) return broad;
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: input.repoRoot, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Cannot read release metadata source range');
    return result.stdout;
  };
  if (spawnSync('git', ['merge-base', '--is-ancestor', input.baseSha, input.sourceSha], { cwd: input.repoRoot }).status !== 0) return broad;
  const paths = git('diff', '--no-renames', '--name-only', '-z', input.baseSha, input.sourceSha).split('\0').filter(Boolean);
  if (paths.length === 0) return broad;
  const ui = JSON.parse(git('show', `${input.sourceSha}:apps/ui/package.json`));
  for (const path of paths) {
    if (path === 'apps/ui/CHANGELOG.md') continue;
    if (!/^apps\/(?:ui|cli|server|website|stack)\/package\.json$/u.test(path)
      && !/^packages\/(?:relay-server|sdk|plugin-sdk|plugin-ui)\/package\.json$/u.test(path)
      && path !== 'apps/ui/src-tauri/tauri.conf.json') return broad;
    try {
      const before = JSON.parse(git('show', `${input.baseSha}:${path}`));
      const after = JSON.parse(git('show', `${input.sourceSha}:${path}`));
      if (typeof before.version !== 'string' || !before.version.trim()
        || typeof after.version !== 'string' || !after.version.trim()) return broad;
      if (path === 'apps/ui/src-tauri/tauri.conf.json' && after.version !== ui.version) return broad;
      delete before.version; delete after.version;
      if (!isDeepStrictEqual(before, after)) return broad;
    } catch { return broad; }
  }
  const changelog = git('show', `${input.sourceSha}:apps/ui/CHANGELOG.md`);
  const releaseIds = [...changelog.matchAll(/^## Release ([a-z0-9][a-z0-9._-]*) - \d{4}-\d{2}-\d{2}$/gmu)].map((match) => match[1]);
  if (releaseIds.length === 0) throw new Error('Release metadata source has no canonical release-note section');
  for (const releaseId of releaseIds) buildReleaseNotesBundle(changelog, { releaseId, sourceSha: input.sourceSha, componentVersions: { ui: ui.version } });
  try {
    const listing = spawnSync('gh', ['api', `repos/${input.repository}/actions/workflows/tests.yml/runs?head_sha=${input.baseSha}&event=push&status=success&per_page=1`], { encoding: 'utf8' });
    if (listing.error) throw listing.error;
    if (listing.status !== 0) throw new Error('Cannot discover baseline CI');
    const baseline = JSON.parse(listing.stdout).workflow_runs?.[0];
    if (!baseline) throw new Error('No successful canonical source baseline');
    const baseRunId = String(baseline.id);
    await verifyCanonicalGateBaseline({ ...input, sourceSha: input.baseSha, runId: baseRunId });
    return { metadataOnly: true, baseSha: input.baseSha, baseRunId };
  } catch (error) {
    process.stderr.write(`Release metadata CI unavailable; selecting source gates: ${error instanceof Error ? error.message : String(error)}\n`);
    return broad;
  }
}
