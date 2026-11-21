import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';

const LOADERS = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js' };

function duplicateImportBindings(ts, path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
  const seen = new Set();
  const findings = [];
  for (const statement of file.statements) {
    const names = [];
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) names.push(clause.name);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name);
      else if (bindings) names.push(...bindings.elements.filter(binding => !binding.isTypeOnly).map(binding => binding.name));
    } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
      names.push(statement.name);
    }
    for (const name of names) {
      if (seen.has(name.text)) {
        const { line, character } = file.getLineAndCharacterOfPosition(name.getStart(file));
        findings.push(`${path}:${line + 1}:${character}: Duplicate import binding: ${name.text}`);
      }
      seen.add(name.text);
    }
  }
  return findings;
}

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
    const loader = LOADERS[extname(path)];
    const source = git('show', `${tree}:${path}`);
    try {
      await transform(source, { sourcefile: path, loader,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
    } catch (error) {
      // esbuild's structured parser errors are findings; anything else means the check could not judge.
      if (!error.errors?.length) throw error;
      for (const detail of error.errors) findings.push(`${path}:${detail.location?.line ?? 0}:${detail.location?.column ?? 0}: ${detail.text}`);
      continue;
    }
    if (loader === 'ts' || loader === 'tsx') {
      // esbuild's TypeScript transform can elide a duplicate runtime import.
      const { default: ts } = await import('typescript');
      findings.push(...duplicateImportBindings(ts, path, source));
    }
  }
  return { findings, parsed: paths.length };
}
