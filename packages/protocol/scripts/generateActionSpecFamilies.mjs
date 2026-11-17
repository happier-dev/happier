// Generates src/actions/actionSpecFamilies.generated.ts from the Action catalog in src/actions/actionSpecs.ts.
//
// The catalog aggregates ~170 family arrays behind lazy spreads. A lookup by id must not evaluate every
// family: under Metro's inline requires each family module is evaluated only when it is first read, and
// building the whole declaration index before Home evaluated ~270 modules (P03-BOOT-CUT). This file is the
// catalog's own routing table: the families in catalog order, as unevaluated readers, and the ids each
// family declares. It is derived from the catalog and checked by actionSpecFamilies.test.ts.
//
// usage: node scripts/generateActionSpecFamilies.mjs [--check]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = resolve(PACKAGE_ROOT, 'src/actions/actionSpecs.ts');
const OUTPUT_PATH = resolve(PACKAGE_ROOT, 'src/actions/actionSpecFamilies.generated.ts');
const ROOT_GROUP = 'ACTION_SPECS_WITHOUT_APPROVAL';

/** Families in catalog order (depth-first through the catalog's lazy groups) and the imports they read. */
export function readActionSpecCatalogFamilies(source = readFileSync(CATALOG_PATH, 'utf8')) {
  const file = ts.createSourceFile(CATALOG_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const initializers = new Map();
  const imports = new Map();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        imports.set(element.name.text, { specifier: statement.moduleSpecifier.text, imported: element.propertyName?.text ?? element.name.text });
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) initializers.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const strip = (expression) => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) current = current.expression;
    return current;
  };
  const groupElements = (name) => {
    const initializer = initializers.get(name);
    if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText(file) !== 'lazyActionSpecArray') return null;
    const create = initializer.arguments[0];
    if (!create || !ts.isArrowFunction(create)) return null;
    let body = strip(create.body);
    if (ts.isCallExpression(body) && body.expression.getText(file) === 'Object.freeze') body = strip(body.arguments[0]);
    if (ts.isCallExpression(body) && body.expression.getText(file) === 'defineActionSpecs') body = strip(body.arguments[0]);
    return ts.isArrayLiteralExpression(body) ? body.elements : null;
  };
  const families = [];
  const visit = (name) => {
    const elements = groupElements(name);
    if (!elements) throw new Error(`actionSpecs.ts: ${name} is not a lazyActionSpecArray group of spreads`);
    for (const element of elements) {
      if (!ts.isSpreadElement(element)) throw new Error(`actionSpecs.ts: ${name} holds a non-spread row: ${element.getText(file)}`);
      const family = strip(element.expression);
      if (ts.isIdentifier(family) && groupElements(family.text)) {
        visit(family.text);
        continue;
      }
      families.push(family);
    }
  };
  visit(ROOT_GROUP);
  const used = new Map();
  const reader = (family) => {
    // An identity projection only widens the row type; read the family itself.
    if (ts.isCallExpression(family) && ts.isPropertyAccessExpression(family.expression) && family.expression.name.text === 'map'
      && family.arguments.length === 1 && ts.isArrowFunction(family.arguments[0])) {
      const [parameter] = family.arguments[0].parameters;
      const body = family.arguments[0].body;
      if (parameter && ts.isIdentifier(parameter.name) && ts.isIdentifier(body) && body.text === parameter.name.text) {
        return reader(strip(family.expression.expression));
      }
    }
    const collect = (node) => {
      if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        const binding = imports.get(node.text);
        if (!binding) throw new Error(`actionSpecs.ts: family reads ${node.text}, which is not a value import`);
        used.set(node.text, binding);
      }
      ts.forEachChild(node, collect);
    };
    collect(family);
    return family.getText(file);
  };
  return { readers: families.map(reader), imports: used };
}

