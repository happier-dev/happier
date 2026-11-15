// Commit producer closure: every module and named export a packet's sources import must exist in the
// packet's own tree, and every pnpm lockfile importer must have its package.json tracked there.
// Textual (AST + module resolution over Git objects), no compiler program and no admission, so every
// commit path runs it before CAS. Only findings the packet adds relative to its base refuse; a break
// already present at the base is reported by its own owner, not attributed to this packet.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { SOURCE_CONDITION } from '../../packages/cli-common/sourceRuntimeEntries.mjs';
import { isPublicRuntimeImportDiagnostic } from '../../apps/stack/scripts/utils/proc/runtimeImportProbe.mjs';

const require = createRequire(import.meta.url);
let ts;

const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const EXPORT_PARSED = /\.(?:[cm]?ts|tsx|mjs)$/u;
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'];
const LOCKFILE_INPUT = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u;

const nul = text => text.split('\0').filter(Boolean);
const stemOf = file => {
  const bare = file.replace(/(?:\.d)?\.[cm]?[jt]sx?$/u, '');
  return posix.basename(bare) === 'index' ? posix.basename(posix.dirname(bare)) : posix.basename(bare);
};
// Source paths and import strings are arbitrary content. Never emit private diagnostics.
const label = value => isPublicRuntimeImportDiagnostic(value) && /^[\w@./*+ {},$>-]+$/u.test(value)
  ? value : '[redacted import]';

function gitIn(repo) {
  return (args, options = {}) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', maxBuffer: 2 ** 31 - 1, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
}

function readBlobs(git, oids) {
  const contents = new Map();
  if (!oids.length) return contents;
  const bytes = git(['cat-file', '--batch'], { input: Buffer.from(`${oids.join('\n')}\n`), encoding: 'buffer' });
  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(10, offset);
    const [oid, , size] = bytes.subarray(offset, end).toString('utf8').split(' ');
    contents.set(oid, bytes.subarray(end + 1, end + 1 + Number(size)).toString('utf8'));
    offset = end + 2 + Number(size);
  }
  return contents;
}

/** One revision's files, module resolution and export tables, all read from Git objects. */
function revisionView(repo, git, rev) {
  const blobs = new Map();
  for (const record of nul(git(['ls-tree', '-r', '-z', '--full-tree', rev]))) {
    const tab = record.indexOf('\t');
    const [mode, , oid] = record.slice(0, tab).split(' ');
    if (mode !== '160000') blobs.set(record.slice(tab + 1), oid);
  }
  const contents = new Map();
  const read = file => {
    const oid = blobs.get(file);
    if (!oid) return undefined;
    if (!contents.has(oid)) contents.set(oid, git(['cat-file', 'blob', oid]));
    return contents.get(oid);
  };
  const prefetch = files => {
    for (const [oid, text] of readBlobs(git, [...new Set(files.map(file => blobs.get(file)).filter(oid => oid && !contents.has(oid)))]))
      contents.set(oid, text);
  };
  prefetch([...blobs.keys()].filter(name => /(?:^|\/)package\.json$/u.test(name) || /(?:^|\/)tsconfig[^/]*\.json$/u.test(name)));
  const workspaces = new Map();
  for (const name of [...blobs.keys()].filter(name => /(?:^|\/)package\.json$/u.test(name))) {
    const manifest = ts.parseConfigFileTextToJson(name, read(name)).config;
    if (manifest?.name) workspaces.set(manifest.name, posix.dirname(name));
  }
  const directories = new Set(['.']);
  for (const name of blobs.keys())
    for (let dir = posix.dirname(name); !directories.has(dir); dir = posix.dirname(dir)) directories.add(dir);
  const repoPath = value => {
    let name = relative(repo, resolve(value)).split(sep).join('/') || '.';
    // TypeScript's package resolver sees workspace packages as installed links.
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/u.exec(name);
    if (match && workspaces.has(match[1])) name = posix.join(workspaces.get(match[1]), match[2] ?? '');
    return name;
  };
  const host = {
    fileExists: value => blobs.has(repoPath(value)),
    readFile: value => read(repoPath(value)),
    directoryExists: value => {
      const name = repoPath(value);
      return directories.has(name) || name.endsWith('node_modules') || /node_modules\/@[^/]+$/u.test(name);
    },
    getCurrentDirectory: () => repo,
    realpath: value => resolve(repo, repoPath(value)),
  };
  const configs = new Map();
  const optionsFor = file => {
    const config = ts.findConfigFile(resolve(repo, posix.dirname(file)), host.fileExists);
    if (!configs.has(config)) {
      const options = config ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, host.readFile).config,
        { ...host, readDirectory: () => [], useCaseSensitiveFileNames: true }, dirname(config)).options : {};
      // Resolution only, never emit: scripts (.mjs/.js) and JSON are producers whatever the project compiles.
      configs.set(config, { ...options, allowJs: true, resolveJsonModule: true,
        moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
        customConditions: [...new Set([...(options.customConditions ?? []), SOURCE_CONDITION])] });
    }
    return configs.get(config);
  };
  const resolutions = new Map();
  // external: not a repository module; missing: a local specifier with no tracked target.
  const resolveImport = (file, specifier) => {
    const key = `${posix.dirname(file)}\0${specifier}`;
    if (resolutions.has(key)) return resolutions.get(key);
    const options = optionsFor(file);
    const workspace = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/u)?.[1];
    const alias = Object.keys(options.paths ?? {}).some(pattern => pattern.includes('*')
      ? specifier.startsWith(pattern.split('*')[0]) && specifier.endsWith(pattern.split('*')[1]) : pattern === specifier);
    let result = { kind: 'external' };
    if (specifier.startsWith('.') || specifier.startsWith('@/') || alias || workspaces.has(workspace)) {
      const resolved = ts.resolveModuleName(specifier, resolve(repo, file), options, host).resolvedModule;
      const target = resolved && repoPath(resolved.resolvedFileName);
      if (!resolved) result = ignoredOnDisk(file, specifier, options) ? { kind: 'external' } : { kind: 'missing' };
      else if (blobs.has(target)) result = { kind: 'file', path: target };
    }
    resolutions.set(key, result);
    return result;
  };
  // Build output (generated routes, dist) is ignored by Git and never a committed producer.
  const ignoredOnDisk = (file, specifier, options) => {
    const resolved = ts.resolveModuleName(specifier, resolve(repo, file), options, ts.sys).resolvedModule;
    if (!resolved) return false;
    const path = relative(repo, resolved.resolvedFileName).split(sep).join('/');
    if (path.startsWith('../') || path.includes('node_modules/')) return true;
    try {
      git(['check-ignore', '-q', '--', path]);
      return true;
    } catch {
      return false;
    }
  };
  const kindOf = file => /\.tsx$/u.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  // Export tables read top-level statements only; parent links are needed only for import roots.
  const ownTables = new Map();
  const ownExports = file => {
    if (ownTables.has(file)) return ownTables.get(file);
    const own = { names: new Set(), stars: [], unknown: !EXPORT_PARSED.test(file) };
    ownTables.set(file, own);
    if (own.unknown) return own;
    for (const statement of ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, false, kindOf(file)).statements) {
      const modifiers = statement.modifiers ?? [];
      const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(statement)) {
        if (!statement.exportClause) {
          const target = statement.moduleSpecifier && resolveImport(file, statement.moduleSpecifier.text);
          if (target?.kind === 'file') own.stars.push(target.path);
          else own.unknown = true;
        } else if (ts.isNamespaceExport(statement.exportClause)) own.names.add(statement.exportClause.name.text);
        else for (const element of statement.exportClause.elements) own.names.add(element.name.text);
      } else if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) own.unknown = true;
        else own.names.add('default');
      } else if (exported) {
        if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) own.names.add('default');
        else if (ts.isVariableStatement(statement)) {
          const bind = name => {
            if (ts.isIdentifier(name)) own.names.add(name.text);
            else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
          };
          for (const declaration of statement.declarationList.declarations) bind(declaration.name);
        } else if (statement.name && ts.isIdentifier(statement.name)) own.names.add(statement.name.text);
      }
    }
    return own;
  };
  const STAR = /^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/gmu;
  // Barrels re-export many modules: read each re-export level in one Git batch, not one process per file.
  // The textual star scan only batches I/O; the parsed tables still decide every verdict.
  const prefetchExportClosure = files => {
    const visited = new Set();
    for (let level = files; level.length;) {
      prefetch(level);
      for (const file of level) visited.add(file);
      level = [...new Set(level.filter(file => blobs.has(file) && EXPORT_PARSED.test(file)).flatMap(file =>
        [...read(file).matchAll(STAR)].map(match => resolveImport(file, match[1]))
          .filter(target => target.kind === 'file').map(target => target.path)))].filter(file => !visited.has(file));
    }
  };
  // Every name a module exports, through its star re-exports (default is never re-exported by `*`).
  const exportTables = new Map();
  const exportsOf = (file, seen = new Set()) => {
    if (exportTables.has(file)) return exportTables.get(file);
    const own = ownExports(file);
    const table = { names: new Set(own.names), unknown: own.unknown };
    if (seen.has(file)) return table;
    seen.add(file);
    prefetchExportClosure(own.stars);
    for (const star of own.stars) {
      const inner = exportsOf(star, seen);
      for (const name of inner.names) if (name !== 'default') table.names.add(name);
      if (inner.unknown) table.unknown = true;
    }
    exportTables.set(file, table);
    return table;
  };
  // true, false, or undefined when an unparsed module could supply it. A file whose text never
  // spells the name and has no star re-export cannot export it, so most barrel members are never parsed.
  const exportsName = (file, name, seen = new Set()) => {
    if (seen.has(file)) return false;
    seen.add(file);
    if (!EXPORT_PARSED.test(file)) return undefined;
    const text = read(file);
    if (!text.includes(name) && !/export\s*\*/u.test(text)) return false;
    const own = ownExports(file);
    if (own.names.has(name)) return true;
    let result = own.unknown ? undefined : false;
    if (name === 'default') return result;
    for (const star of own.stars) {
      const inner = exportsName(star, name, seen);
      if (inner === true) return true;
      if (inner === undefined) result = undefined;
    }
    return result;
  };
  // Imports that must resolve, with the named bindings they read from their module.
  const importsOf = file => {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kindOf(file));
    const imports = [];
    // A locally bound require (notably createRequire(new URL(...))) has its own base.
    // Only Node's implicit module require resolves from this file.
    const requireScopes = new Set();
    const isRequire = name => name && ts.isIdentifier(name) && name.text === 'require';
    const collectRequireBindings = node => {
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && isRequire(node.name)) {
        const blockScoped = Boolean(node.parent.flags & ts.NodeFlags.BlockScoped);
        let scope = node.parent;
        while (scope.parent && !ts.isSourceFile(scope) && !ts.isFunctionLike(scope)
          && !(blockScoped && ts.isBlock(scope))) scope = scope.parent;
        requireScopes.add(scope);
      }
      if (ts.isFunctionLike(node) && node.parameters.some(parameter => isRequire(parameter.name))) requireScopes.add(node);
      if (ts.isCatchClause(node) && isRequire(node.variableDeclaration?.name)) requireScopes.add(node);
      if (ts.isImportClause(node) && isRequire(node.name)
        || ts.isImportSpecifier(node) && isRequire(node.name)
        || ts.isNamespaceImport(node) && isRequire(node.name)) requireScopes.add(source);
      ts.forEachChild(node, collectRequireBindings);
    };
    collectRequireBindings(source);
    const isModuleRequire = node => {
      for (let scope = node; scope; scope = scope.parent) if (requireScopes.has(scope)) return false;
      return true;
    };
    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const names = [];
        if (clause?.name) names.push('default');
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
        imports.push({ specifier: node.moduleSpecifier.text, names });
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const names = node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map(element => (element.propertyName ?? element.name).text) : [];
        imports.push({ specifier: node.moduleSpecifier.text, names });
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require' && isModuleRequire(node))
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        imports.push({ specifier: node.arguments[0].text, names: [] });
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        imports.push({ specifier: node.argument.literal.text, names: [] });
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        imports.push({ specifier: node.moduleReference.expression.text, names: [] });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return imports;
  };
  // Findings keyed per missing name, so an inherited break never masks a new one in the same import.
  const findings = roots => {
    const found = new Map();
    prefetch(roots);
    const planned = roots.filter(file => blobs.has(file)).map(file => [file, importsOf(file)
      .map(entry => ({ ...entry, target: resolveImport(file, entry.specifier) }))]);
    prefetchExportClosure([...new Set(planned.flatMap(([, imports]) => imports
      .filter(({ target, names }) => target.kind === 'file' && names.length).map(({ target }) => target.path)))]);
    for (const [file, imports] of planned) {
      for (const { specifier, names, target } of imports) {
        if (target.kind === 'missing') {
          found.set(`${file}\0${specifier}\0`, `missing module: ${label(`${file} -> ${specifier}`)}`);
          continue;
        }
        if (target.kind !== 'file' || !names.length) continue;
        for (const name of names) if (exportsName(target.path, name) === false)
          found.set(`${file}\0${specifier}\0${name}`, `missing export: ${label(`${file} imports { ${name} } from ${specifier}`)}`);
      }
    }
    return found;
  };
  return { blobs, read, exportsOf, findings, lockfileImporters: () => lockfileImporters(read('pnpm-lock.yaml')) };
}

