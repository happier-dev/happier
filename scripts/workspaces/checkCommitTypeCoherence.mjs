#!/usr/bin/env node
// Commit-slice type coherence for a shared dirty checkout. Type-checks the TypeScript files a commit
// (or a private-index tree) changes, plus their direct importers, within each owner's configured
// file membership, as they exist in that tree rather than in the worktree. Reports only diagnostics
// that the base tree does not already have.
//
//   node scripts/workspaces/checkCommitTypeCoherence.mjs --base=<rev> --tree=<tree-ish>
//   node scripts/workspaces/checkCommitTypeCoherence.mjs <commit>...     (each against its first parent)
//
// Exit status: 0 coherent, 1 new diagnostics, 2 usage or runtime failure. It reads Git objects, so it
// runs on the machine that owns the repository (`./apps/stack/bin/hstack-exec --local -- node ...`).
//
// The checkout is read through a request-filesystem layer of the Microsoft compiler's API: compiler
// inputs whose bytes differ from the tree carry the tree's blob, paths the tree lacks (including
// untracked files) are removed, and everything else — node_modules, ignored generated inputs — is
// read from disk. Workspace packages resolve to their sources (the `happier-source` condition, and
// tsconfig `paths` into packages/*/dist redirected to src), which is what CI type-checks after it
// builds those packages at the commit. This is a fast slice check, not a package typecheck verdict:
// importers reached only through barrels are not roots, and the package typecheck remains the gate.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from '@typescript/native/sync';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

const TYPESCRIPT_SOURCE = /\.(?:[cm]?ts|tsx)$/u;
const COMPILER_INPUT = /\.(?:[cm]?[jt]sx?|json)$/u;
const VIRTUAL_CONFIG = 'tsconfig.__commit_coherence__.json';
const ERROR_CATEGORY = 1;

const nulList = (text) => text.split('\0').filter(Boolean);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const redirectDist = (target) =>
  target.replace(
    /(^|\/)(packages\/[^/]+)\/dist\/(.*?)(?:\.d\.ts)?$/u,
    '$1$2/src/$3',
  );
const keyOf = (row) => `${row.file}\0${row.line}\0${row.code}`;

