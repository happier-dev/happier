#!/usr/bin/env node
// Commit-slice type coherence for a shared dirty checkout. Type-checks the TypeScript files a commit
// (or a private-index tree) changes, plus their direct importers, within each owner's configured
// file membership, as they exist in that tree rather than in the worktree. Reports only diagnostics
// that the base tree does not already have.
//
//   ./apps/stack/bin/hstack-exec --local -- node scripts/workspaces/checkCommitTypeCoherence.mjs --base=<rev> --tree=<tree-ish>
//   ... --base=<head> --tree=<private-tree> --message-file=<file>  (check, replay if needed, CAS commit)
//   ./apps/stack/bin/hstack-exec --local -- node scripts/workspaces/checkCommitTypeCoherence.mjs <commit>...  (each against its first parent)
//
// Exit status: 0 coherent, 1 new diagnostics or unowned sources, 2 usage or runtime failure. It reads Git objects, so it
// runs on the machine that owns the repository. TS packets require the local wrapper above:
// the plain CLI loads compiler modules and Git blobs before its API launcher enters admission.
// Zero-TS packets use plain `node scripts/workspaces/checkCommitTypeCoherence.mjs ...`:
// the changed-source owner returns before compiler loading or admission, including finalization.
// Every compiler API, including imported and plain Node calls, uses the executor's
// canonical admission. Admitted parents retain their reservation for this phase.
//
// The checkout is read through a request-filesystem layer of the Microsoft compiler's API: compiler
// inputs whose bytes differ from the tree carry the tree's blob, paths the tree lacks (including
// untracked files) are removed, and everything else — node_modules, ignored generated inputs — is
// read from disk. Workspace packages resolve to their sources (the `happier-source` condition, and
// tsconfig `paths` into packages/*/dist redirected to src), which is what CI type-checks after it
// builds those packages at the commit. This is a fast slice check, not a package typecheck verdict:
// importers reached only through barrels are not roots, and the package typecheck remains the gate.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveTypeScriptApiExecutable } from './resolveTypeScriptApiExecutable.mjs';
import { diagnosticHunks, diagnosticMessageText, newDiagnostics } from './commitTypeCoherenceDiagnostics.mjs';
import { uiTypedRoutesDeclaration } from '../../apps/ui/scripts/uiTypedRoutesDeclaration.mjs';

const require = createRequire(import.meta.url);
let ts;

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