// pnpm 9 may write several YAML documents; read every importers map.
function lockfileImporters(lock) {
  const dirs = new Set();
  if (!lock) return dirs;
  for (const section of lock.matchAll(/^importers:\n([\s\S]*?)(?=^\S|(?![\s\S]))/gmu))
    for (const key of section[1].matchAll(/^ {2}(\S[^:\n]*):\s*$/gmu)) dirs.add(key[1].replace(/^['"]|['"]$/gu, ''));
  return dirs;
}

export function commitProducerClosure({ repo, base, tree }) {
  const started = Date.now();
  const git = gitIn(repo);
  const slice = [];
  const records = nul(git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', base, tree]));
  for (let index = 0; index < records.length; index += 2) slice.push({ status: records[index], path: records[index + 1] });
  const sources = slice.filter(({ path }) => SOURCE.test(path));
  const result = { findings: [], roots: 0, ms: 0 };
  const lockfileInputs = slice.some(({ path }) => LOCKFILE_INPUT.test(path));
  if (!sources.length && !lockfileInputs) return { ...result, ms: Date.now() - started };
  ts ??= require('typescript');
  const after = revisionView(repo, git, tree);
  let before;
  const prior = () => (before ??= revisionView(repo, git, base));
  const findings = [];
  if (sources.length) {
    const roots = new Set(sources.filter(({ status }) => status !== 'D').map(({ path }) => path));
    // A packet can only break an unchanged importer by removing a module or an export it reads.
    // Grep the tree for the removed names (or module stems); barrels are covered because the
    // importer still spells the name it reads.
    const terms = new Set();
    for (const { status, path } of sources) {
      if (status === 'A') continue;
      const removed = status === 'D' ? null : (() => {
        const old = prior().exportsOf(path);
        const now = after.exportsOf(path);
        if (now.unknown) return [];
        return [...old.names].filter(name => !now.names.has(name));
      })();
      if (removed === null || removed.includes('default')) terms.add(stemOf(path));
      for (const name of removed ?? []) if (name !== 'default') terms.add(name);
    }
    if (terms.size) {
      let output = '';
      try {
        output = git(['grep', '-l', '-I', '-w', '-F', ...[...terms].flatMap(term => ['-e', term]), tree, '--', ...SOURCE_GLOBS]);
      } catch (error) {
        if (error.status !== 1) throw error; // 1: no match
      }
      for (const line of output.split('\n').filter(Boolean)) roots.add(line.slice(line.indexOf(':') + 1));
    }
    result.roots = roots.size;
    const fresh = after.findings([...roots]);
    if (fresh.size) {
      const inherited = prior().findings([...roots].filter(file => prior().blobs.has(file)));
      for (const [key, message] of fresh) if (!inherited.has(key)) findings.push(message);
    }
  }
  if (lockfileInputs) {
    // A clean checkout cannot `pnpm install --frozen-lockfile` when an importer's manifest is untracked.
    const untracked = view => [...view.lockfileImporters()]
      .filter(dir => !view.blobs.has(dir === '.' ? 'package.json' : `${dir}/package.json`));
    const inherited = new Set(untracked(prior()));
    for (const dir of untracked(after)) if (!inherited.has(dir))
      findings.push(`lockfile importer without a tracked package.json: ${label(dir)}`);
  }
  return { ...result, findings: findings.sort(), ms: Date.now() - started };
}