function repository(repo) {
  const git = (args, options = {}) =>
    execFileSync('git', args, {
      cwd: repo,
      maxBuffer: 2 ** 31 - 1,
      ...options,
    });
  const gitText = (args) => git(args, { encoding: 'utf8' });
  const abs = (path) => `${repo}/${path}`;

  function treeEntries(tree) {
    const entries = new Map();
    for (const record of nulList(
      gitText(['ls-tree', '-r', '-z', '--full-tree', tree]),
    )) {
      const tab = record.indexOf('\t');
      const [mode, , oid] = record.slice(0, tab).split(' ');
      entries.set(record.slice(tab + 1), { mode, oid });
    }
    return entries;
  }

  function readBlobs(oids) {
    const contents = new Map();
    if (oids.length === 0) return contents;
    const output = git(['cat-file', '--batch'], {
      input: `${oids.join('\n')}\n`,
    });
    for (let offset = 0; offset < output.length;) {
      const headerEnd = output.indexOf(10, offset);
      const [oid, , size] = output
        .subarray(offset, headerEnd)
        .toString('utf8')
        .split(' ');
      const start = headerEnd + 1;
      contents.set(
        oid,
        output.subarray(start, start + Number(size)).toString('utf8'),
      );
      offset = start + Number(size) + 1;
    }
    return contents;
  }

  // Makes the checkout read as `tree` for every compiler input that differs from it on disk.
  function layerFor(tree, entries) {
    const differing = nulList(
      gitText([
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--ignore-submodules',
        tree,
      ]),
    );
    const untracked = nulList(
      gitText(['ls-files', '--others', '--exclude-standard', '-z']),
    );
    const present = new Map();
    const removedPaths = [];
    for (const path of [...differing, ...untracked]) {
      if (!COMPILER_INPUT.test(path)) continue;
      const entry = entries.get(path);
      if (entry?.mode === '120000' || entry?.mode === '160000') continue;
      if (entry) present.set(abs(path), entry.oid);
      else if (existsSync(abs(path))) removedPaths.push(abs(path));
    }
    const blobs = readBlobs([...new Set(present.values())]);
    return {
      kind: 'layer',
      files: Object.fromEntries(
        [...present].map(([file, oid]) => [file, blobs.get(oid)]),
      ),
      removedPaths,
    };
  }

  function sliceOf(base, tree) {
    const records = nulList(
      gitText([
        'diff-tree',
        '-r',
        '-z',
        '--no-renames',
        '--name-status',
        base,
        tree,
      ]),
    );
    const slice = [];
    for (let index = 0; index < records.length; index += 2)
      slice.push({ status: records[index], path: records[index + 1] });
    return slice;
  }

  // Files at `tree` with an import specifier that resolves (relative) or tail-matches (aliases and
  // workspace package subpaths) a changed module. Over-inclusion only costs check time.
  function importersOf(tree, changed) {
    const targets = [
      ...new Set(
        changed.map(({ path }) => {
          const bare = path.replace(/(?:\.d)?\.(?:[cm]?ts|tsx)$/u, '');
          return posix.basename(bare) === 'index' ? posix.dirname(bare) : bare;
        }),
      ),
    ];
    if (targets.length === 0) return [];
    const stems = [...new Set(targets.map((target) => posix.basename(target)))]
      .map(escapeRegex)
      .join('|');
    const pattern = `(from|import|require|mock)[[:space:](]*['"][^'"[:space:]]*/(${stems})(/index)?(\\.[cm]?[jt]sx?)?['"]`;
    let output = '';
    try {
      output = gitText([
        'grep',
        '-o',
        '-I',
        '--null',
        '-E',
        '-e',
        pattern,
        tree,
        '--',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
      ]);
    } catch (error) {
      if (error.status !== 1) throw error; // 1: no match
    }
    const exact = new Set(targets);
    const importers = new Set();
    for (const line of output.split('\n')) {
      const [location, match] = line.split('\0');
      if (!match) continue;
      const importer = location.slice(location.indexOf(':') + 1);
      const value = match
        .slice(match.search(/['"]/u) + 1, -1)
        .replace(/\.[cm]?[jt]sx?$/u, '')
        .replace(/\/index$/u, '');
      if (value.startsWith('.')) {
        if (
          exact.has(posix.normalize(posix.join(posix.dirname(importer), value)))
        )
          importers.add(importer);
        continue;
      }
      const segments = value.split('/');
      const rest = (
        value.startsWith('@/')
          ? segments.slice(1)
          : value.startsWith('@')
            ? segments.slice(2)
            : segments.slice(1)
      ).join('/');
      if (rest && targets.some((target) => target.endsWith(`/${rest}`)))
        importers.add(importer);
    }
    return [...importers];
  }

  function groupRoots(roots, entries) {
    const groups = new Map();
    const unowned = [];
    for (const root of roots) {
      if (!entries.has(root)) continue;
      let dir = posix.dirname(root);
      while (dir !== '.' && !entries.has(`${dir}/tsconfig.json`))
        dir = posix.dirname(dir);
      const config =
        dir === '.' ? (entries.has('tsconfig.json') ? '.' : undefined) : dir;
      if (config === undefined) {
        unowned.push(root);
        continue;
      }
      if (!groups.has(config)) groups.set(config, []);
      groups.get(config).push(root);
    }
    return { groups, unowned };
  }

  // Slice diagnostics, but preserve the owning project's complete configured membership.
  // Adding excluded files as roots would also add all of their ambient declarations.
  function virtualConfigs(membership, groups) {
    const files = {};
    const configs = new Map();
    for (const [dir, roots] of groups) {
      const prefix = dir === '.' ? '' : `${dir}/`;
      const config = abs(`${prefix}${VIRTUAL_CONFIG}`);
      const own = membership.getProjects().find(project => project.configFileName === abs(`${prefix}tsconfig.json`)).parsedCommandLine;
      const compilerOptions = {
        noEmit: true,
        incremental: false,
        composite: false,
        declaration: false,
        declarationMap: false,
        emitDeclarationOnly: false,
        rootDir: repo,
        customConditions: ['happier-source'],
      };
      const paths = own.options.paths;
      if (paths)
        compilerOptions.paths = Object.fromEntries(
          Object.entries(paths).map(([key, targets]) => [
            key,
            targets.map(target => redirectDist(resolve(own.options.pathsBasePath ?? abs(prefix), target).replaceAll('\\', '/'))),
          ]),
        );
      files[config] = JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions,
        files: own.fileNames,
        include: [],
      });
      configs.set(config, roots.map(abs));
    }
    return { files, configs };
  }

  function collect(snapshot, configs) {
    const rows = [];
    for (const project of snapshot.getProjects()) {
      const roots = configs.get(project.configFileName);
      if (!roots) continue;
      for (const diagnostic of [
        ...project.program.getSyntacticDiagnostics(roots),
        ...project.program.getSemanticDiagnostics(roots),
      ]) {
        if (diagnostic.category !== ERROR_CATEGORY) continue;
        rows.push({
          file: diagnostic.fileName
            ? posix.relative(repo, diagnostic.fileName)
            : '<global>',
          line: (diagnostic.startPosition?.line ?? -1) + 1,
          column: (diagnostic.startPosition?.character ?? -1) + 1,
          code: diagnostic.code,
          text: diagnostic.text.split('\n')[0],
        });
      }
    }
    return rows;
  }

  return {
    treeEntries,
    readBlobs,
    layerFor,
    sliceOf,
    importersOf,
    groupRoots,
    virtualConfigs,
    collect,
    abs,
  };
}

export function checkCommitTypeCoherence({ repo, base, tree }) {
  const started = Date.now();
  const git = repository(repo);
  const slice = git.sliceOf(base, tree);
  const changed = slice.filter(({ path }) => TYPESCRIPT_SOURCE.test(path));
  const result = { changed: changed.length, roots: 0, unowned: [], fresh: [] };
  if (changed.length === 0) return { ...result, ms: Date.now() - started };
  const treeIndex = git.treeEntries(tree);
  let roots = [
    ...new Set([
      ...changed.filter(({ status }) => status !== 'D').map(({ path }) => path),
      ...git.importersOf(tree, changed),
    ]),
  ];
  const { groups, unowned } = git.groupRoots(roots, treeIndex);
  Object.assign(result, { roots: roots.length, unowned });
  const compiler = resolveTypeScriptCliInvocation({ args: ['--api'], workspaceDir: repo });
  const api = new API({ cwd: repo, tsserverPath: compiler.apiExecutable });
  try {
    const layer = git.layerFor(tree, treeIndex);
    // Changed files and discovered importers both belong to their configured program.
    // In an aggregate, a renamed composed test is changed but is still excluded.
    const membership = api.createSnapshot({
      openProjects: [...groups.keys()].map(dir => git.abs(dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`)),
      fileSystem: layer,
    });
    for (const [dir, files] of groups) {
      const included = new Set(membership.getProjects().find(project => project.configFileName === git.abs(dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`)).parsedCommandLine.fileNames);
      const selected = files.filter(file => included.has(git.abs(file)));
      if (selected.length) groups.set(dir, selected);
      else groups.delete(dir);
    }
    roots = [...groups.values()].flat();
    result.roots = roots.length;
    const head = git.virtualConfigs(membership, groups);
    membership.dispose();
    Object.assign(layer.files, head.files);
    const headSnapshot = api.createSnapshot({
      openProjects: [...head.configs.keys()],
      fileSystem: layer,
    });
    const headRows = git.collect(headSnapshot, head.configs);
    if (headRows.length === 0) return { ...result, ms: Date.now() - started };

    // The base is the same snapshot with only the slice reverted, so unchanged files are reused.
    const baseIndex = git.treeEntries(base);
    // A byte-identical filename change keeps the same source and resolution context.
    // Compare it at its old location instead of treating existing errors as new.
    const removedByIdentity = new Map(slice
      .filter(({ status, path }) => status === 'D' && TYPESCRIPT_SOURCE.test(path))
      .map(({ path }) => [`${posix.dirname(path)}\0${baseIndex.get(path).oid}`, path]));
    const renamedFrom = new Map(slice
      .filter(({ status, path }) => status === 'A' && TYPESCRIPT_SOURCE.test(path))
      .flatMap(({ path }) => {
        const previous = removedByIdentity.get(`${posix.dirname(path)}\0${treeIndex.get(path).oid}`);
        return previous ? [[path, previous]] : [];
      }));
    // Query the same roots in the same order: type display depends on the diagnostic query.
    // Newly added source content has no baseline diagnostics.
    const baseRoots = [...new Set(roots.map(file => renamedFrom.get(file) ?? file))]
      .filter((file) => baseIndex.has(file));
    const seen = new Set();
    if (baseRoots.length) {
      const revert = {
        kind: 'layer',
        files: {},
        removedPaths: [],
      };
      const inputs = slice
        .map(({ path }) => path)
        .filter((path) => COMPILER_INPUT.test(path));
      const priorBlobs = git.readBlobs(
        inputs
          .filter((path) => baseIndex.has(path))
          .map((path) => baseIndex.get(path).oid),
      );
      for (const path of inputs) {
        const entry = baseIndex.get(path);
        if (entry) revert.files[git.abs(path)] = priorBlobs.get(entry.oid);
        else revert.removedPaths.push(git.abs(path));
      }
      const baseGroups = git.groupRoots(baseRoots, baseIndex).groups;
      const baseMembership = api.createSnapshot({
        openProjects: [...baseGroups.keys()].map(dir => git.abs(dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`)),
        fileSystem: { ...layer, files: { ...layer.files, ...revert.files }, removedPaths: [...layer.removedPaths, ...revert.removedPaths] },
      });
      const prior = git.virtualConfigs(baseMembership, baseGroups);
      baseMembership.dispose();
      Object.assign(revert.files, prior.files);
      const baseSnapshot = headSnapshot.update({
        openProjects: [...prior.configs.keys()],
        fileSystem: revert,
        fileNotifications: {
          changed: Object.keys(revert.files),
          deleted: revert.removedPaths,
        },
      });
      for (const row of git.collect(baseSnapshot, prior.configs)) {
        seen.add(keyOf(row));
        for (const [file, previous] of renamedFrom)
          if (row.file === previous) seen.add(keyOf({ ...row, file }));
      }
    }
    result.fresh = headRows.filter((row) => !seen.has(keyOf(row)));
    return { ...result, ms: Date.now() - started };
  } finally {
    api.close();
  }
}

function main(argv) {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const option = (name) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const targets = [];
  if (option('tree'))
    targets.push({
      label: option('tree'),
      base: option('base') ?? 'HEAD',
      tree: option('tree'),
    });
  for (const spec of argv.filter((arg) => !arg.startsWith('--'))) {
    const commit = execFileSync(
      'git',
      ['rev-parse', '--verify', `${spec}^{commit}`],
      { cwd: repo, encoding: 'utf8' },
    ).trim();
    targets.push({
      label: commit.slice(0, 10),
      base: `${commit}^`,
      tree: commit,
    });
  }
  if (targets.length === 0) {
    console.error(
      'usage: checkCommitTypeCoherence.mjs --base=<rev> --tree=<tree-ish> | <commit>...',
    );
    return 2;
  }
  let incoherent = 0;
  for (const target of targets) {
    const result = checkCommitTypeCoherence({ repo, ...target });
    const verdict = result.fresh.length ? 'INCOHERENT' : 'coherent';
    console.log(
      `${verdict} ${target.label}: changed=${result.changed} roots=${result.roots} new=${result.fresh.length} unowned=${result.unowned.length} ${(result.ms / 1000).toFixed(1)}s`,
    );
    for (const row of result.fresh)
      console.log(
        `  ${row.file}(${row.line},${row.column}): TS${row.code} ${row.text}`,
      );
    if (result.fresh.length) incoherent += 1;
  }
  return incoherent ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stderr?.toString?.() || error?.message || error);
    process.exitCode = 2;
  }
}
