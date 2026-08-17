import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const MCP_DTO_EXPORTS = [
    'McpAnnotations',
    'McpBlobResourceContents',
    'McpDiscoveredEndpoint',
    'McpGetPromptResult',
    'McpIcon',
    'McpPrompt',
    'McpPromptArgument',
    'McpPromptContent',
    'McpPromptMessage',
    'McpPromptPage',
    'McpReadResourceResult',
    'McpResource',
    'McpResourceContents',
    'McpResourcePage',
    'McpResourceTemplate',
    'McpResourceTemplatePage',
    'McpResourceUpdatedEvent',
    'McpTextResourceContents',
    'McpToolPageOptions',
] as const;

const RESOURCE_PROMPT_EXPORTS = [
    'PromptAssetAdapter',
    'PromptAssetBundleRecord',
    'PromptAssetCapabilities',
    'PromptAssetContribution',
    'PromptAssetDefaultRoot',
    'PromptAssetDeleteRequest',
    'PromptAssetDiscoverRequest',
    'PromptAssetDiscoverResult',
    'PromptAssetDiscoveryItem',
    'PromptAssetDocRecord',
    'PromptAssetExternalRef',
    'PromptAssetInstallMode',
    'PromptAssetLibraryKind',
    'PromptAssetListTypesResult',
    'PromptAssetMutationErrorCode',
    'PromptAssetMutationPreview',
    'PromptAssetMutationResult',
    'PromptAssetReadRequest',
    'PromptAssetReadResult',
    'PromptAssetScope',
    'PromptAssetSupportsScope',
    'PromptAssetTypeDescriptor',
    'PromptAssetWriteBundleRequest',
    'PromptAssetWriteDocRequest',
    'PromptAssetWriteRequest',
    'PromptRegistryAdapterDescriptor',
    'PromptRegistryConfiguredSource',
    'PromptRegistryErrorCode',
    'PromptRegistryErrorResult',
    'PromptRegistryFetchItemRequest',
    'PromptRegistryFetchItemResult',
    'PromptRegistryFetchedItem',
    'PromptRegistryInstallRequest',
    'PromptRegistryInstallResult',
    'PromptRegistryInstallTarget',
    'PromptRegistryItemSummary',
    'PromptRegistryListAdaptersResult',
    'PromptRegistryListSourcesRequest',
    'PromptRegistryListSourcesResult',
    'PromptRegistryScanSourceRequest',
    'PromptRegistryScanSourceResult',
    'PromptRegistrySourceDescriptor',
    'PromptRegistrySources',
] as const;

function mcpPredecessorExport(
    name: (typeof MCP_DTO_EXPORTS)[number],
): readonly [ownerPath: string, ownerName: string] {
    return name === 'McpDiscoveredEndpoint'
        ? ['src/activation.ts', 'PluginMcpDiscoveredEndpoint']
        : ['src/services/resources.ts', `Plugin${name}`];
}

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

let sdkProgram: ts.Program | undefined;

function readSdkProgram(): ts.Program {
    sdkProgram ??= createSdkProgram();
    return sdkProgram;
}

function moduleExports(
    program: ts.Program,
    relativePath: string,
): readonly ts.Symbol[] {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!sourceFile) throw new Error(`Missing source module: ${relativePath}`);
    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
    return program.getTypeChecker().getExportsOfModule(moduleSymbol);
}

function exportIdentity(
    program: ts.Program,
    relativePath: string,
    exportName: string,
): ts.Symbol {
    const symbol = moduleExports(program, relativePath)
        .find((candidate) => candidate.name === exportName);
    if (!symbol) throw new Error(`Missing ${exportName} from ${relativePath}`);
    return symbol.flags & ts.SymbolFlags.Alias
        ? program.getTypeChecker().getAliasedSymbol(symbol)
        : symbol;
}

function directNamedExports(source: string): readonly Readonly<{
    name: string;
    specifier: string | undefined;
}>[] {
    const sourceFile = ts.createSourceFile(
        'source.ts',
        source,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TS,
    );
    return sourceFile.statements.flatMap((statement) => {
        if (!ts.isExportDeclaration(statement)
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)) {
            return [];
        }
        const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined;
        return statement.exportClause.elements.map((element) => ({
            name: element.name.text,
            specifier,
        }));
    });
}

describe('pre-publication MCP and resources source projections', () => {
    it('projects the adjudicated MCP DTOs under final names and preserves their owners', () => {
        const program = readSdkProgram();
        const sourcePath = 'src/mcp/index.ts';
        const exportNames = moduleExports(program, sourcePath).map((symbol) => symbol.name);
        const legacyExportNames = moduleExports(program, 'src/mcp.ts').map((symbol) => symbol.name);

        expect(MCP_DTO_EXPORTS.filter((name) => !exportNames.includes(name))).toEqual([]);
        expect(exportNames.filter((name) => name.startsWith('PluginMcp'))).toEqual([]);
        expect(MCP_DTO_EXPORTS.filter((name) => legacyExportNames.includes(name))).toEqual([]);

        for (const name of MCP_DTO_EXPORTS) {
            const [ownerPath, ownerName] = mcpPredecessorExport(name);
            expect(exportIdentity(program, sourcePath, name)).toBe(
                exportIdentity(program, ownerPath, ownerName),
            );
        }
    }, 120_000);

    it('owns the exact prompt author aliases only on resources and projects runtime compatibility directly', async () => {
        const program = readSdkProgram();
        const exportNames = moduleExports(program, 'src/resources.ts').map((symbol) => symbol.name);
        const promptExportNames = exportNames
            .filter((name) => /^(?:PromptAsset|PromptRegistry)/u.test(name))
            .sort();
        const serviceResourceSource = await readFile(
            new URL('./services/resources.ts', import.meta.url),
            'utf8',
        );
        const serviceIndexSource = await readFile(
            new URL('./services/index.ts', import.meta.url),
            'utf8',
        );
        const runtimeSource = await readFile(
            new URL('./runtime/index.ts', import.meta.url),
            'utf8',
        );
        const runtimePromptExports = directNamedExports(runtimeSource)
            .filter(({ name }) => /^(?:PluginPromptAssetContributionV1|PromptAsset|PromptRegistry)/u.test(name));

        expect(promptExportNames).toEqual([...RESOURCE_PROMPT_EXPORTS].sort());
        expect(exportNames.filter((name) => /^(?:Plugin)?Mcp/u.test(name))).toEqual([]);
        expect(serviceResourceSource).not.toMatch(/(?:PluginPromptAssetContributionV1|PromptAsset|PromptRegistry)/u);
        expect(serviceIndexSource).not.toMatch(/(?:PluginPromptAssetContributionV1|PromptAsset|PromptRegistry)/u);
        expect(runtimePromptExports).toEqual(
            RESOURCE_PROMPT_EXPORTS
                .filter((name) => name !== 'PromptAssetCapabilities'
                    && name !== 'PromptAssetContribution'
                    && name !== 'PromptAssetTypeDescriptor')
                .map((name) => ({ name, specifier: '../resources.js' })),
        );
    }, 45_000);

    it('keeps resources type-only and exposes only the approved MCP normalization value', async () => {
        expect(Object.keys(await import('./resources.js'))).toEqual([]);
        expect(Object.keys(await import('./mcp/index.js'))).toEqual(['normalizeDetectedMcpServerV1']);
    }, 45_000);
});
