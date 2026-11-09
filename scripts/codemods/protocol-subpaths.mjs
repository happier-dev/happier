// Development-only migration: resolve existing public exports by declaration
// identity, then change imports without printing/reformatting the source file.
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');
const rootSpecifier = '@happier-dev/protocol';
const parse = (source, file) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);

export function buildExportMap(repoRoot) {
  const protocolRoot = join(repoRoot, 'packages/protocol');
  const packageJson = JSON.parse(readFileSync(join(protocolRoot, 'package.json'), 'utf8'));
  const cache = new Map();
  const resolveRelative = (file, specifier) => {
    const base = resolve(dirname(file), specifier.replace(/\.js$/, ''));
    return [`${base}.ts`, `${base}.tsx`, base, join(base, 'index.ts')].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  };
  function exportsOf(file, visiting = new Set()) {
    if (cache.has(file)) return cache.get(file);
    if (visiting.has(file)) return new Map();
    const active = new Set([...visiting, file]);
    const ast = parse(readFileSync(file, 'utf8'), file);
    const result = new Map(), imports = new Map(), stars = [];
    const bindingNames = name => ts.isIdentifier(name) ? [name.text]
      : name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const binding of statement.importClause.namedBindings.elements) {
          imports.set(binding.name.text, { module: statement.moduleSpecifier.text, name: binding.propertyName?.text ?? binding.name.text });
        }
      }
    }
    const origin = (module, name) => {
      if (!module.startsWith('.')) return `${module}#${name}`;
      const target = resolveRelative(file, module);
      return target ? exportsOf(target, active).get(name) : undefined;
    };
    for (const statement of ast.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (!statement.exportClause) {
          if (statement.moduleSpecifier?.text.startsWith('.')) stars.push(resolveRelative(file, statement.moduleSpecifier.text));
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const binding of statement.exportClause.elements) {
            const name = binding.propertyName?.text ?? binding.name.text;
            const imported = imports.get(name);
            const identity = statement.moduleSpecifier ? origin(statement.moduleSpecifier.text, name)
              : imported ? origin(imported.module, imported.name) : `${file}#${name}`;
            if (identity) result.set(binding.name.text, identity);
          }
        }
      } else if (exported(statement)) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            for (const name of bindingNames(declaration.name)) result.set(name, `${file}#${name}`);
          }
        } else if (statement.name && ts.isIdentifier(statement.name)) result.set(statement.name.text, `${file}#${statement.name.text}`);
      }
    }
    // Explicit exports have precedence over star re-exports, as in JavaScript.
    for (const target of stars) if (target) {
      for (const [name, identity] of exportsOf(target, active)) if (!result.has(name)) result.set(name, identity);
    }
    cache.set(file, result);
    return result;
  }
  const sourceTarget = value => typeof value === 'string' ? (value.startsWith('./src/') ? value : undefined)
    : value && (sourceTarget(value['happier-source']) ?? sourceTarget(value.browser) ?? sourceTarget(value['react-native']));
  const rootExports = exportsOf(join(protocolRoot, 'src/index.ts'));
  const candidates = new Map();
  for (const [subpath, value] of Object.entries(packageJson.exports)) {
    if (subpath === '.' || subpath.includes('*')) continue;
    const target = sourceTarget(value);
    if (!target) continue;
    const file = resolve(protocolRoot, target);
    if (!existsSync(file)) continue;
    const moduleExports = exportsOf(file);
    for (const [name, identity] of moduleExports) {
      const entries = candidates.get(identity) ?? [];
      entries.push({ specifier: `${rootSpecifier}${subpath.slice(1)}`, name, file, direct: identity === `${file}#${name}`, exportCount: moduleExports.size });
      candidates.set(identity, entries);
    }
  }
  const mapping = new Map(), unresolved = [];
  for (const [name, identity] of rootExports) {
    const choices = (candidates.get(identity) ?? []).sort((a, b) => Number(b.direct) - Number(a.direct)
      || a.exportCount - b.exportCount
      || Number(b.name === name) - Number(a.name === name)
      || a.specifier.length - b.specifier.length || a.specifier.localeCompare(b.specifier));
    if (choices.length) mapping.set(name, { ...choices[0], identity });
    else unresolved.push({ name, identity: identity.replace(repoRoot, '.') });
  }
  return { mapping, unresolved, rootExports: rootExports.size };
}

