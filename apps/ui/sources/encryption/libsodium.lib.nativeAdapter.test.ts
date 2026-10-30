import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    deriveBoxPublicKeyFromSeed,
    deriveBoxSecretKeyFromSeed,
} from '@happier-dev/protocol';

describe('native libsodium compatibility adapter', () => {
    it('does not import the JSI installer package at module evaluation time', () => {
        const valueEdges = (text: string) => {
            const source = ts.createSourceFile('adapter.ts', text, ts.ScriptTarget.Latest, true);
            const edges: string[] = [];
            const visit = (node: ts.Node): void => {
                if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                    const clause = node.importClause;
                    const bindings = clause?.namedBindings;
                    const hasValue = !clause || (!clause.isTypeOnly && (clause.name || !bindings || !ts.isNamedImports(bindings)
                        || bindings.elements.length === 0 || bindings.elements.some(binding => !binding.isTypeOnly)));
                    if (hasValue) edges.push(node.moduleSpecifier.text);
                } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
                    && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
                    edges.push(node.moduleReference.expression.text);
                } else if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === 'require')
                    || node.expression.kind === ts.SyntaxKind.ImportKeyword) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
                    edges.push(node.arguments[0].text);
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
            return edges;
        };
        expect(valueEdges(`// import 'comment';\nconst note = "require('string')";\nimport type T from 'type';\nimport { type T } from 'erased';\nimport {\n type T, value\n} from 'mixed';\nimport 'side-effect';\nconst sdk = require('root');\nvoid import('dynamic');`))
            .toEqual(['mixed', 'side-effect', 'root', 'dynamic']);
        const imports = valueEdges(readFileSync(join(__dirname, 'libsodium.lib.ts'), 'utf8'));
        expect(imports).toContain('tweetnacl');
        expect(imports.some(module => module === '@more-tech/react-native-libsodium'
            || module.startsWith('@more-tech/react-native-libsodium/'))).toBe(false);
    });

    it('exposes the crypto primitives used by app startup without native JSI install side effects', async () => {
        const sodium = (await import('./libsodium.lib')).default;
        await sodium.ready;

        const seed = new Uint8Array(32).fill(7);
        const boxKeyPair = sodium.crypto_box_seed_keypair(seed);
        expect(boxKeyPair.privateKey).toEqual(deriveBoxSecretKeyFromSeed(seed));
        expect(boxKeyPair.publicKey).toEqual(deriveBoxPublicKeyFromSeed(seed));

        const message = new TextEncoder().encode('signed payload');
        const signingKeyPair = sodium.crypto_sign_seed_keypair(seed);
        const signature = sodium.crypto_sign_detached(message, signingKeyPair.privateKey);
        expect(signature).toHaveLength(tweetnacl.sign.signatureLength);
        expect(sodium.crypto_sign_verify_detached(signature, message, signingKeyPair.publicKey)).toBe(true);
        expect(sodium.crypto_sign_verify_detached(signature, new TextEncoder().encode('tampered'), signingKeyPair.publicKey)).toBe(false);

        const secret = new Uint8Array(sodium.crypto_secretbox_KEYBYTES).fill(3);
        const nonce = new Uint8Array(sodium.crypto_secretbox_NONCEBYTES).fill(4);
        const boxed = sodium.crypto_secretbox_easy(message, nonce, secret);
        expect(boxed).toHaveLength(message.length + tweetnacl.secretbox.overheadLength);
        expect(sodium.crypto_secretbox_open_easy(boxed, nonce, secret)).toEqual(message);
        expect(sodium.crypto_secretbox_open_easy(boxed, nonce, new Uint8Array(secret.length).fill(5))).toBeNull();
    });
});
