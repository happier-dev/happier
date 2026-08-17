import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const CONNECTED_ACCOUNTS_EXPORTS = [
    'ConnectedAccountPurposeDeclarations',
] as const;

function createSdkProgram(): ts.Program {
    const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
    });
    if (!parsed) throw new Error(`Unable to parse ${configPath}`);
    return ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
    });
}

let sdkProgram: ts.Program | undefined;

function readSdkProgram(): ts.Program {
    sdkProgram ??= createSdkProgram();
    return sdkProgram;
}

function sourceFile(program: ts.Program, relativePath: string): ts.SourceFile {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const source = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!source) throw new Error(`Missing source module: ${relativePath}`);
    return source;
}

function moduleExports(program: ts.Program, relativePath: string): readonly ts.Symbol[] {
    const source = sourceFile(program, relativePath);
    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
    return program.getTypeChecker().getExportsOfModule(moduleSymbol);
}

function canonicalSymbol(program: ts.Program, symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias
        ? program.getTypeChecker().getAliasedSymbol(symbol)
        : symbol;
}

function exportedSymbol(
    program: ts.Program,
    relativePath: string,
    exportName: string,
): ts.Symbol {
    const symbol = moduleExports(program, relativePath)
        .find((candidate) => candidate.name === exportName);
    if (!symbol) throw new Error(`Missing ${exportName} from ${relativePath}`);
    return canonicalSymbol(program, symbol);
}

function ownerSymbol(program: ts.Program, exportName: string): ts.Symbol {
    const containingFile = sourceFile(
        program,
        'src/connected-accounts/projections.ts',
    ).fileName;
    const resolved = ts.resolveModuleName(
        '@happier-dev/protocol/connect/connected-account-purposes',
        containingFile,
        program.getCompilerOptions(),
        ts.sys,
    ).resolvedModule;
    if (!resolved) {
        throw new Error('Unable to resolve the Connected Accounts purpose Protocol owner');
    }
    const ownerSource = program.getSourceFile(resolved.resolvedFileName);
    if (!ownerSource) throw new Error('Missing resolved Protocol source');
    const ownerModule = program.getTypeChecker().getSymbolAtLocation(ownerSource);
    if (!ownerModule) throw new Error('Missing Protocol module symbol');
    const symbol = program.getTypeChecker().getExportsOfModule(ownerModule)
        .find((candidate) => candidate.name === exportName);
        if (!symbol) throw new Error(`Missing ${exportName} from the Connected Accounts purpose Protocol owner`);
    return canonicalSymbol(program, symbol);
}

describe('Connected Accounts package-local Provider facet projection', () => {
    it('contains exactly the approved unsuffixed purpose-declarations alias', () => {
        const program = readSdkProgram();
        expect(moduleExports(program, 'src/connected-accounts/projections.ts')
            .map((symbol) => symbol.name)
            .sort()).toEqual(CONNECTED_ACCOUNTS_EXPORTS);
    }, 120_000);

    it('directly aliases the canonical Protocol V1 declaration identity', async () => {
        const program = readSdkProgram();
        const source = await readFile(new URL('./projections.ts', import.meta.url), 'utf8');
        const parsed = ts.createSourceFile(
            'projections.ts',
            source,
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.TS,
        );

        expect(parsed.statements).toHaveLength(1);
        const [statement] = parsed.statements;
        expect(statement && ts.isExportDeclaration(statement)).toBe(true);
        if (!statement || !ts.isExportDeclaration(statement)) return;
        expect(statement.isTypeOnly).toBe(true);
        expect(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : null).toBe('@happier-dev/protocol/connect/connected-account-purposes');
        expect(statement.exportClause && ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements.map((element) => ({
                name: element.name.text,
                ownerName: element.propertyName?.text ?? element.name.text,
            }))
            : null).toEqual([{
            name: 'ConnectedAccountPurposeDeclarations',
            ownerName: 'ConnectedAccountPurposeDeclarationsV1',
        }]);
        expect(exportedSymbol(
            program,
            'src/connected-accounts/projections.ts',
            'ConnectedAccountPurposeDeclarations',
        )).toBe(ownerSymbol(program, 'ConnectedAccountPurposeDeclarationsV1'));
    }, 120_000);

    it('does not duplicate the schema or place the Connected Accounts alias on Providers', () => {
        const program = readSdkProgram();
        const connectedAccountNames = new Set(
            moduleExports(program, 'src/connected-accounts/projections.ts')
                .map((symbol) => symbol.name),
        );
        const providerNames = new Set(
            moduleExports(program, 'src/providers/projections.ts')
                .map((symbol) => symbol.name),
        );

        expect(connectedAccountNames.has('ConnectedAccountPurposeDeclarationsV1Schema')).toBe(false);
        expect(providerNames.has('ConnectedAccountPurposeDeclarations')).toBe(false);
        expect(providerNames.has('ConnectedAccountPurposeDeclarationsV1')).toBe(false);
        expect(providerNames.has('ConnectedAccountPurposeDeclarationsV1Schema')).toBe(false);
    }, 120_000);
});