// Parse only grep candidates: imports in comments or fixture strings are not consumers.
function importSpecifiers(file, text, source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)) {
  const values = new Map();
  const add = (value, node) => {
    if (!values.has(value)) values.set(value, []);
    values.get(value).push(node.getText(source));
  };
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text, node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(callee) && callee.text === 'require'
        || ts.isPropertyAccessExpression(callee) && callee.name.text === 'mock') {
        const value = node.arguments[0];
      if (value && ts.isStringLiteral(value)) add(value.text, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

function sourceContext(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  let global = source.isDeclarationFile || !ts.isExternalModule(source);
  const visit = node => {
    if (ts.isModuleDeclaration(node)) global = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { global, dependencies: JSON.stringify([
    ...[...importSpecifiers(file, text, source).values()].flat(),
    ...source.referencedFiles.map(ref => `path:${ref.fileName}`),
    ...source.typeReferenceDirectives.map(ref => `types:${ref.fileName}`),
    ...source.libReferenceDirectives.map(ref => `lib:${ref.fileName}`),
    ...[...source.pragmas].map(([name, entries]) => JSON.stringify([name,
      [entries].flat().map(entry => entry.arguments)])),
    `noDefaultLib:${source.hasNoDefaultLib}`,
  ].sort()) };
}

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
    const candidates = output.split('\n').flatMap(line => {
      const [location, match] = line.split('\0');
      return match ? [{ importer: location.slice(location.indexOf(':') + 1), match }] : [];
    });
    const entries = treeEntries(tree);
    const blobs = readBlobs([...new Set(candidates.map(({ importer }) => entries.get(importer).oid))]);
    const specifiers = new Map();
    const exact = new Set(targets);
    const importers = new Set();
    for (const { importer, match } of candidates) {
      if (!specifiers.has(importer)) specifiers.set(importer,
        importSpecifiers(importer, blobs.get(entries.get(importer).oid)));
      const raw = match.slice(match.search(/['"]/u) + 1, -1);
      if (!specifiers.get(importer).has(raw)) continue;
      const value = raw
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

  function typedRouteInputs(groups, entries) {
    if (!groups.has('apps/ui')) return {};
    const routes = uiTypedRoutesDeclaration(abs('apps/ui'), [...entries.keys()]
      .filter(path => path.startsWith('apps/ui/')).map(abs));
    return routes ? { [routes.path]: routes.declaration } : {};
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
          text: diagnosticMessageText(diagnostic),
        });
      }
    }
    return rows;
  }

  return {
    git,
    gitText,
    treeEntries,
    readBlobs,
    layerFor,
    sliceOf,
    importersOf,
    groupRoots,
    typedRouteInputs,
    virtualConfigs,
    collect,
    abs,
  };
}

export function checkCommitTypeCoherence({ repo, base, tree, onlyGroups }) {
  const started = Date.now();
  const git = repository(repo);
  base = git.gitText(['rev-parse', '--verify', base]).trim();
  tree = git.gitText(['rev-parse', '--verify', `${tree}^{tree}`]).trim();
  const slice = git.sliceOf(base, tree);
  const changed = slice.filter(({ path }) => TYPESCRIPT_SOURCE.test(path));
  const result = { base, tree, changed: changed.length, roots: 0, unowned: [], fresh: [], groups: [], candidates: [] };
  if (changed.length === 0) return { ...result, ms: Date.now() - started };
  ts ??= require('typescript');
  const { API } = require('@typescript/native/sync');
  const treeIndex = git.treeEntries(tree);
  let roots = [
    ...new Set([
      ...changed.filter(({ status }) => status !== 'D').map(({ path }) => path),
      ...git.importersOf(tree, changed),
    ]),
  ];
  const { groups, unowned } = git.groupRoots(roots, treeIndex);
  result.candidates = [...groups].map(([id, files]) => ({ id, roots: files }));
  if (onlyGroups) for (const dir of groups.keys()) if (!onlyGroups.has(dir)) groups.delete(dir);
  Object.assign(result, { roots: roots.length, unowned });
  const api = new API({ cwd: repo, tsserverPath: process.platform === 'win32'
    ? resolveTypeScriptApiExecutable()
    : fileURLToPath(new URL('./runCommitTypeCoherenceApi.mjs', import.meta.url)) });
  try {
    const layer = git.layerFor(tree, treeIndex);
    Object.assign(layer.files, git.typedRouteInputs(groups, treeIndex));
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
    // Configured module roots are not all dependencies of the checked roots. Resolve a
    // second, diagnostic-free view through the same compiler, retaining every declaration,
    // script and augmentation from the complete program as global context. This also keeps
    // ambient declarations reached only through an unrelated root's imports.
    const dependencyConfigs = {};
    for (const project of headSnapshot.getProjects()) {
      const selected = head.configs.get(project.configFileName);
      if (!selected) continue;
      const context = project.program.getSourceFileNames().filter(path => {
        if (/\.d\.[cm]?ts$/u.test(path)) return true;
        const text = layer.files[path] ?? readFileSync(path, 'utf8');
        return sourceContext(path, text).global;
      });
      dependencyConfigs[project.configFileName] = JSON.stringify({
        ...JSON.parse(head.files[project.configFileName]), files: [...new Set([...selected, ...context])],
      });
    }
    const dependencies = api.createSnapshot({
      openProjects: [...head.configs.keys()],
      fileSystem: { ...layer, files: { ...layer.files, ...dependencyConfigs } },
    });
    // Retain resolved dependencies and extended configs, rather than all configured module
    // roots, so unrelated same-project commits do not send a finalizer back to admission.
    result.groups = [...groups].map(([id, selected]) => {
      const config = git.abs(id === '.' ? VIRTUAL_CONFIG : `${id}/${VIRTUAL_CONFIG}`);
      const program = dependencies.getProjects().find(project => project.configFileName === config).program;
      const members = headSnapshot.getProjects().find(project => project.configFileName === config).program
        .getSourceFileNames().map(path => posix.relative(repo, path))
        .filter(path => !path.startsWith('../') && !path.includes('node_modules/'));
      const paths = new Set();
      for (const absolute of [...program.getSourceFileNames(), ...program.getConfigFileNames()]) {
        const path = posix.relative(repo, absolute);
        if (path.startsWith('../') || path.includes('node_modules/')) continue;
        if (!path.endsWith(`/${VIRTUAL_CONFIG}`) && path !== VIRTUAL_CONFIG) paths.add(path);
        for (let dir = posix.dirname(path);; dir = posix.dirname(dir)) {
          paths.add(dir === '.' ? 'package.json' : `${dir}/package.json`);
          if (dir === '.') break;
        }
      }
      paths.add(id === '.' ? 'tsconfig.json' : `${id}/tsconfig.json`);
      return { id, roots: selected, paths: [...paths], members, fresh: [] };
    });
    dependencies.dispose();
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
    const baseRows = [];
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
      Object.assign(revert.files, git.typedRouteInputs(baseGroups, baseIndex));
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
        const renamed = [...renamedFrom].find(([, previous]) => row.file === previous)?.[0];
        baseRows.push(renamed ? { ...row, file: renamed } : row);
      }
    }
    const diagnosticFiles = new Set(baseRows.map(row => row.file));
    const hunksByFile = new Map(slice
      .filter(({ status, path }) => status === 'M' && diagnosticFiles.has(path))
      .map(({ path }) => [path, diagnosticHunks(git.gitText([
        'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', base, tree, '--', path,
      ]))]));
    result.fresh = newDiagnostics(baseRows, headRows, hunksByFile);
    for (const group of result.groups)
      group.fresh = result.fresh.filter(row => group.roots.includes(row.file) || row.file === '<global>');
    return { ...result, ms: Date.now() - started };
  } finally {
    api.close();
  }
}

