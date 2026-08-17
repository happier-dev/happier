import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

/**
 * @param {string} p
 */
function normalizePath(p) {
  return p.replaceAll('\\\\', '/');
}

/**
 * Resolve a runtime script path through the workflow's checkout mount points.
 * A nested checkout is another copy of the repository, while `..` from that
 * checkout can intentionally return to trusted control at the workspace root.
 *
 * @param {string} scriptRel
 * @param {string} workingDirectory
 * @param {string[]} checkoutRoots
 */
function resolveRepositoryScript(scriptRel, workingDirectory, checkoutRoots) {
  const runtimeRel = path.posix.normalize(path.posix.join(normalizePath(workingDirectory), normalizePath(scriptRel)));
  if (runtimeRel === '..' || runtimeRel.startsWith('../')) return null;

  const checkoutRoot = checkoutRoots.find(
    (root) => root === '' || runtimeRel === root || runtimeRel.startsWith(`${root}/`),
  );
  if (checkoutRoot === undefined) return null;
  const repositoryRel = checkoutRoot === '' ? runtimeRel : path.posix.relative(checkoutRoot, runtimeRel);
  return path.join(repoRoot, repositoryRel);
}

test('workflows only reference existing node script entrypoints', () => {
  const files = fs
    .readdirSync(workflowsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yml'))
    .map((e) => path.join(workflowsDir, e.name));

  /** @type {{ workflow: string; script: string }[]} */
  const missing = [];

  for (const workflowPath of files) {
    const raw = fs.readFileSync(workflowPath, 'utf8');
    const workflow = parse(raw);
    const workflowName = path.relative(repoRoot, workflowPath) || workflowPath;

    for (const job of Object.values(workflow?.jobs ?? {})) {
      if (!Array.isArray(job?.steps)) continue;
      const checkoutRoots = [
        '',
        ...job.steps
          .filter((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
          .map((step) => String(step?.with?.path ?? '').trim())
          .filter((checkoutPath) => checkoutPath && !checkoutPath.includes('${{'))
          .map((checkoutPath) => normalizePath(checkoutPath).replace(/^\.\//, '').replace(/\/$/, '')),
      ].sort((a, b) => b.length - a.length);

      for (const step of job.steps) {
        if (typeof step?.run !== 'string') continue;
        const workingDirectory = String(
          step?.['working-directory'] ?? job?.defaults?.run?.['working-directory'] ?? workflow?.defaults?.run?.['working-directory'] ?? '.',
        ).trim();
        if (!workingDirectory || workingDirectory.includes('${{')) continue;

        const re = /\bnode\s+([./A-Za-z0-9_-]+\.mjs)\b/g;
        for (const match of step.run.matchAll(re)) {
          const scriptRel = String(match[1] ?? '').trim();
          if (!scriptRel || path.isAbsolute(scriptRel)) continue;

          const abs = resolveRepositoryScript(scriptRel, workingDirectory, checkoutRoots);
          if (!abs || !fs.existsSync(abs)) {
            missing.push({ workflow: normalizePath(workflowName), script: normalizePath(scriptRel) });
          }
        }
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    missing.length > 0
      ? `Missing node script(s) referenced by workflows:\n${missing.map((m) => `- ${m.workflow}: ${m.script}`).join('\n')}`
      : 'expected no missing node script references',
  );
});