export function transformImports(source, fileName, mapping) {
  const ast = parse(source, fileName), edits = [], unresolved = [], imports = [];
  const line = node => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier?.text === rootSpecifier) {
      const isImport = ts.isImportDeclaration(node);
      const bindings = isImport ? node.importClause?.namedBindings : node.exportClause;
      if ((isImport && node.importClause?.name) || !bindings || !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        unresolved.push({ line: line(node), kind: 'non-named-import' });
        return;
      }
      const groups = new Map();
      let segmentStart = bindings.getStart(ast) + 1;
      for (let index = 0; index < bindings.elements.length; index++) {
        const binding = bindings.elements[index];
        const name = binding.propertyName?.text ?? binding.name.text;
        const target = mapping.get(name);
        imports.push({ line: line(node), name, target: target?.specifier, identity: target?.identity });
        if (!target) { unresolved.push({ line: line(node), kind: 'missing-export', name }); continue; }
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.slice(binding.end, bindings.end - 1));
        let token;
        while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken && token !== ts.SyntaxKind.CommaToken) { /* retain trivia */ }
        const segmentEnd = index === bindings.elements.length - 1 ? bindings.end - 1
          : binding.end + scanner.getTokenPos();
        const start = segmentStart;
        let text = source.slice(start, segmentEnd);
        segmentStart = segmentEnd + 1;
        if (target.name !== name) {
          const nameNode = binding.propertyName ?? binding.name;
          const offset = nameNode.getStart(ast) - start;
          text = text.slice(0, offset) + target.name + (binding.propertyName ? '' : ` as ${binding.name.text}`) + text.slice(offset + name.length);
        }
        const entries = groups.get(target.specifier) ?? [];
        entries.push(text); groups.set(target.specifier, entries);
      }
      if (unresolved.some(issue => issue.line === line(node))) return;
      if (groups.size === 1 && bindings.elements.every(binding => mapping.get(binding.propertyName?.text ?? binding.name.text).name === (binding.propertyName?.text ?? binding.name.text))) {
        const [specifier] = groups.keys();
        edits.push({ start: node.moduleSpecifier.getStart(ast) + 1, end: node.moduleSpecifier.end - 1, text: specifier });
        return;
      }
      const quote = source[node.moduleSpecifier.getStart(ast)];
      const suffix = source.slice(node.moduleSpecifier.end, node.end);
      const isTypeOnly = isImport ? node.importClause.isTypeOnly : node.isTypeOnly;
      const statements = [...groups].map(([specifier, entries]) => `${isImport ? 'import' : 'export'}${isTypeOnly ? ' type' : ''} {${entries.join(',')}} from ${quote}${specifier}${quote}${suffix}`);
      edits.push({ start: node.getStart(ast), end: node.end, text: statements.join('\n') });
      return;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && node.argument.literal.text === rootSpecifier && node.qualifier) {
      let qualifier = node.qualifier;
      while (ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      const target = mapping.get(qualifier.text);
      imports.push({ line: line(node), name: qualifier.text, target: target?.specifier, identity: target?.identity, kind: 'type-query' });
      if (!target) unresolved.push({ line: line(node), kind: 'missing-export', name: qualifier.text });
      else {
        edits.push({ start: node.argument.literal.getStart(ast) + 1, end: node.argument.literal.end - 1, text: target.specifier });
        if (target.name !== qualifier.text) edits.push({ start: qualifier.getStart(ast), end: qualifier.end, text: target.name });
      }
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && !node.type
      && node.initializer && ts.isAwaitExpression(node.initializer) && ts.isCallExpression(node.initializer.expression)
      && (node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
        || node.initializer.expression.expression.getText(ast) === 'vi.importActual')
      && node.initializer.expression.arguments[0]?.text === rootSpecifier) {
      const groups = new Map();
      let segmentStart = node.name.getStart(ast) + 1;
      for (const binding of node.name.elements) {
        const name = binding.propertyName?.getText(ast) ?? binding.name.getText(ast);
        const target = mapping.get(name);
        imports.push({ line: line(node), name, target: target?.specifier, identity: target?.identity, kind: 'dynamic' });
        if (!target || binding.dotDotDotToken) { unresolved.push({ line: line(node), kind: 'dynamic-binding', name }); continue; }
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.slice(binding.end, node.name.end - 1));
        let token;
        while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken && token !== ts.SyntaxKind.CommaToken) { /* retain trivia */ }
        const segmentEnd = binding === node.name.elements.at(-1) ? node.name.end - 1 : binding.end + scanner.getTokenPos();
        let text = source.slice(segmentStart, segmentEnd);
        if (target.name !== name) {
          const nameNode = binding.propertyName ?? binding.name;
          const offset = nameNode.getStart(ast) - segmentStart;
          text = text.slice(0, offset) + target.name + (binding.propertyName ? '' : `: ${name}`) + text.slice(offset + name.length);
        }
        segmentStart = segmentEnd + 1;
        const entries = groups.get(target.specifier) ?? [];
        entries.push(text); groups.set(target.specifier, entries);
      }
      if (unresolved.some(issue => issue.line === line(node))) return;
      const quote = source[node.initializer.expression.arguments[0].getStart(ast)];
      const patterns = [...groups.values()].map(entries => `{${entries.join(',')}}`);
      const callee = node.initializer.expression.expression.getText(ast);
      const calls = [...groups.keys()].map(specifier => `${callee}${node.initializer.expression.typeArguments?.length ? `<typeof import(${quote}${specifier}${quote})>` : ''}(${quote}${specifier}${quote})`);
      if (groups.size === 1) {
        edits.push({ start: node.name.getStart(ast), end: node.name.end, text: patterns[0] });
        edits.push({ start: node.initializer.getStart(ast), end: node.initializer.end, text: `await ${calls[0]}` });
      } else {
        edits.push({ start: node.name.getStart(ast), end: node.name.end, text: `[${patterns.join(', ')}]` });
        edits.push({ start: node.initializer.getStart(ast), end: node.initializer.end, text: `await Promise.all([${calls.join(', ')}])` });
      }
      return;
    }
    if (ts.isStringLiteral(node) && node.text === rootSpecifier && ts.isCallExpression(node.parent)
      && (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword || /^(?:require|vi\.(?:mock|doMock|importActual|importMock))$/.test(node.parent.expression.getText(ast)))) {
      unresolved.push({ line: line(node), kind: 'call', text: node.parent.parent.getText(ast).slice(0, 240) });
    }
  }
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)
      && !(ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && node.argument.literal.text === rootSpecifier)
      && !(ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isAwaitExpression(node.initializer)
        && ts.isCallExpression(node.initializer.expression) && (node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
          || node.initializer.expression.expression.getText(ast) === 'vi.importActual') && node.initializer.expression.arguments[0]?.text === rootSpecifier)) {
      ts.forEachChild(node, child => { pending.push(child); });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { source, imports, unresolved };
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || ['node_modules', 'ios', 'android'].includes(entry.name) || /^(?:dist|build)(?:-|$)/.test(entry.name) || entry.name.startsWith('.')) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