// Replays only the reviewed packet into a temporary index; neither the worktree nor the shared
// staging state is changed. A conflicting concurrent edit is left for the packet owner to merge.
function replayPacket(git, base, tree, head) {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-coherence-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: resolve(directory, 'index') };
  try {
    git.git(['read-tree', head], { env });
    const patch = git.git(['diff-tree', '-p', '--binary', '--full-index', '--no-renames', base, tree]);
    git.git(['apply', '--cached', '--3way'], { env, input: patch });
    return git.git(['write-tree'], { env, encoding: 'utf8' }).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Finalizes an in-memory checker result. The caller still owns identity, hooks, own-hunk
 * verification and shared-index synchronization. No lock is held while the compiler queues. */
export function finalizeCommitTypeCoherence({ repo, checked, message, ref = 'HEAD' }) {
  const git = repository(repo);
  const original = checked;
  const packetPaths = git.sliceOf(original.base, original.tree).map(({ path }) => path);
  if (!packetPaths.length) throw new Error('Cannot finalize an empty packet');
  const rechecked = new Set();
  const outcome = (commit) => ({
    commit, checked,
    recheckedGroups: [...rechecked].sort(),
    reusedGroups: checked.groups.map(group => group.id).filter(id => !rechecked.has(id)).sort(),
  });
  while (true) {
    if (checked.fresh.length || checked.unowned.length) return outcome();
    const head = git.gitText(['rev-parse', 'HEAD']).trim();
    if (head !== checked.base) {
      git.git(['merge-base', '--is-ancestor', checked.base, head]);
      const tree = replayPacket(git, original.base, original.tree, head);
      if (tree === git.gitText(['rev-parse', `${head}^{tree}`]).trim())
        throw new Error('Packet is already present at HEAD');
      const entries = git.treeEntries(tree);
      const packetChanges = git.sliceOf(head, tree).filter(({ path }) => TYPESCRIPT_SOURCE.test(path));
      const roots = [...new Set([
        ...packetChanges.filter(({ status }) => status !== 'D').map(({ path }) => path),
        ...git.importersOf(tree, packetChanges),
      ])];
      const discovered = git.groupRoots(roots, entries);
      const previousEntries = git.treeEntries(checked.tree);
      // The verdict belongs to these exact inputs. Intervening edits that were reverted
      // cannot change it; compare the checked tree with the replayed tree, not commit history.
      const changed = new Set(nulList(git.gitText([
        'diff', '--name-only', '-z', '--no-renames', checked.tree, tree,
      ])));
      const contextChanges = new Map();
      const changesContext = path => {
        if (contextChanges.has(path)) return contextChanges.get(path);
        const before = previousEntries.get(path);
        const after = entries.get(path);
        const blobs = git.readBlobs([...new Set([before?.oid, after?.oid].filter(Boolean))]);
        const prior = sourceContext(path, before ? blobs.get(before.oid) : 'export {};');
        const next = sourceContext(path, after ? blobs.get(after.oid) : 'export {};');
        // A module outside the closure can still add/remove global declarations through
        // its own body or changed imports. Those changes keep the existing recheck path.
        const changed = prior.global || next.global || prior.dependencies !== next.dependencies;
        contextChanges.set(path, changed);
        return changed;
      };
      const affected = new Set(checked.groups.filter(group => {
        const paths = new Set(group.paths);
        const members = new Set(group.members);
        return [...changed].some(path => paths.has(path)
          || members.has(path) && changesContext(path)
          || ['pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path)
          || path.startsWith('patches/')
          // New compiler inputs in this project's directory can join its configured membership
          // or resolve an import that was previously unresolved.
          || (!previousEntries.has(path) && COMPILER_INPUT.test(path)
            && (group.id === '.' || path.startsWith(`${group.id}/`))));
      }).map(group => group.id));
      for (const [id, files] of discovered.groups) {
        const previous = checked.candidates.find(group => group.id === id);
        if (!previous || files.some(file => !previous.roots.includes(file))) affected.add(id);
      }
      let groups = checked.groups;
      if (affected.size) {
        const refreshed = checkCommitTypeCoherence({ repo, base: head, tree, onlyGroups: affected });
        for (const id of affected) rechecked.add(id);
        groups = [...groups.filter(group => !affected.has(group.id)), ...refreshed.groups];
      }
      checked = {
        ...checked, base: head, tree, groups,
        candidates: [...discovered.groups].map(([id, files]) => ({ id, roots: files })),
        roots: groups.reduce((sum, group) => sum + group.roots.length, 0),
        unowned: discovered.unowned,
        fresh: groups.flatMap(group => group.fresh),
      };
      continue;
    }
    const sign = git.gitText(['config', '--bool', '--default=false', '--get', 'commit.gpgsign']).trim() === 'true';
    const commit = git.git(['commit-tree', ...(sign ? ['-S'] : []), checked.tree, '-p', head], { input: message, encoding: 'utf8' }).trim();
    try {
      git.git(['update-ref', ref, commit, head]);
      return outcome(commit);
    } catch (error) {
      if (git.gitText(['rev-parse', 'HEAD']).trim() === head) throw error;
      // Another writer won CAS. Its commits are examined by the same owner on the next pass.
    }
  }
}

function main(argv) {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const option = (name) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const targets = [];
  const messageFile = option('message-file');
  if (messageFile && (!option('tree') || !option('base') || argv.some(arg => !arg.startsWith('--'))))
    throw new Error('--message-file requires one explicit --base and --tree packet');
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
    const verdict = result.fresh.length || result.unowned.length ? 'INCOHERENT' : 'coherent';
    console.log(
      `${verdict} ${target.label}: changed=${result.changed} roots=${result.roots} new=${result.fresh.length} unowned=${result.unowned.length} ${(result.ms / 1000).toFixed(1)}s`,
    );
    for (const row of result.fresh)
      console.log(
        `  ${row.file}(${row.line},${row.column}): TS${row.code} ${row.text}`,
      );
    for (const file of result.unowned) console.log(`  unowned source: ${file} (no ancestor tsconfig.json)`);
    if (result.fresh.length || result.unowned.length) incoherent += 1;
    if (messageFile) {
      const finalized = finalizeCommitTypeCoherence({ repo, checked: result, message: readFileSync(messageFile, 'utf8'), ref: option('ref') });
      if (!finalized.commit) {
        for (const row of finalized.checked.fresh)
          console.log(`  ${row.file}(${row.line},${row.column}): TS${row.code} ${row.text}`);
        for (const file of finalized.checked.unowned) console.log(`  unowned source: ${file} (no ancestor tsconfig.json)`);
        console.error(`Packet refused: new=${finalized.checked.fresh.length} unowned=${finalized.checked.unowned.length}`);
        return 1;
      }
      console.log(`committed ${finalized.commit}: parent=${finalized.checked.base} reused=${finalized.reusedGroups.join(',')} rechecked=${finalized.recheckedGroups.join(',')}`);
    }
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
