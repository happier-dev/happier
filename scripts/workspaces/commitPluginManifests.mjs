// Commit check: the packet's bundled plugin manifests must parse with the Protocol and plugin-SDK parsers OF THE TREE
// BEING JUDGED (Coordination ruling 2026-11-16 07:20Z/12:19Z), never the moving checkout's, so an unrelated uncommitted
// schema edit cannot refuse a correct packet. Base manifests are judged with the base tree's parsers. Each tree's parsers
// are bundled once from Git objects (revisionSourceBundle.mjs), cached per `packages` tree. Publication stays the
// generator's job; this check never writes projections.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitRevisionModules } from './revisionSourceBundle.mjs';

const MANIFESTS = 'apps/cli/assets/bundled-plugin-manifests/';
const INDEXED_DECLARATION_READER = 'apps/cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
const PARSER_ENTRIES = ['packages/protocol/src/plugins/manifest/ingest.ts', 'packages/plugin-sdk/src/manifest.ts'];
// Paths whose change can change any manifest's verdict: the parsers themselves and the manifest build owners.
const ALL_MANIFEST_INPUT = /^(apps\/cli\/src\/plugins\/projection\/registry\/builtIn\/declarationAssetFormat\.mjs$|packages\/(protocol|plugin-sdk)\/src\/|apps\/cli\/scripts\/build-owned\/)/;
/** Paths that can change some manifest verdict; a recheck whose landed commits touch none keeps the prior verdict. */
export const PLUGIN_MANIFEST_INPUT = /^(apps\/cli\/src\/plugins\/projection\/registry\/builtIn\/declarationAssetFormat\.mjs$|packages\/(protocol|plugin-sdk)\/src\/|apps\/cli\/scripts\/build-owned\/|apps\/cli\/assets\/bundled-plugin-manifests\/|packages\/plugins\/)/;

/**
 * Returns `{ findings, checked, baselineInvalid }`. Refuses only invalidity the packet adds: a manifest valid at the base
 * that the candidate breaks, or an invalid manifest the packet edits. Baseline-invalid manifests the packet leaves
 * untouched neither block a parser/schema packet nor exempt an edited declaration. Throws when it cannot judge (a judged
 * tree's parsers do not bundle or throw at import).
 */
export async function commitPluginManifests({ repo, base, tree, cacheDir }) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: Infinity });
  const changed = git('diff', '--no-renames', '--name-only', '-z', base, tree).split('\0').filter(Boolean);
  const all = changed.some(path => ALL_MANIFEST_INPUT.test(path));
  const affected = new Set();
  for (const path of changed) {
    const plugin = /^packages\/plugins\/([^/]+)\//.exec(path)?.[1];
    if (plugin) affected.add(plugin);
    if (path.startsWith(MANIFESTS)) {
      affected.add(path.slice(MANIFESTS.length).replace(/^declarations\//, '').replace(/\.(summary|input-schemas|result-schemas)\.json$/, '').replace(/\.json$/, ''));
    }
  }
  const paths = git('ls-tree', '-r', '--name-only', '-z', tree, '--', MANIFESTS).split('\0')
    .filter(path => path.startsWith(MANIFESTS) && /^[-a-z0-9]+\.json$/.test(path.slice(MANIFESTS.length)))
    .filter(path => all || affected.has(path.slice(MANIFESTS.length, -5)));
  const result = { findings: [], checked: paths.length, baselineInvalid: 0 };
  if (!paths.length) return result;

  const parsersByTree = new Map();
  const parsersOf = async rev => {
    const packages = git('rev-parse', `${rev}:packages`).trim();
    if (!parsersByTree.has(packages)) {
      const file = join(cacheDir, `manifest-parsers-${packages}.mjs`);
      if (!existsSync(file)) {
        mkdirSync(cacheDir, { recursive: true });
        const part = `${file}.${process.pid}.part.mjs`;
        await emitRevisionModules({ repo, rev, entries: PARSER_ENTRIES, outfile: part });
        renameSync(part, file);
      }
      const bundle = await import(pathToFileURL(file).href);
      parsersByTree.set(packages, [['protocol', bundle.m0.ingestPluginManifestV2], ['sdk', bundle.m1.parsePluginManifest]]);
    }
    return parsersByTree.get(packages);
  };
  const decodersByTree = new Map();
  const decoderOf = async rev => {
    if (!decodersByTree.has(rev)) {
      const reader = git('ls-tree', '--name-only', rev, '--', INDEXED_DECLARATION_READER).trim();
      // Historical trees keep their own raw declaration format. The runtime
      // consumes only the indexed form as soon as this reader enters its tree.
      if (!reader) decodersByTree.set(rev, JSON.parse);
      else {
        const source = git('show', `${rev}:${reader}`);
        const codec = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
        decodersByTree.set(rev, text => codec.decodeIndexedBundledDeclarationManifest(Buffer.from(text)));
      }
    }
    return decodersByTree.get(rev);
  };
  const diagnose = async (rev, path) => {
    const decode = await decoderOf(rev);
    let input;
    try { input = decode(git('show', `${rev}:${path}`)); }
    catch { return rev === tree ? [`${path}: invalid declaration asset or unreadable Git object`] : null; }
    const issues = [];
    for (const [name, parse] of await parsersOf(rev)) {
      const parsed = parse(input);
      if (!parsed.ok) for (const issue of parsed.diagnostics) issues.push(`${path}: ${name}: ${issue.code}: ${(issue.path ?? []).join('.')}: ${issue.message}`);
    }
    return issues;
  };
  const changedSet = new Set(changed);
  for (const path of paths) {
    const issues = await diagnose(tree, path);
    if (!issues.length) continue;
    const name = path.slice(MANIFESTS.length, -5);
    const edited = changedSet.has(path) || changed.some(other => other.startsWith(`${MANIFESTS}declarations/${name}.`) || other.startsWith(`packages/plugins/${name}/`));
    const atBase = edited ? null : await diagnose(base, path);
    if (!edited && atBase?.length) { result.baselineInvalid += 1; continue; }
    result.findings.push(...issues);
  }
  return result;
}
