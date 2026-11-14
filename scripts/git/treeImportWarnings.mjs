import { execFileSync } from 'node:child_process';
import { dirname, posix, resolve, relative, sep } from 'node:path';
import ts from 'typescript';
import { SOURCE_CONDITION } from '../../packages/cli-common/sourceRuntimeEntries.mjs';
import { isPublicRuntimeImportDiagnostic } from '../../apps/stack/scripts/utils/proc/runtimeImportProbe.mjs';

/** Resolve authored imports against Git objects, never uncommitted producers.
 * AST parsing and resolution only: no compiler program, build or admission gate. */
export function treeImportWarnings({ cwd, tree, paths }) {
  const selected = paths.filter(name => /\.(?:[cm]?[jt]sx?)$/.test(name));
  if (!selected.length) return [];
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: Infinity, stdio: ['pipe', 'pipe', 'pipe'] });
  const entries = git('ls-tree', '-rz', tree).split('\0').filter(Boolean);
  const blobs = new Map(entries.map(entry => {
    const tab = entry.indexOf('\t');
    return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]];
  }));
  // One batch read for source and configuration, independent of import count.
  const needed = [...blobs.keys()].filter(name => selected.includes(name)
    || /(?:^|\/)package\.json$/.test(name) || /(?:^|\/)tsconfig[^/]*\.json$/.test(name));
  const ids = [...new Set(needed.map(name => blobs.get(name)))];
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd,
    input: ids.map(id => `${id}\n`).join(''), maxBuffer: Infinity, stdio: ['pipe', 'pipe', 'pipe'] });
  const contents = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    const [id, , length] = bytes.subarray(offset, end).toString().split(' ');
    contents.set(id, bytes.subarray(end + 1, end + 1 + Number(length)).toString());
    offset = end + 2 + Number(length);
  }
  const workspaces = new Map();
  for (const name of needed.filter(name => /(?:^|\/)package\.json$/.test(name))) {
    const manifest = ts.parseConfigFileTextToJson(name, contents.get(blobs.get(name))).config;
    if (manifest?.name) workspaces.set(manifest.name, posix.dirname(name));
  }
  const repoPath = value => {
    let name = relative(cwd, resolve(value)).split(sep).join('/');
    // TypeScript's package resolver sees workspace packages as installed links.
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/.exec(name);
    if (match && workspaces.has(match[1])) name = posix.join(workspaces.get(match[1]), match[2] ?? '');
    return name;
  };
  const directories = new Set(['.']);
  for (const name of blobs.keys()) {
    for (let dir = posix.dirname(name); !directories.has(dir); dir = posix.dirname(dir)) directories.add(dir);
  }
  const host = {
    fileExists: value => blobs.has(repoPath(value)),
    readFile: value => {
      const id = blobs.get(repoPath(value));
      if (id && !contents.has(id)) contents.set(id, git('cat-file', 'blob', id));
      return contents.get(id);
    },
    directoryExists: value => {
      const name = repoPath(value);
      return directories.has(name) || name.endsWith('node_modules') || /node_modules\/@[^/]+$/.test(name);
    },
    getCurrentDirectory: () => cwd,
    realpath: value => resolve(cwd, repoPath(value)),
  };
  const warnings = [];
  const configs = new Map();
  for (const file of selected.filter(name => blobs.has(name))) {
    const config = ts.findConfigFile(resolve(cwd, posix.dirname(file)), host.fileExists);
    if (!configs.has(config)) {
      const options = config ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, host.readFile).config,
        { ...host, readDirectory: () => [], useCaseSensitiveFileNames: true }, dirname(config)).options : {};
      configs.set(config, { ...options, moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
        customConditions: [...new Set([...(options.customConditions ?? []), SOURCE_CONDITION])] });
    }
    const options = configs.get(config);
    const source = ts.createSourceFile(file, contents.get(blobs.get(file)), ts.ScriptTarget.Latest, true);
    const imports = new Set();
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal)) imports.add(node.argument.literal.text);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) imports.add(node.moduleReference.expression.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      const workspace = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/)?.[1];
      const alias = Object.keys(options.paths ?? {}).some(pattern => pattern.includes('*')
        ? specifier.startsWith(pattern.split('*')[0]) && specifier.endsWith(pattern.split('*')[1]) : pattern === specifier);
      if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !alias && !workspaces.has(workspace)) continue;
      if (ts.resolveModuleName(specifier, resolve(cwd, file), options, host).resolvedModule) continue;
      // Source paths and import strings are arbitrary content. Never emit private diagnostics.
      const label = isPublicRuntimeImportDiagnostic(`${file} ${specifier}`)
        && /^[\w@./*+ -]+$/.test(`${file} ${specifier}`) ? `${file} -> ${specifier}` : '[redacted import]';
      warnings.push(`WARN unresolved committed import: ${label}`);
    }
  }
  return warnings;
}
