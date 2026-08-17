import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type {
    ConnectedAccountBindingEvent,
    ConnectedAccountBindingSummary,
    ConnectedAccountListedState,
    ConnectedAccountMaterialization,
    ConnectedAccountRuntime,
    ConnectedAccountsService,
} from '../connectedAccounts.js';
import type {
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountMaterialization,
    PluginConnectedAccountCommonRuntime,
    PluginConnectedAccountRuntime,
    PluginConnectedAccountState,
    PluginConnectedAccountsService,
} from './connectedAccounts.js';

function parseSource(fileName: string, sourceText: string): ts.SourceFile {
    return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importedName(
    sourceFile: ts.SourceFile,
    moduleSpecifier: string,
    localName: string,
): string | undefined {
    for (const statement of sourceFile.statements) {
        if (
            !ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
        ) {
            continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        const binding = bindings.elements.find((element) => element.name.text === localName);
        if (binding) return (binding.propertyName ?? binding.name).text;
    }
    return undefined;
}

function reexportedName(
    sourceFile: ts.SourceFile,
    moduleSpecifier: string,
    localName: string,
): string | undefined {
    for (const statement of sourceFile.statements) {
        if (
            !ts.isExportDeclaration(statement)
            || !statement.moduleSpecifier
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)
        ) {
            continue;
        }
        const binding = statement.exportClause.elements.find((element) => element.name.text === localName);
        if (binding) return (binding.propertyName ?? binding.name).text;
    }
    return undefined;
}

function exportedTypeText(sourceFile: ts.SourceFile, name: string): string | undefined {
    const declaration = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => (
        ts.isTypeAliasDeclaration(statement)
        && statement.name.text === name
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ));
    return declaration?.type.getText(sourceFile);
}

function exportedInterfaceText(sourceFile: ts.SourceFile, name: string): string | undefined {
    const declaration = sourceFile.statements.find((statement): statement is ts.InterfaceDeclaration => (
        ts.isInterfaceDeclaration(statement)
        && statement.name.text === name
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ));
    return declaration?.getText(sourceFile);
}

