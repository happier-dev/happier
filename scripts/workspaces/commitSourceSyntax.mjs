import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';

const LOADERS = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js' };

/**
 * Parses every source file a commit packet adds or changes, from the packet's Git objects (never the
 * moving working tree). Both HEAD writers refuse on findings: the commit wrapper's gate
 * (.project/scripts/p03/cw-head/syntaxgate.mjs) and scripts/git/commitFromPrivateIndex.mjs
 * (P03 GATE-PARITY 2026-11-18: 5346aa3091c landed an unparsable spec through the helper).
 *
 * Returns `{ findings, parsed }`, one `<path>:<line>:<column>: <message>` finding per parser error.
 * Throws when the check cannot judge (esbuild missing, service crash, unreadable objects); callers
 * report that as unavailable, never as a refusal.
 */
export async function commitSourceSyntax({ repo, base, tree }) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: Infinity });
  // Loaded here: a missing esbuild (in-place dependency refresh) is unavailable, never a refusal.
  const { transform } = await import('esbuild');
  const paths = git('diff', '--no-renames', '--diff-filter=ACMRT', '--name-only', '-z', base, tree)
    .split('\0').filter((path) => Object.hasOwn(LOADERS, extname(path)));
  const findings = [];
  for (const path of paths) {
    try {
      await transform(git('show', `${tree}:${path}`), { sourcefile: path, loader: LOADERS[extname(path)],
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
    } catch (error) {
      // esbuild's structured parser errors are findings; anything else means the check could not judge.
      if (!error.errors?.length) throw error;
      for (const detail of error.errors) findings.push(`${path}:${detail.location?.line ?? 0}:${detail.location?.column ?? 0}: ${detail.text}`);
    }
  }
  return { findings, parsed: paths.length };
}
