import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type MoveEntry = { from: string; to: string };
type MoveMap = { moves: MoveEntry[] };

type Mapping = { oldAbs: string; newAbs: string; exactOnly?: boolean };

const repoRoot = path.resolve(__dirname, '../../../..');
const sourcesRoot = path.join(repoRoot, 'apps/ui/sources');

function parseMapPath(): string {
  const args = process.argv.slice(2);
  const mapIndex = args.findIndex((arg) => arg === '--map');
  if (mapIndex === -1 || !args[mapIndex + 1]) {
    throw new Error('Missing required --map <path> argument.');
  }
  const candidate = args[mapIndex + 1];
  return path.isAbsolute(candidate) ? candidate : path.resolve(repoRoot, candidate);
}

const mapPath = parseMapPath();
const moveMap = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as MoveMap;

const mappings: Mapping[] = [];

function isTsLike(filePath: string): boolean {
  return /\.(ts|tsx|mts|cts|js|jsx)$/.test(filePath);
}

function stripExt(filePath: string): string {
  return filePath.replace(/\.[^.\/]+$/, '');
}

for (const entry of moveMap.moves) {
  const oldAbs = path.join(repoRoot, entry.from);
  const newAbs = path.join(repoRoot, entry.to);

  mappings.push({ oldAbs, newAbs, exactOnly: false });

  if (isTsLike(oldAbs) && isTsLike(newAbs)) {
    // Extensionless mappings are for exact file imports only; do not treat as path prefixes.
    mappings.push({ oldAbs: stripExt(oldAbs), newAbs: stripExt(newAbs), exactOnly: true });
  }
}

mappings.sort((a, b) => b.oldAbs.length - a.oldAbs.length);

function remapAbs(absPath: string): string {
  for (const m of mappings) {
    if (absPath === m.oldAbs) return m.newAbs;
    if (m.exactOnly) continue;
    if (absPath.startsWith(`${m.oldAbs}${path.sep}`)) {
      return `${m.newAbs}${absPath.slice(m.oldAbs.length)}`;
    }
  }
  return absPath;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function asRelative(fromFile: string, target: string): string {
  let rel = path.relative(path.dirname(fromFile), target);
  rel = toPosix(rel);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function remapSpecifier(filePath: string, spec: string): string {
  if (!spec) return spec;

  if (spec.startsWith('@/')) {
    const abs = path.join(sourcesRoot, spec.slice(2));
    const mapped = remapAbs(abs);
    if (mapped === abs) return spec;
    const relToSources = toPosix(path.relative(sourcesRoot, mapped));
    return `@/${relToSources}`;
  }

  if (spec.startsWith('./') || spec.startsWith('../')) {
    const abs = path.resolve(path.dirname(filePath), spec);
    const mapped = remapAbs(abs);
    if (mapped === abs) return spec;
    return asRelative(filePath, mapped);
  }

  return spec;
}

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    if (ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (isTsLike(full)) out.push(full);
  }
}

function replaceWithRanges(text: string, ranges: Array<{ start: number; end: number; value: string }>): string {
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => b.start - a.start);
  let next = text;
  for (const r of ranges) {
    next = `${next.slice(0, r.start)}${r.value}${next.slice(r.end)}`;
  }
  return next;
}

function collectReplacements(filePath: string, text: string): Array<{ start: number; end: number; value: string }> {
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  const pushStringReplacement = (literal: ts.StringLiteralLike): void => {
    const raw = literal.text;
    const mapped = remapSpecifier(filePath, raw);
    if (mapped === raw) return;
    replacements.push({
      start: literal.getStart(sf) + 1,
      end: literal.getEnd() - 1,
      value: mapped,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      pushStringReplacement(node.moduleSpecifier);
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      pushStringReplacement(node.moduleSpecifier);
    }

    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      pushStringReplacement(node.argument.literal);
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const first = node.arguments[0];
      if (!first || !ts.isStringLiteralLike(first)) {
        ts.forEachChild(node, visit);
        return;
      }

      const isRequire = ts.isIdentifier(expr) && expr.text === 'require';
      const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword;
      const isMock =
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        (expr.expression.text === 'vi' || expr.expression.text === 'jest') &&
        (expr.name.text === 'mock' || expr.name.text === 'doMock');

      if (isRequire || isDynamicImport || isMock) {
        pushStringReplacement(first);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return replacements;
}

const files: string[] = [];
walk(path.join(repoRoot, 'apps/ui/sources'), files);
walk(path.join(repoRoot, 'apps/ui/tools/migrations'), files);

let changed = 0;
for (const filePath of files) {
  const text = fs.readFileSync(filePath, 'utf8');
  const replacements = collectReplacements(filePath, text);
  if (replacements.length === 0) continue;
  const next = replaceWithRanges(text, replacements);
  if (next !== text) {
    fs.writeFileSync(filePath, next, 'utf8');
    changed += 1;
    console.log(`REWROTE: ${toPosix(path.relative(repoRoot, filePath))}`);
  }
}

console.log(`Rewrote imports in ${changed} files.`);
