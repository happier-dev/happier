// esbuild over one Git revision: every repository source file a bundle reads comes from the revision's objects, never
// the moving working tree, so another lane's uncommitted edit neither satisfies nor breaks a judged tree. The commit
// gate's plugin-manifest check (commitPluginManifests.mjs) bundles a judged tree's own parsers with it, and the commit
// wrapper's bundle gate (.project/scripts/p03/cw-head/headbuild.mjs) builds the CLI, server and script entries with it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|jsx)$/;
const ALIAS = [['apps/cli/', 'apps/cli/src/'], ['apps/server/', 'apps/server/sources/']];
const loaderOf = path => ({ '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx', '.json': 'json' }[extname(path)] ?? 'js');

/**
 * The revision reader and esbuild plugin. `preloadRoots` are read in one batch; other files load lazily from the revision.
 * Relative and `@/` imports, and `@happier-dev/*` workspace packages (discovered from the revision's manifests, resolved
 * through the `happier-source` condition), come from the revision. A relative module the revision lacks is recorded in
 * `missing` and kept external (an ignored generated output on disk resolves normally), so one missing module never hides
 * later link errors. Bare npm specifiers resolve from the installation when `bundleNpm`, otherwise they stay external.
 * `recorder.current`, when set, collects every revision path the build loaded (`loaded`) or probed (`probes`).
 */
export async function revisionSourceBundler({ repo, rev = 'HEAD', preloadRoots, overlay = new Set(), bundleNpm = false }) {
  const esbuild = createRequire(join(repo, 'package.json'))('esbuild');
  const show = rel => execFileSync('git', ['-C', repo, 'show', `${rev}:${rel}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  const listing = execFileSync('git', ['-C', repo, 'ls-tree', '-r', rev, '--', ...preloadRoots], { maxBuffer: 1 << 30 }).toString().split('\n').filter(Boolean);
  const shaOf = new Map();
  for (const line of listing) {
    const [meta, path] = line.split('\t');
    const [, type, sha] = meta.split(' ');
    if (type === 'blob' && CODE.test(path)) shaOf.set(path, sha);
  }
  const files = [...shaOf.keys()];
  const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: files.map(file => shaOf.get(file)).join('\n') + '\n', maxBuffer: 2 ** 31 });
  const content = new Map();
  for (let pos = 0, index = 0; pos < out.length;) {
    const nl = out.indexOf(10, pos);
    const size = parseInt(out.slice(pos, nl).toString().split(' ')[2], 10);
    pos = nl + 1;
    content.set(files[index++], out.slice(pos, pos + size));
    pos += size + 1;
  }
  const { resolveWorkspaceSource } = await import(pathToFileURL(join(repo, 'packages/cli-common/sourceRuntimeEntries.mjs')).href);
  const allAtRev = new Set(execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', rev], { maxBuffer: 1 << 30 }).toString().split('\n'));
  const showText = rel => show(rel).toString('utf8');
  // Same discovery as readWorkspacePackages (packages/*, packages/plugins/*, apps/*), read from Git objects: another
  // lane's uncommitted export-map edit must not change this revision's resolution.
  const workspacePackages = new Map();
  for (const file of allAtRev) {
    if (!/^(?:packages|packages\/plugins|apps)\/[^/]+\/package\.json$/.test(file)) continue;
    const manifest = JSON.parse(showText(file));
    if (typeof manifest.name === 'string' && manifest.name) workspacePackages.set(manifest.name, { root: join(repo, dirname(file)), manifest });
  }
  const missing = [];
  const recorder = { current: null };
  const has = rel => {
    recorder.current?.probes.add(rel);
    if (content.has(rel) || overlay.has(rel)) return true;
    if (!CODE.test(rel) || !allAtRev.has(rel)) return false;
    try { content.set(rel, show(rel)); return true; } catch { return false; }
  };
  const resolveAtRev = base => {
    const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
    for (const candidate of [base, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`, `${stripped}/index.ts`, `${stripped}/index.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}.js`]) {
      if (has(candidate)) return candidate;
    }
    return undefined;
  };
  const ignoredCache = new Map();
  const isIgnored = rel => {
    if (!ignoredCache.has(rel)) {
      let ignored = false;
      try { execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--no-index', rel]); ignored = true; } catch {}
      ignoredCache.set(rel, ignored);
    }
    return ignoredCache.get(rel);
  };
  const plugin = {
    name: 'revision-source',
    setup(build) {
      build.onResolve({ filter: /^(\.|@\/)/ }, args => {
        if (!args.importer) return undefined;
        const from = relative(repo, args.importer).split(sep).join('/');
        if (from.startsWith('..') || from.includes('node_modules/')) return undefined;
        let base;
        if (args.path.startsWith('.')) base = join(dirname(from), args.path).split(sep).join('/');
        else {
          const alias = ALIAS.find(([prefix]) => from.startsWith(prefix));
          if (!alias) return undefined;
          base = alias[1] + args.path.slice(2);
        }
        const hit = resolveAtRev(base);
        if (hit) return { path: join(repo, hit) };
        const onDisk = [base, `${base.replace(/\.(js|mjs|cjs)$/, '')}.ts`, `${base}.ts`, `${base}/index.ts`].find(candidate => existsSync(join(repo, candidate)));
        if (onDisk && isIgnored(onDisk)) return undefined;
        missing.push(`${from}\tNOT_AT_${rev}: ${base}`);
        return { path: args.path, external: true };
      });
      build.onResolve({ filter: /^@happier-dev\// }, args => {
        try { return { path: resolveWorkspaceSource(workspacePackages, args.path, { conditions: ['happier-source'] }) }; }
        catch (error) { return { errors: [{ text: `WORKSPACE_SOURCE: ${error.message}` }] }; }
      });
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (bundleNpm || args.path.startsWith('@/') || /^[A-Za-z]:/.test(args.path)) return undefined;
        return { path: args.path, external: true };
      });
      build.onResolve({ filter: /generated[/\\](?:sqlite|mysql)-client/ }, args => ({ path: args.path, external: true }));
      build.onLoad({ filter: /.*/ }, args => {
        const rel = relative(repo, args.path).split(sep).join('/');
        if (rel.startsWith('..') || rel.includes('node_modules/')) return undefined;
        recorder.current?.loaded.add(rel);
        if (!CODE.test(rel)) return { contents: '', loader: 'empty' };
        if (overlay.has(rel)) return { contents: readFileSync(args.path), loader: loaderOf(rel), resolveDir: dirname(args.path) };
        let bytes = content.get(rel);
        if (!bytes && allAtRev.has(rel)) { try { bytes = show(rel); content.set(rel, bytes); } catch {} }
        if (!bytes && isIgnored(rel)) return { contents: readFileSync(args.path), loader: loaderOf(rel), resolveDir: dirname(args.path) };
        if (!bytes) return { errors: [{ text: `NOT_AT_${rev}: ${rel}` }] };
        return { contents: bytes, loader: loaderOf(rel), resolveDir: dirname(args.path) };
      });
    },
  };
  return { esbuild, plugin, missing, recorder, allAtRev, showText, workspacePackages };
}