export function inputFiles(repoRoot, args) {
  const selected = args.filter(argument => argument.startsWith('--file=')).map(argument => resolve(repoRoot, argument.slice('--file='.length)));
  if (args.includes('--write') && !selected.length) throw new Error('Write mode requires explicit --file=<path> inputs.');
  return selected.length ? [...new Set(selected)] : sourceFiles(join(repoRoot, 'apps/ui'));
}

export function applyMigration(file, expectedSource, mapping) {
  const currentSource = readFileSync(file, 'utf8');
  if (currentSource !== expectedSource) {
    return { source: currentSource, imports: [], unresolved: [{ kind: 'input-changed' }], written: false };
  }
  const result = transformImports(currentSource, file, mapping);
  if (result.source === currentSource) return { ...result, written: false };
  const diagnostics = parse(result.source, file).parseDiagnostics;
  if (diagnostics.length) {
    return { ...result, source: currentSource, unresolved: [...result.unresolved, {
      kind: 'invalid-output-syntax', diagnostics: diagnostics.map(diagnostic => ({ code: diagnostic.code, start: diagnostic.start })),
    }], written: false };
  }
  const temporary = `${file}.protocol-subpaths-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, result.source);
    const beforeRename = readFileSync(file, 'utf8');
    if (beforeRename !== currentSource) {
      return { ...result, source: beforeRename, unresolved: [...result.unresolved, { kind: 'input-changed' }], written: false };
    }
    renameSync(temporary, file);
    return { ...result, written: true };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const inputs = inputFiles(repoRoot, process.argv.slice(2));
  const { mapping, unresolved: missingExports, rootExports } = buildExportMap(repoRoot);
  const files = [];
  for (const file of inputs) {
    const source = readFileSync(file, 'utf8');
    if (!/(['"])@happier-dev\/protocol\1/.test(source)) continue;
    const result = process.argv.includes('--write') ? applyMigration(file, source, mapping) : transformImports(source, relative(repoRoot, file), mapping);
    if (!result.imports.length && !result.unresolved.length) continue;
    files.push({ file: relative(repoRoot, file), imports: result.imports, unresolved: result.unresolved,
      changed: 'written' in result ? result.written : result.source !== source });
  }
  const report = { rootExports, mappedExports: mapping.size, missingExports, files };
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex !== -1) {
    const path = resolve(process.argv[reportIndex + 1]);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  const issues = files.flatMap(file => file.unresolved.map(issue => ({ file: file.file, ...issue })));
  console.log(JSON.stringify({ rootExports, mappedExports: mapping.size, files: files.length,
    imports: files.reduce((count, file) => count + file.imports.length, 0),
    unresolvedKinds: Object.fromEntries([...new Set(issues.map(issue => issue.kind))].map(kind => [kind, issues.filter(issue => issue.kind === kind).length])),
    missingSymbols: [...new Set(issues.filter(issue => issue.kind === 'missing-export' || issue.kind === 'dynamic-binding').map(issue => issue.name))]
      .map(name => ({ name, identity: missingExports.find(entry => entry.name === name)?.identity })),
    unresolvedExamples: [...new Set(issues.map(issue => issue.kind))].flatMap(kind => issues.filter(issue => issue.kind === kind).slice(0, 3)),
    changedFiles: files.filter(file => file.changed).length }, null, 2));
}
