import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

describe('libsodium web shim package exports', () => {
  it('loads via the package root (no deep dist path imports)', async () => {
    const source = ts.createSourceFile('libsodium.lib.web.ts', readFileSync(join(__dirname, 'libsodium.lib.web.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const requires: string[] = [];
    const valueImports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) requires.push(node.arguments[0].text);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        if (!clause || (!clause.isTypeOnly && (clause.name || !bindings || !ts.isNamedImports(bindings)
          || bindings.elements.length === 0 || bindings.elements.some(binding => !binding.isTypeOnly)))) valueImports.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(requires.filter(module => module.startsWith('libsodium-wrappers'))).toEqual(['libsodium-wrappers']);
    expect(valueImports.filter(module => module.startsWith('libsodium-wrappers'))).toEqual([]);
    const mod = await import('./libsodium.lib.web');
    expect(mod.default).toBeDefined();
    const sodium = mod.default;
    await sodium.ready;
    const message = new TextEncoder().encode('web package-root crypto');
    const secret = new Uint8Array(sodium.crypto_secretbox_KEYBYTES).fill(3);
    const nonce = new Uint8Array(sodium.crypto_secretbox_NONCEBYTES).fill(4);
    const boxed = sodium.crypto_secretbox_easy(message, nonce, secret);
    expect(boxed).toHaveLength(message.length + sodium.crypto_secretbox_MACBYTES);
    expect(sodium.crypto_secretbox_open_easy(boxed, nonce, secret)).toEqual(message);
    expect(() => sodium.crypto_secretbox_open_easy(boxed, nonce, new Uint8Array(secret.length).fill(5))).toThrow();
  });
});
