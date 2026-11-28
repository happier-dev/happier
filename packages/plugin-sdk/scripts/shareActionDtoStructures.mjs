import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

function importPath(from, to) {
  const path = relative(dirname(from), to).replaceAll('\\', '/').replace(/\.ts$/u, '.js');
  return path.startsWith('.') ? path : `./${path}`;
}

function countLines(text) {
  return text.split('\n').length - 1;
}

function isShape(node) {
  return ts.isTypeLiteralNode(node) || ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node);
}

function introducesTypeBindings(node) {
  return node.typeParameters?.length || ts.isMappedTypeNode(node) || ts.isConditionalTypeNode(node);
}

function readBindings(path, source) {
  const bindings = new Map();
  for (const node of source.statements) {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      bindings.set(node.name.text, { path, imported: node.name.text,
        private: !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) });
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith('.') && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)) {
      const owner = resolve(dirname(path), node.moduleSpecifier.text.replace(/\.js$/u, '.ts'));
      for (const binding of node.importClause.namedBindings.elements) {
        bindings.set(binding.name.text, { path: owner, imported: (binding.propertyName ?? binding.name).text });
      }
    }
  }
  return bindings;
}

function readShapeReferences(node, bindings, builtins) {
  const references = new Map();
  const unsafe = child => {
    if (introducesTypeBindings(child) || ts.isTypeQueryNode(child) || ts.isImportTypeNode(child)
      || ts.isThisTypeNode(child) || ts.isInferTypeNode(child) || ts.isComputedPropertyName(child)
      || (ts.isTypeOperatorNode(child) && child.operator === ts.SyntaxKind.UniqueKeyword)) return true;
    if (ts.isTypeReferenceNode(child)) {
      if (!ts.isIdentifier(child.typeName)) return true;
      const name = child.typeName.text;
      const binding = bindings.get(name);
      if (binding?.private) return true;
      if (binding) references.set(name, binding);
      else if (!builtins.has(name)) return true;
    }
    return ts.forEachChild(child, unsafe);
  };
  return unsafe(node) ? null : references;
}

function render(text, start, end, candidates, appendReference) {
  let result = '';
  for (const candidate of candidates) {
    result += text.slice(start, candidate.start);
    result += candidate.group.name
      ? appendReference(candidate.group)
      : render(text, candidate.start, candidate.end, candidate.children, appendReference);
    start = candidate.end;
  }
  return result + text.slice(start, end);
}

function renderImports(path, references) {
  const byModule = new Map();
  for (const [local, binding] of references) {
    const specifier = importPath(path, binding.path);
    if (!byModule.has(specifier)) byModule.set(specifier, []);
    byModule.get(specifier).push(local === binding.imported ? local : `${binding.imported} as ${local}`);
  }
  return [...byModule].sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, names]) => `import type { ${names.sort().join(', ')} } from '${specifier}';`)
    .join('\n');
}

/**
 * Reuse repeated structural declarations in the validator-free SDK projection.
 * Qualify signatures with their original type bindings. Lexically bound or
 * nominal parts stay in place, where the original declaration owns them.
 */
export function shareActionDtoStructures(declarations, { sharedPath, declarationRoot, builtins }) {
  const shapes = new Map();
  const files = [];
  const referencedBindings = new Map();
  const ambiguousNames = new Set();
  for (const [path, text] of declarations) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const bindings = readBindings(path, source);
    const roots = [];
    const visit = (node, candidates) => {
      if (introducesTypeBindings(node)) return;
      const children = [];
      ts.forEachChild(node, child => visit(child, children));
      if (isShape(node) && !ts.isTypeAliasDeclaration(node.parent) && node.end - node.getStart(source) >= 64) {
        const references = readShapeReferences(node, bindings, builtins);
        if (references !== null) {
          const body = printer.printNode(ts.EmitHint.Unspecified, node, source);
          if (countLines(body) > 1) {
            const scope = [...references].sort(([a], [b]) => a.localeCompare(b))
              .map(([name, binding]) => [name, relative(declarationRoot, binding.path).replaceAll('\\', '/'), binding.imported]);
            for (const [name, owner, imported] of scope) {
              const identity = JSON.stringify([owner, imported]);
              const previous = referencedBindings.get(name);
              if (previous !== undefined && previous !== identity) ambiguousNames.add(name);
              referencedBindings.set(name, identity);
            }
            const key = JSON.stringify([body, scope]);
            let group = shapes.get(key);
            if (!group) {
              group = { count: 0, references, text, start: node.getStart(source), end: node.end, children };
              shapes.set(key, group);
            }
            group.count++;
            candidates.push({ group, start: node.getStart(source), end: node.end, children });
            return;
          }
        }
      }
      candidates.push(...children);
    };
    for (const node of source.statements) {
      if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) visit(node, roots);
    }
    if (roots.length) files.push({ path, text, roots });
  }

  for (const [key, group] of shapes) {
    if (group.count < 2 || [...group.references.keys()].some(name => ambiguousNames.has(name))) continue;
    group.name = 'ActionDtoShape_' + createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  const shared = new Map();
  const output = new Map(declarations);
  for (const { path, text, roots } of files) {
    const imports = new Map();
    const body = render(text, 0, text.length, roots, group => {
      imports.set(group.name, { path: sharedPath, imported: group.name });
      shared.set(group.name, group);
      return group.name;
    });
    if (imports.size > 0) output.set(path, renderImports(path, imports) + '\n' + body);
  }

  if (shared.size === 0) return declarations;
  const references = new Map();
  const aliases = new Map();
  // Map iteration includes declarations added by an already selected alias.
  for (const [name, group] of shared) {
    for (const [local, dependency] of group.references) references.set(local, dependency);
    const body = render(group.text, group.start, group.end, group.children, nested => {
      shared.set(nested.name, nested);
      return nested.name;
    });
    aliases.set(name, `export type ${name} = ${body};`);
  }
  output.set(sharedPath, [renderImports(sharedPath, references), ...[...aliases].sort(([a], [b]) => a.localeCompare(b))
    .map(([, alias]) => alias)].join('\n'));
  return output;
}