describe('Connected Account runtime declaration ownership', () => {
    it('aliases public binding, materialization, and runtime declarations to the canonical owner', async () => {
        const sourceText = await readFile(
            new URL('./connectedAccounts.ts', import.meta.url),
            'utf8',
        );
        const sourceFile = ts.createSourceFile(
            'connectedAccounts.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        for (const [pluginName, canonicalName] of [
            ['PluginConnectedAccountBindingSummary', 'ConnectedAccountBindingSummary'],
            ['PluginConnectedAccountMaterialization', 'ConnectedAccountMaterialization'],
            ['PluginConnectedAccountBindingEvent', 'ConnectedAccountBindingEvent'],
            ['PluginConnectedAccountState', 'ConnectedAccountListedState'],
            ['PluginConnectedAccountRuntime', 'ConnectedAccountRuntime'],
            ['PluginConnectedAccountsService', 'ConnectedAccountsService'],
        ] as const) {
            expect(exportedTypeText(sourceFile, pluginName)).toBeUndefined();
            expect(exportedInterfaceText(sourceFile, pluginName)).toBeUndefined();
            expect(reexportedName(
                sourceFile,
                '../connectedAccounts.js',
                pluginName,
            )).toBe(canonicalName);
        }

        expectTypeOf<PluginConnectedAccountBindingSummary>()
            .toEqualTypeOf<ConnectedAccountBindingSummary>();
        expectTypeOf<PluginConnectedAccountMaterialization>()
            .toEqualTypeOf<ConnectedAccountMaterialization>();
        expectTypeOf<PluginConnectedAccountBindingEvent>()
            .toEqualTypeOf<ConnectedAccountBindingEvent>();
        expectTypeOf<PluginConnectedAccountState>()
            .toEqualTypeOf<ConnectedAccountListedState>();
        expectTypeOf<PluginConnectedAccountRuntime>()
            .toEqualTypeOf<ConnectedAccountRuntime>();
        expectTypeOf<PluginConnectedAccountsService>()
            .toEqualTypeOf<ConnectedAccountsService>();
        expectTypeOf<PluginConnectedAccountCommonRuntime>().toEqualTypeOf<Pick<
            PluginConnectedAccountRuntime,
            'refresh' | 'revoke' | 'status' | 'quota' | 'materialize'
        >>();
    });

    it('routes author-facing Connected Account signatures through the public SDK facades', async () => {
        const [runtimeSourceText, servicesSourceText, managedServicesSourceText, runtimeIndexSourceText] = await Promise.all([
            readFile(new URL('./connectedAccounts.ts', import.meta.url), 'utf8'),
            readFile(new URL('./index.ts', import.meta.url), 'utf8'),
            readFile(new URL('../managed-services/contract.ts', import.meta.url), 'utf8'),
            readFile(new URL('../runtime/index.ts', import.meta.url), 'utf8'),
        ]);
        const runtimeSource = parseSource('services/connectedAccounts.ts', runtimeSourceText);
        const servicesSource = parseSource('services/index.ts', servicesSourceText);
        const managedServicesSource = parseSource(
            'managed-services/contract.ts',
            managedServicesSourceText,
        );
        const runtimeIndexSource = parseSource('runtime/index.ts', runtimeIndexSourceText);

        expect(importedName(
            runtimeSource,
            '../connectedAccounts.js',
            'ConnectedAccountRef',
        )).toBe('ConnectedAccountRef');
        expect(importedName(
            runtimeSource,
            '../connectedAccounts.js',
            'ConnectedAccountRuntime',
        )).toBe('ConnectedAccountRuntime');
        expect(importedName(
            runtimeSource,
            '@happier-dev/protocol',
            'PluginConnectedAccountMaterializationRequest',
        )).toBeUndefined();
        expect(reexportedName(
            runtimeSource,
            '../connectedAccounts.js',
            'PluginConnectedAccountMaterializationRequest',
        )).toBe('ConnectedAccountMaterializationRequest');
        expect(reexportedName(
            runtimeSource,
            '../connectedAccounts.js',
            'PluginConnectedAccountRef',
        )).toBe('ConnectedAccountRef');
        expect(reexportedName(
            runtimeSource,
            '../connectedAccounts.js',
            'PluginConnectedAccountMaterializationKind',
        )).toBe('PluginConnectedAccountMaterializationKind');
        expect(reexportedName(
            runtimeSource,
            '../connectedAccounts.js',
            'ConnectedAccountsService',
        )).toBe('ConnectedAccountsService');
        expect(reexportedName(
            runtimeSource,
            '../connectedAccounts.js',
            'PluginConnectedAccountsService',
        )).toBe('ConnectedAccountsService');
        expect(exportedTypeText(runtimeSource, 'PluginConnectedAccountRef')).toBeUndefined();
        expect(exportedInterfaceText(runtimeSource, 'ConnectedAccountsService')).toBeUndefined();
        expect(exportedTypeText(runtimeSource, 'PluginConnectedAccountMaterializationOptions'))
            .toBeUndefined();
        expect(reexportedName(
            runtimeSource,
            '../connectedAccounts.js',
            'PluginConnectedAccountMaterializationOptions',
        )).toBe('ConnectedAccountMaterializationOptions');
        expect(reexportedName(
            runtimeSource,
            '@happier-dev/protocol',
            'PluginConnectedAccountMaterializationRequest',
        )).toBeUndefined();
        for (const name of [
            'PluginConnectedAccountAuthenticationAttempt',
            'PluginConnectedAccountReadContext',
            'PluginConnectedAccountRuntimeConfigurationTarget',
        ]) {
            const typeText = exportedTypeText(runtimeSource, name);
            expect(typeText, name).toContain('ConnectedAccountRef');
            expect(typeText, name).not.toContain('PluginConnectedAccountRef');
        }
        expect(exportedInterfaceText(
            runtimeSource,
            'PluginConnectedAccountRegistrationApi',
        )).toContain('runtime: ConnectedAccountRuntime');

        expect(importedName(
            servicesSource,
            '../connectedAccounts.js',
            'ConnectedAccountsService',
        )).toBe('ConnectedAccountsService');
        expect(exportedInterfaceText(servicesSource, 'PluginServices'))
            .toContain('connectedAccounts: ConnectedAccountsService');
        expect(reexportedName(
            servicesSource,
            '../connectedAccounts.js',
            'PluginConnectedAccountMaterializationKind',
        )).toBe('PluginConnectedAccountMaterializationKind');
        expect(reexportedName(
            servicesSource,
            '@happier-dev/protocol',
            'PluginConnectedAccountMaterializationKind',
        )).toBeUndefined();
        expect(reexportedName(
            servicesSource,
            './connectedAccounts.js',
            'PluginConnectedAccountsService',
        )).toBe('PluginConnectedAccountsService');
        expect(reexportedName(
            runtimeIndexSource,
            '../services/index.js',
            'PluginConnectedAccountsService',
        )).toBe('PluginConnectedAccountsService');

        expect(importedName(
            managedServicesSource,
            '../connectedAccounts.js',
            'ConnectedAccountsService',
        )).toBe('ConnectedAccountsService');
        expect(exportedTypeText(managedServicesSource, 'ManagedProviderRuntimeContext'))
            .toContain('connectedAccounts: ConnectedAccountsService');
    });
});
