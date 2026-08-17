import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type {
    PluginSettingDescriptor,
    PluginSettingsChange,
    PluginSettingsMutationResult,
    PluginSettingsSnapshot,
} from './index.js';
import type {
    PluginSettingDescriptor as SourcePluginSettingDescriptor,
    PluginSettingsChange as SourcePluginSettingsChange,
    PluginSettingsMutationResult as SourcePluginSettingsMutationResult,
    PluginSettingsSnapshot as SourcePluginSettingsSnapshot,
    ScopedSettingsService as SourceScopedSettingsService,
    SettingsScopeRef as SourceSettingsScopeRef,
    SettingsService as SourceSettingsService,
} from './services/core.js';
import type {
    ScopedSettingsService,
    SettingsScopeRef,
    SettingsService,
} from './settings/index.js';

const ROOT_DUPLICATE_SETTINGS_EXPORTS = [
    'ScopedSettingsService',
    'SettingsScopeRef',
    'SettingsService',
] as const;

function createSdkProgram(): ts.Program {
    const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
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

function moduleExportNames(program: ts.Program, relativePath: string): readonly string[] {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!sourceFile) throw new Error(`Missing source module: ${relativePath}`);
    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
    return program.getTypeChecker().getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.name)
        .sort();
}

describe('plugin SDK root Settings exports', () => {
    it('keeps unprefixed scoped Settings types exclusively on /settings', () => {
        const program = createSdkProgram();
        const rootExports = moduleExportNames(program, 'src/index.ts');
        const settingsExports = moduleExportNames(program, 'src/settings/index.ts');

        expect(rootExports.filter((name) => ROOT_DUPLICATE_SETTINGS_EXPORTS.includes(
            name as (typeof ROOT_DUPLICATE_SETTINGS_EXPORTS)[number],
        ))).toEqual([]);
        expect(settingsExports).toEqual(expect.arrayContaining([...ROOT_DUPLICATE_SETTINGS_EXPORTS]));

        expectTypeOf<PluginSettingDescriptor>().toEqualTypeOf<SourcePluginSettingDescriptor>();
        expectTypeOf<PluginSettingsChange>().toEqualTypeOf<SourcePluginSettingsChange>();
        expectTypeOf<PluginSettingsMutationResult>().toEqualTypeOf<SourcePluginSettingsMutationResult>();
        expectTypeOf<PluginSettingsSnapshot>().toEqualTypeOf<SourcePluginSettingsSnapshot>();
        expectTypeOf<ScopedSettingsService>().toEqualTypeOf<SourceScopedSettingsService>();
        expectTypeOf<SettingsScopeRef>().toEqualTypeOf<SourceSettingsScopeRef>();
        expectTypeOf<SettingsService>().toEqualTypeOf<SourceSettingsService>();
    }, 120_000);
});
