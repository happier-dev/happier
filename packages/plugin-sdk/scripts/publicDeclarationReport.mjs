import { basename, dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The single compiler configuration every public-surface reader uses. The
 * author signature-closure assertion and the declaration report must answer
 * type questions from the same program, or one of them reports on a surface the
 * other never saw.
 */
export const PUBLIC_SURFACE_PROGRAM_OPTIONS = Object.freeze({
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ESNext,
});

/** Creates the shared public-surface program from absolute entry module paths. */
export function createPublicSurfaceProgram(rootNames) {
  return ts.createProgram({
    rootNames: [...new Set(rootNames)].sort(),
    options: PUBLIC_SURFACE_PROGRAM_OPTIONS,
  });
}

const DECLARATION_PACKAGE_CACHE = new Map();

/**
 * The package that owns a declaration file, resolved from the nearest
 * `package.json`. Every public-surface reader answers "who declares this?"
 * through this one lookup.
 */
export function declarationPackageMetadata(sourceFile) {
  const sourcePath = resolve(sourceFile.fileName);
  if (DECLARATION_PACKAGE_CACHE.has(sourcePath)) {
    return DECLARATION_PACKAGE_CACHE.get(sourcePath);
  }
  let directory = dirname(sourcePath);
  while (true) {
    const packageJsonPath = resolve(directory, 'package.json');
    if (ts.sys.fileExists(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(ts.sys.readFile(packageJsonPath));
        if (
          packageJson
          && typeof packageJson === 'object'
          && typeof packageJson.name === 'string'
        ) {
          const metadata = Object.freeze({
            name: packageJson.name,
            private: packageJson.private === true,
            root: directory,
            exports: packageJson.exports,
          });
          DECLARATION_PACKAGE_CACHE.set(sourcePath, metadata);
          return metadata;
        }
      } catch {
        DECLARATION_PACKAGE_CACHE.set(sourcePath, null);
        return null;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      DECLARATION_PACKAGE_CACHE.set(sourcePath, null);
      return null;
    }
    directory = parent;
  }
}

const HIDDEN_MODIFIER_KINDS = new Set([
  ts.SyntaxKind.DeclareKeyword,
  ts.SyntaxKind.DefaultKeyword,
  ts.SyntaxKind.ExportKeyword,
]);
// Deliberately not `UseFullyQualifiedType`: it embeds the absolute module path
// of the declaring file, which differs per checkout and would make the record
// drift for reasons that are not API changes.
const NODE_BUILDER_FLAGS = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.InTypeAlias;
const TYPE_FORMAT_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function packageRelativeModule(packageRoot, fileName) {
  return relative(packageRoot, resolve(fileName)).split(sep).join('/');
}

/** `node_modules/<name>/` prefixes a package vendors into its own tarball. */
function bundledDependencyRoots(bundledDependencies) {
  return [...bundledDependencies]
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map((name) => `node_modules/${name}/`)
    .sort((left, right) => compareCodePoints(left, right));
}

/**
 * The package-relative module a declaration belongs to, or `null` when another
 * package declares it.
 *
 * Package ownership is the report's whole partition: a package records the
 * declarations it ships and names its edges into packages the consumer resolves
 * separately. A `bundledDependencies` entry is vendored into this package's own
 * tarball, so its declarations are shipped payload of this package's public
 * surface and belong in this record — nothing else will ever publish them.
 * Anything under a further nested `node_modules` is an ordinary resolved
 * dependency, versioned by `package.json` rather than by this record.
 *
 * This answers "does this package ship it?". Whether a vendored declaration is
 * then recorded in full or named as an edge is `recordOwnedDeclarations`'
 * decision, and it differs between publication and reachability.
 */
function ownedDeclarationModule(packageRoot, bundledRoots, declaration) {
  const relativeModule = packageRelativeModule(packageRoot, declaration.getSourceFile().fileName);
  if (
    relativeModule === ''
    || relativeModule.startsWith('..')
    || /^[A-Za-z]:/u.test(relativeModule)
  ) return null;
  const segments = relativeModule.split('/');
  const nestedIndex = segments.indexOf('node_modules');
  if (nestedIndex === -1) return relativeModule;
  if (segments.indexOf('node_modules', nestedIndex + 1) !== -1) return null;
  return bundledRoots.some((root) => relativeModule.startsWith(root)) ? relativeModule : null;
}

/** Whether an owned module is vendored payload rather than this package's own source. */
function isVendoredModule(bundledRoots, sourceModule) {
  return bundledRoots.some((root) => sourceModule.startsWith(root));
}

function resolvedSymbol(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function keptModifiers(node) {
  const modifiers = (node.modifiers ?? []).filter((modifier) => (
    !HIDDEN_MODIFIER_KINDS.has(modifier.kind)
  ));
  return modifiers.length === 0 ? undefined : modifiers;
}

function isHiddenClassMember(member) {
  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) return true;
  return (member.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword);
}

function classMemberSignature(member) {
  if (ts.isConstructorDeclaration(member)) {
    return ts.factory.updateConstructorDeclaration(
      member,
      keptModifiers(member),
      member.parameters,
      undefined,
    );
  }
  if (ts.isMethodDeclaration(member)) {
    return ts.factory.updateMethodDeclaration(
      member,
      keptModifiers(member),
      member.asteriskToken,
      member.name,
      member.questionToken,
      member.typeParameters,
      member.parameters,
      member.type,
      undefined,
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return ts.factory.updateGetAccessorDeclaration(
      member,
      keptModifiers(member),
      member.name,
      member.parameters,
      member.type,
      undefined,
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return ts.factory.updateSetAccessorDeclaration(
      member,
      keptModifiers(member),
      member.name,
      member.parameters,
      undefined,
    );
  }
  if (ts.isPropertyDeclaration(member)) {
    return ts.factory.updatePropertyDeclaration(
      member,
      keptModifiers(member),
      member.name,
      member.questionToken ?? member.exclamationToken,
      member.type,
      undefined,
    );
  }
  return member;
}

function inferredTypeNode(checker, type, enclosingDeclaration) {
  try {
    return checker.typeToTypeNode(type, enclosingDeclaration, NODE_BUILDER_FLAGS) ?? null;
  } catch {
    return null;
  }
}

/**
 * Projects one declaration onto the node the published contract actually
 * carries: implementation bodies, initializers, private class members and
 * publication modifiers are dropped, and an inferred function return type is
 * materialized so a return-type change cannot hide behind inference.
 */
function publicSignatureNode(checker, declaration) {
  if (ts.isInterfaceDeclaration(declaration)) {
    return ts.factory.updateInterfaceDeclaration(
      declaration,
      keptModifiers(declaration),
      declaration.name,
      declaration.typeParameters,
      declaration.heritageClauses,
      declaration.members,
    );
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return ts.factory.updateTypeAliasDeclaration(
      declaration,
      keptModifiers(declaration),
      declaration.name,
      declaration.typeParameters,
      declaration.type,
    );
  }
  if (ts.isEnumDeclaration(declaration)) {
    return ts.factory.updateEnumDeclaration(
      declaration,
      keptModifiers(declaration),
      declaration.name,
      declaration.members,
    );
  }
  if (ts.isClassDeclaration(declaration)) {
    return ts.factory.updateClassDeclaration(
      declaration,
      keptModifiers(declaration),
      declaration.name,
      declaration.typeParameters,
      declaration.heritageClauses,
      declaration.members
        .filter((member) => !isHiddenClassMember(member))
        .map((member) => classMemberSignature(member)),
    );
  }
  if (ts.isFunctionDeclaration(declaration)) {
    const signature = declaration.type === undefined
      ? checker.getSignatureFromDeclaration(declaration)
      : undefined;
    const returnType = declaration.type ?? (signature
      ? inferredTypeNode(checker, checker.getReturnTypeOfSignature(signature), declaration)
      : null);
    return ts.factory.updateFunctionDeclaration(
      declaration,
      keptModifiers(declaration),
      declaration.asteriskToken,
      declaration.name,
      declaration.typeParameters,
      declaration.parameters,
      returnType ?? undefined,
      undefined,
    );
  }
  return null;
}

function variableSignatureNode(checker, symbol, declaration) {
  const typeNode = declaration.type
    ?? inferredTypeNode(
      checker,
      checker.getTypeOfSymbolAtLocation(symbol, declaration),
      declaration,
    );
  if (typeNode === null) return null;
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [ts.factory.createVariableDeclaration(declaration.name, undefined, typeNode, undefined)],
      ts.NodeFlags.Const,
    ),
  );
}

function printNode(printer, node, sourceFile) {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, sourceFile)
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n');
}

function renderDeclaration(checker, printer, symbol, declaration) {
  const sourceFile = declaration.getSourceFile();
  const signature = publicSignatureNode(checker, declaration);
  if (signature !== null) return printNode(printer, signature, sourceFile);
  if (ts.isVariableDeclaration(declaration)) {
    const variableSignature = variableSignatureNode(checker, symbol, declaration);
    if (variableSignature !== null) return printNode(printer, variableSignature, sourceFile);
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    return `const ${symbol.getName()}: ${checker.typeToString(type, declaration, TYPE_FORMAT_FLAGS)};`;
  }
  return printNode(printer, declaration, sourceFile);
}

function declarationKey(node) {
  return `${resolve(node.getSourceFile().fileName)}:${node.pos}:${node.end}`;
}

function positionKey(node) {
  return `${resolve(node.getSourceFile().fileName)}:${String(node.pos).padStart(12, '0')}`;
}

function orderedDeclarations(symbol) {
  return [...(symbol.declarations ?? [])]
    .filter((declaration) => !ts.isSourceFile(declaration))
    .sort((left, right) => compareCodePoints(positionKey(left), positionKey(right)));
}

/** Named type positions a declaration reaches directly. */
function collectReferencedTypeNames(declaration, referenceNodes) {
  const visit = (node) => {
    if (ts.isTypeReferenceNode(node)) {
      referenceNodes.push(ts.isQualifiedName(node.typeName) ? node.typeName.left : node.typeName);
    } else if (ts.isExpressionWithTypeArguments(node)) {
      referenceNodes.push(node.expression);
    } else if (ts.isTypeQueryNode(node)) {
      referenceNodes.push(ts.isQualifiedName(node.exprName) ? node.exprName.left : node.exprName);
    } else if (ts.isImportTypeNode(node) && node.qualifier !== undefined) {
      referenceNodes.push(
        ts.isQualifiedName(node.qualifier) ? node.qualifier.left : node.qualifier,
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration, visit);
}

function declaredName(declaration, fallback) {
  const name = declaration.name;
  if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
  return fallback;
}

function renderBlock(heading, origin, declarationText) {
  return `${heading}\n\n${origin}\n\n\`\`\`ts\n${declarationText}\n\`\`\`\n`;
}

function foreignDeclarationOwner(program, declaration) {
  const sourceFile = declaration.getSourceFile();
  if (program.isSourceFileDefaultLibrary(sourceFile)) return null;
  return declarationPackageMetadata(sourceFile)?.name ?? basename(sourceFile.fileName);
}

/**
 * The published export rows of a package whose entrypoint barrels are the
 * authored surface, for packages that publish no separate inventory. The rows
 * it returns are the same shape `api-surface.json` produces, so both kinds of
 * package reach the declaration record through one projection.
 *
 * @param {{
 *   program: import('typescript').Program,
 *   packageRoot: string,
 *   entrypoints: readonly Readonly<{ specifier: string, sourceModule: string }>[],
 * }} input
 */
export function projectEntrypointExportRows({ program, packageRoot, entrypoints }) {
  const resolvedPackageRoot = resolve(packageRoot);
  const checker = program.getTypeChecker();
  const rows = [];
  const missing = [];
  for (const entrypoint of entrypoints) {
    const absolutePath = resolve(resolvedPackageRoot, entrypoint.sourceModule);
    const sourceFile = program.getSourceFile(absolutePath)
      ?? program.getSourceFiles().find((candidate) => resolve(candidate.fileName) === absolutePath);
    const moduleSymbol = sourceFile === undefined
      ? undefined
      : checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) {
      missing.push(entrypoint.sourceModule);
      continue;
    }
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolvedSymbol(checker, exported);
      rows.push(Object.freeze({
        specifier: entrypoint.specifier,
        exportName: exported.name,
        kind: (symbol.flags & ts.SymbolFlags.Value) === 0 ? 'type' : 'value',
        sourceModule: entrypoint.sourceModule,
        sourceExport: exported.name,
      }));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Public declaration report cannot read entrypoint modules: ${[...new Set(missing)].sort().join(', ')}`,
    );
  }
  return Object.freeze(rows.sort((left, right) => compareCodePoints(
    `${left.specifier} ${left.exportName}`,
    `${right.specifier} ${right.exportName}`,
  )));
}

/**
 * The single owner of the public declaration record for a published package.
 *
 * `api-surface.json` records which names a package publishes; it cannot record
 * what those names mean, so `timeout?: number` becoming `timeout: number` — or
 * a widened parameter, a changed return type, or a narrowed union — produces a
 * byte-identical inventory. This projects the normalized declaration behind
 * every published export, the package-owned declarations those signatures
 * reach, and the named edges into other packages, so every declaration
 * difference this package owns is a reviewable diff.
 *
 * It deliberately classifies nothing as breaking or additive: visibility is the
 * contract, and the compatibility decision stays with the human publishing the
 * release.
 *
 * @param {{
 *   program: import('typescript').Program,
 *   packageRoot: string,
 *   title: string,
 *   bundledDependencies?: readonly string[],
 *   rows: readonly Readonly<{
 *     specifier: string,
 *     exportName: string,
 *     kind: 'type' | 'value',
 *     sourceModule: string,
 *     sourceExport: string,
 *   }>[],
 * }} input
 */
export function projectPublicDeclarationReport({
  program,
  packageRoot,
  title,
  rows,
  bundledDependencies = [],
}) {
  const resolvedPackageRoot = resolve(packageRoot);
  const bundledRoots = bundledDependencyRoots(bundledDependencies);
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const sourceFileByModule = new Map();
  const sourceFileFor = (sourceModule) => {
    if (!sourceFileByModule.has(sourceModule)) {
      const absolutePath = resolve(resolvedPackageRoot, sourceModule);
      sourceFileByModule.set(
        sourceModule,
        program.getSourceFile(absolutePath)
          ?? program.getSourceFiles().find((candidate) => (
            resolve(candidate.fileName) === absolutePath
          ))
          ?? null,
      );
    }
    return sourceFileByModule.get(sourceModule);
  };

  const publishedBlocks = [];
  const emittedDeclarationKeys = new Set();
  const pendingReferenceNodes = [];
  const foreignEdges = new Set();
  const unresolved = [];

  /**
   * The declarations a symbol contributes to the record, recording a named edge
   * for the rest.
   *
   * Publication rows record a vendored declaration in full: it is shipped
   * payload of this package's tarball, so nothing else will ever publish it.
   * The reachability walk stops at that same boundary instead. A vendored
   * declaration reached from a signature is the vendored package's own internal
   * contract — it carries no published export, its version is pinned by
   * `package.json`, and the checker collapses its deep generics to `any`, so
   * inlining it and recursing through it buys bulk that cannot produce the
   * reviewable diff this record exists for. The named edge keeps the
   * attribution at a fraction of the size.
   */
  const recordOwnedDeclarations = (symbol, { includeVendored }) => {
    const owned = [];
    for (const declaration of orderedDeclarations(symbol)) {
      const sourceModule = ownedDeclarationModule(resolvedPackageRoot, bundledRoots, declaration);
      if (sourceModule !== null && (includeVendored || !isVendoredModule(bundledRoots, sourceModule))) {
        owned.push({ declaration, sourceModule });
        continue;
      }
      const owner = foreignDeclarationOwner(program, declaration);
      if (owner !== null) {
        foreignEdges.add(`${owner}#${declaredName(declaration, symbol.getName())}`);
      }
    }
    return owned;
  };

  for (const row of [...rows].sort((left, right) => compareCodePoints(
    `${left.specifier} ${left.exportName}`,
    `${right.specifier} ${right.exportName}`,
  ))) {
    const heading = `### \`${row.specifier}\` — \`${row.exportName}\` (${row.kind})`;
    const sourceFile = sourceFileFor(row.sourceModule);
    const moduleSymbol = sourceFile === null ? null : checker.getSymbolAtLocation(sourceFile);
    const exported = moduleSymbol === null
      ? undefined
      : checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === row.sourceExport);
    if (exported === undefined) {
      unresolved.push(`${row.specifier}:${row.exportName}`);
      continue;
    }
    const symbol = resolvedSymbol(checker, exported);
    if (orderedDeclarations(symbol).length === 0) {
      unresolved.push(`${row.specifier}:${row.exportName}`);
      continue;
    }
    const owned = recordOwnedDeclarations(symbol, { includeVendored: true });
    if (owned.length === 0) {
      publishedBlocks.push(renderBlock(
        heading,
        `Re-exported from another package as \`${symbol.getName()}\`; that package owns the declaration.`,
        '// declared by another package — see its own declaration report',
      ));
      continue;
    }
    for (const entry of owned) {
      emittedDeclarationKeys.add(declarationKey(entry.declaration));
      collectReferencedTypeNames(entry.declaration, pendingReferenceNodes);
    }
    publishedBlocks.push(renderBlock(
      heading,
      `Declared by \`${owned[0].sourceModule}\` as \`${symbol.getName()}\`.`,
      owned
        .map((entry) => renderDeclaration(checker, printer, symbol, entry.declaration))
        .join('\n'),
    ));
  }

  if (unresolved.length > 0) {
    throw new Error(
      `Public declaration report cannot resolve published exports: ${[...new Set(unresolved)].sort().join(', ')}`,
    );
  }

  const reachableBlocks = [];
  const visitedReferenceNodes = new Set();
  while (pendingReferenceNodes.length > 0) {
    const referenceNode = pendingReferenceNodes.pop();
    const referenceKey = declarationKey(referenceNode);
    if (visitedReferenceNodes.has(referenceKey)) continue;
    visitedReferenceNodes.add(referenceKey);
    const located = checker.getSymbolAtLocation(referenceNode);
    if (!located) continue;
    const symbol = resolvedSymbol(checker, located);
    if ((symbol.flags & ts.SymbolFlags.TypeParameter) !== 0) continue;
    for (const entry of recordOwnedDeclarations(symbol, { includeVendored: false })) {
      const key = declarationKey(entry.declaration);
      if (emittedDeclarationKeys.has(key)) continue;
      emittedDeclarationKeys.add(key);
      const name = declaredName(entry.declaration, symbol.getName());
      reachableBlocks.push({
        // `sourceModule` already identifies the file, so the tiebreak is the
        // in-file position: no absolute path reaches the ordering.
        key: `${entry.sourceModule} ${name} ${String(entry.declaration.pos).padStart(12, '0')}`,
        block: renderBlock(
          `### \`${entry.sourceModule}\` — \`${name}\``,
          'Reached from a published signature; not itself a published export.',
          renderDeclaration(checker, printer, symbol, entry.declaration),
        ),
      });
      collectReferencedTypeNames(entry.declaration, pendingReferenceNodes);
    }
  }
  reachableBlocks.sort((left, right) => compareCodePoints(left.key, right.key));

  return [
    `# ${title}`,
    '',
    '> Generated from package source. Do not hand-edit.',
    '> Records the normalized declaration behind every published export, plus the',
    '> declarations those signatures reach, so no signature this package ships can',
    '> change without a reviewable diff. Implementation bodies, initializers, private',
    '> class members and comments are omitted; inferred value and return types are',
    '> materialized.',
    '> Every published export is recorded in full, including one a `bundledDependencies`',
    '> package declares, because this tarball vendors it and nothing else will publish it.',
    '> Reachability then stops at that boundary: a declaration reached only through a',
    '> signature, and declared by another package — vendored or resolved separately — is',
    '> recorded as a named edge, because that package owns its own internals and',
    '> `package.json` already pins the version that supplies them.',
    '> Whether a difference is breaking or additive stays a publishing decision.',
    '',
    '## Published exports',
    '',
    ...publishedBlocks.flatMap((block) => [block, '']),
    '## Reachable package-owned declarations',
    '',
    ...(reachableBlocks.length === 0
      ? ['_Every type reached by a published signature is itself a published export._', '']
      : reachableBlocks.flatMap((entry) => [entry.block, ''])),
    '## Referenced declarations owned by other packages',
    '',
    ...(foreignEdges.size === 0
      ? ['_No published signature reaches a type another package declares._', '']
      : [
        ...[...foreignEdges]
          .sort((left, right) => compareCodePoints(left, right))
          .map((edge) => `- \`${edge}\``),
        '',
      ]),
  ].join('\n').replace(/\n+$/u, '\n');
}