function renderModule({ readers, imports }, idsByFamily, resolveSpecifier = (specifier) => specifier, uiPlacementIds = {}) {
  const bySpecifier = new Map();
  for (const [local, { specifier, imported }] of imports) {
    if (!bySpecifier.has(specifier)) bySpecifier.set(specifier, []);
    bySpecifier.get(specifier).push(imported === local ? local : `${imported} as ${local}`);
  }
  const importLines = [...bySpecifier.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, names]) => `import { ${names.sort().join(', ')} } from '${resolveSpecifier(specifier)}';`);
  return [
    '// Generated by packages/protocol/scripts/generateActionSpecFamilies.mjs from actionSpecs.ts. Do not edit by hand.',
    '// The catalog families in catalog order, unevaluated until one of their ids is looked up.',
    ...importLines,
    '',
    'type ActionSpecFamilyRows = readonly Readonly<{ id: string }>[];',
    '',
    'export const ACTION_SPEC_FAMILY_READERS: readonly (() => ActionSpecFamilyRows)[] = [',
    ...readers.map((reader) => `  () => ${reader},`),
    '];',
    '',
    '/** The ids each family declares, parallel to ACTION_SPEC_FAMILY_READERS. */',
    'export const ACTION_SPEC_FAMILY_IDS: readonly (readonly string[])[] = [',
    ...idsByFamily.map((ids) => `  [${ids.map((id) => JSON.stringify(id)).join(', ')}],`),
    '];',
    '',
    '/** UI-surfaced Actions by declared placement, in catalog order (normalized catalog facts). */',
    'export const ACTION_SPEC_UI_PLACEMENT_IDS: Readonly<Record<string, readonly string[]>> = {',
    ...Object.entries(uiPlacementIds).sort(([a], [b]) => a.localeCompare(b))
      .map(([placement, ids]) => `  ${JSON.stringify(placement)}: [${ids.map((id) => JSON.stringify(id)).join(', ')}],`),
    '};',
    '',
  ].join('\n');
}

/** Reads each family's ids by evaluating a readers-only module against the current catalog sources. */
function readFamilyIds(families) {
  // The catalog imports this module, so a first generation starts from empty routing
  // (lookups then resolve through the whole catalog until the real file is written).
  const stub = renderModule({ readers: [], imports: new Map() }, []);
  const exported = (text) => [...text.matchAll(/^export const (\w+)/gmu)].map((match) => match[1]).join();
  if (!existsSync(OUTPUT_PATH) || exported(readFileSync(OUTPUT_PATH, 'utf8')) !== exported(stub)) writeFileSync(OUTPUT_PATH, stub);
  // The probe lives outside the source tree and imports the catalog modules by absolute URL.
  const actionsDir = dirname(CATALOG_PATH);
  const probe = renderModule(families, families.readers.map(() => []),
    (specifier) => pathToFileURL(resolve(actionsDir, specifier)).href);
  const directory = mkdtempSync(join(tmpdir(), 'action-spec-families-'));
  try {
    const probePath = join(directory, 'probe.ts');
    writeFileSync(probePath, probe);
    const script = `const m = await import(${JSON.stringify(pathToFileURL(probePath).href)});`
      + `const c = await import(${JSON.stringify(pathToFileURL(CATALOG_PATH).href)});`
      + 'const placements = {}; for (const spec of c.listActionSpecs()) { if (spec.surfaces.ui !== true) continue;'
      + ' for (const placement of spec.placements ?? []) (placements[placement] ??= []).push(spec.id); }'
      + 'console.log(JSON.stringify({ families: m.ACTION_SPEC_FAMILY_READERS.map((read) => read().map((row) => row.id)), placements }));';
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: PACKAGE_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`reading family ids failed:\n${result.stderr}`);
    return JSON.parse(result.stdout.trim().split('\n').pop());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function renderActionSpecFamilies() {
  const families = readActionSpecCatalogFamilies();
  const facts = readFamilyIds(families);
  return renderModule(families, facts.families, undefined, facts.placements);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = renderActionSpecFamilies();
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT_PATH, 'utf8');
    if (current !== next) {
      console.error('actionSpecFamilies.generated.ts is stale: run node packages/protocol/scripts/generateActionSpecFamilies.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT_PATH, next);
  }
}