/**
 * Bundles revision `entries` into one self-contained ESM file (npm packages from the installation) whose exports are
 * `m0`, `m1`, ... in entry order, so a check can run a judged tree's own code. Throws with every build error.
 */
export async function emitRevisionModules({ repo, rev, entries, outfile }) {
  const bundler = await revisionSourceBundler({ repo, rev, preloadRoots: [...new Set(entries.map(entry => entry.split('/').slice(0, 2).join('/')))], bundleNpm: true });
  const errors = [];
  try {
    await bundler.esbuild.build({
      absWorkingDir: repo, bundle: true, write: true, outfile, format: 'esm', platform: 'node', target: 'node20', conditions: ['happier-source'],
      stdin: { contents: entries.map((entry, index) => `export * as m${index} from ${JSON.stringify(join(repo, entry))};`).join('\n'), resolveDir: repo, loader: 'js' },
      logLevel: 'silent', logLimit: 0, plugins: [bundler.plugin],
      banner: { js: "import { createRequire as __revisionRequire } from 'node:module'; const require = __revisionRequire(import.meta.url);" },
    });
  } catch (error) {
    for (const detail of error.errors ?? [{ text: String(error) }]) errors.push(`${detail.location ? `${detail.location.file}:${detail.location.line}` : ''}\t${detail.text}`);
  }
  errors.push(...bundler.missing);
  if (errors.length) throw new Error(`cannot bundle ${entries.join(', ')} at ${rev}:\n${errors.join('\n')}`);
}
