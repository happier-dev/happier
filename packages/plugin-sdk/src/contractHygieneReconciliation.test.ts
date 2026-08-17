import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type ContractDeclaration = Readonly<{
    source: string;
    names: readonly string[];
}>;

const CONTRACT_DECLARATIONS: readonly ContractDeclaration[] = [
    { source: './actions/service.ts', names: ['getActionSpec'] },
    {
        source: './providers/projections.ts',
        names: [
            'ProviderBindingCompatibilityResolutionInput',
            'resolveProviderBindingCompatibilityWithFingerprintV1',
            'SessionModelSelectionIntentResolutionInput',
            'resolveSessionModelSelectionIntentV1',
        ],
    },
    {
        source: './services/connectedAccounts.ts',
        names: [
            'PluginConnectedAccountReadContext',
            'PluginConnectedAccountMutationContext',
        ],
    },
    {
        source: './ui/reactNativeWebBuild.ts',
        names: [
            'defineReactNativeWebViteBuildPreset',
            'ReactNativeWebViteBuildPresetInput',
        ],
    },
    {
        source: './voice/client.ts',
        names: [
            'VoiceConnectionMediaHost',
            'RealtimeVoiceProviderProtocol',
        ],
    },
];

function readDeclaration(source: string, name: string): string {
    const path = fileURLToPath(new URL(source, import.meta.url));
    const sourceFile = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    let match: ts.Node | undefined;

    const visit = (node: ts.Node): void => {
        if (
            (ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node))
            && node.name?.text === name
        ) {
            match = node;
            return;
        }
        if (
            ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name)
            && node.name.text === name
        ) {
            match = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (!match) throw new Error(`Missing ${name} in ${source}`);
    return match.getText(sourceFile);
}

describe('Plugin SDK production contract hygiene', () => {
    it.each(CONTRACT_DECLARATIONS)(
        'uses nameable SDK-owned parameter types in $source',
        ({ source, names }) => {
            for (const name of names) {
                expect(readDeclaration(source, name), name).not.toMatch(/\bParameters\s*</u);
            }
        },
    );

    it.each(CONTRACT_DECLARATIONS)(
        'exports every named SDK-owned signature type in $source',
        ({ source, names }) => {
            for (const name of names) {
                const declaration = readDeclaration(source, name);
                if (!/^(?:export\s+)?type\b/u.test(declaration)) continue;
                expect(declaration, name).toMatch(/^export\s+type\b/u);
            }
        },
    );
});
