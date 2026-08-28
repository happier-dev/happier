import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type {
    PluginSettingFieldV2 as ProtocolSettingField,
    PluginSettingFieldIdV2 as ProtocolSettingFieldId,
    PluginSettingFieldSchemaV2 as ProtocolSettingFieldSchema,
    PluginSettingsContribution as ProtocolSettingsContribution,
} from '@happier-dev/protocol';
import { PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 as canonicalPluginAccountSettingsLimitsV1 } from '@happier-dev/protocol/plugins/settings/accountSettingsLimits';

import type {
    PluginSettingsActionDeclaration as SourceSettingsActionDeclaration,
    PluginSettingsActionInput as SourceSettingsActionInput,
    PluginSettingsActionResult as SourceSettingsActionResult,
    PluginSettingsActionRuntime as SourceSettingsActionRuntime,
} from '../settingsActions.js';
import type {
    PluginSettingDescriptor as SourceSettingDescriptor,
    PluginSettingsChange as SourceSettingsChange,
    PluginSettingsMutationResult as SourceSettingsMutationResult,
    PluginSettingsSnapshot as SourceSettingsSnapshot,
    ScopedSettingsService as SourceScopedSettingsService,
    SettingsScopeRef as SourceSettingsScopeRef,
    SettingsService as SourceSettingsService,
} from '../services/core.js';
import type {
    PluginSettingsActionDeclaration,
    PluginSettingsActionInput,
    PluginSettingsActionResult,
    PluginSettingsActionRuntime,
    PluginSettingFieldIdV2,
    PluginSettingFieldSchemaV2,
    PluginSettingsContribution,
    SettingDescriptor,
    SettingField,
    ScopedSettingsService,
    SettingsChange,
    SettingsMutationResult,
    SettingsScopeRef,
    SettingsSnapshot,
    SettingsService,
} from './projections.js';
import { PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 } from './projections.js';

const SETTINGS_EXPORTS = [
    'PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1',
    'PluginSettingFieldIdV2',
    'PluginSettingFieldSchemaV2',
    'PluginSettingsActionDeclaration',
    'PluginSettingsActionInput',
    'PluginSettingsActionResult',
    'PluginSettingsActionRuntime',
    'PluginSettingsContribution',
    'SettingDescriptor',
    'SettingField',
    'ScopedSettingsService',
    'SettingsChange',
    'SettingsMutationResult',
    'SettingsScopeRef',
    'SettingsSnapshot',
    'SettingsService',
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

function moduleExportNames(program: ts.Program, relativePath: string): readonly string[] {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!sourceFile) throw new Error(`Missing source module: ${relativePath}`);
    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
    return program.getTypeChecker().getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.name)
        .sort();
}

describe('Settings package-local projection', () => {
    it('contains exactly the approved type-only surface with canonical identities', () => {
        const program = createSdkProgram();
        expect(moduleExportNames(program, 'src/settings/projections.ts'))
            .toEqual([...SETTINGS_EXPORTS].sort());

        expectTypeOf<PluginSettingsActionDeclaration>()
            .toEqualTypeOf<SourceSettingsActionDeclaration>();
        expectTypeOf<PluginSettingsActionInput>().toEqualTypeOf<SourceSettingsActionInput>();
        expectTypeOf<PluginSettingsActionResult>().toEqualTypeOf<SourceSettingsActionResult>();
        expectTypeOf<PluginSettingsActionRuntime<unknown>>()
            .toEqualTypeOf<SourceSettingsActionRuntime<unknown>>();
        expectTypeOf<PluginSettingFieldIdV2>().toEqualTypeOf<ProtocolSettingFieldId>();
        expectTypeOf<PluginSettingFieldSchemaV2>()
            .toEqualTypeOf<ProtocolSettingFieldSchema>();
        expectTypeOf<PluginSettingsContribution>()
            .toEqualTypeOf<ProtocolSettingsContribution>();
        expectTypeOf<SettingDescriptor>().toEqualTypeOf<SourceSettingDescriptor>();
        expectTypeOf<SettingField>().toEqualTypeOf<ProtocolSettingField>();
        expectTypeOf<ScopedSettingsService>().toEqualTypeOf<SourceScopedSettingsService>();
        expectTypeOf<SettingsChange>().toEqualTypeOf<SourceSettingsChange>();
        expectTypeOf<SettingsMutationResult>().toEqualTypeOf<SourceSettingsMutationResult>();
        expectTypeOf<SettingsScopeRef>().toEqualTypeOf<SourceSettingsScopeRef>();
        expectTypeOf<SettingsSnapshot>().toEqualTypeOf<SourceSettingsSnapshot>();
        expectTypeOf<SettingsService>().toEqualTypeOf<SourceSettingsService>();
        expect(PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1)
            .toBe(canonicalPluginAccountSettingsLimitsV1);
    }, 120_000);

    it('keeps Protocol-only setting field schemas out of the public author export inventory', () => {
        const program = createSdkProgram();
        const publicExports = moduleExportNames(program, 'src/settings/index.public.ts');

        expect(publicExports).not.toContain('PluginSettingFieldSchemaV2');
        expect(publicExports).toContain('PluginSettingsContribution');
        expect(publicExports).toContain('SettingField');
    }, 120_000);
});
