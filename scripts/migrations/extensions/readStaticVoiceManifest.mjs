import { readFileSync, statSync } from 'node:fs';
import ts from 'typescript';

const MAX_MANIFEST_BYTES = 64 * 1024;

function fail(manifestPath, detail) {
  throw new Error(`Invalid PLUGIN_MANIFEST in ${manifestPath}: ${detail}`);
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function readPropertyName(name, manifestPath) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  fail(manifestPath, 'first-party voice manifest property names must be static');
}

function readJson(expression, manifestPath) {
  const current = unwrap(expression);
  if (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (
      current.arguments.length === 1
      && ts.isPropertyAccessExpression(callee)
      && ts.isIdentifier(callee.expression)
      && callee.expression.text === 'Object'
      && callee.name.text === 'freeze'
    ) {
      return readJson(current.arguments[0], manifestPath);
    }
    fail(manifestPath, 'first-party voice manifest values must be static data');
  }
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
  if (ts.isNumericLiteral(current)) {
    const value = Number(current.text);
    if (!Number.isFinite(value)) fail(manifestPath, 'first-party voice manifest numbers must be finite');
    return value;
  }
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (current.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(current)
    && current.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(current.operand)
  ) {
    const value = -Number(current.operand.text);
    if (!Number.isFinite(value)) fail(manifestPath, 'first-party voice manifest numbers must be finite');
    return value;
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.map((element) => {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        fail(manifestPath, 'first-party voice manifest arrays must be static data');
      }
      return readJson(element, manifestPath);
    });
  }
  if (ts.isObjectLiteralExpression(current)) {
    const out = Object.create(null);
    for (const property of current.properties) {
      if (!ts.isPropertyAssignment(property)) {
        fail(manifestPath, 'first-party voice manifest objects must use static property assignments');
      }
      const name = readPropertyName(property.name, manifestPath);
      if (Object.prototype.hasOwnProperty.call(out, name)) {
        fail(manifestPath, `duplicate static property '${name}'`);
      }
      out[name] = readJson(property.initializer, manifestPath);
    }
    return out;
  }
  fail(manifestPath, 'first-party voice manifest values must be static data');
}

function parseStaticVoiceManifest(manifestPath) {
  const size = statSync(manifestPath).size;
  if (size > MAX_MANIFEST_BYTES) {
    fail(manifestPath, `first-party voice manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  const sourceFile = ts.createSourceFile(
    manifestPath,
    readFileSync(manifestPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0 || sourceFile.statements.length !== 1) {
    fail(manifestPath, 'first-party voice manifest must contain only the static PLUGIN_MANIFEST export');
  }
  const statement = sourceFile.statements[0];
  const isExported = ts.isVariableStatement(statement)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  const declaration = ts.isVariableStatement(statement)
    && statement.declarationList.declarations.length === 1
    ? statement.declarationList.declarations[0]
    : null;
  if (
    !isExported
    || !declaration
    || !ts.isIdentifier(declaration.name)
    || declaration.name.text !== 'PLUGIN_MANIFEST'
    || !declaration.initializer
    || (statement.declarationList.flags & ts.NodeFlags.Const) === 0
  ) {
    fail(manifestPath, 'first-party voice manifest must contain only the static PLUGIN_MANIFEST export');
  }
  return readJson(declaration.initializer, manifestPath);
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('Missing voice manifest path');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(parseStaticVoiceManifest(manifestPath))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
