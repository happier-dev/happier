import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const MCP_EXPORT_OWNERS = {
    DetectedMcpServerV1: ['../mcp.js', 'DetectedMcpServerV1'],
    DiscoveryWarning: ['../mcp.js', 'McpDiscoveryWarningV1'],
    McpAnnotations: ['../services/resources.js', 'PluginMcpAnnotations'],
    McpBlobResourceContents: ['../services/resources.js', 'PluginMcpBlobResourceContents'],
    McpClient: ['../services/resources.js', 'PluginMcpClient'],
    McpDiscoveredEndpoint: ['../activation.js', 'PluginMcpDiscoveredEndpoint'],
    McpDiscoveredServer: ['../services/resources.js', 'PluginMcpDiscoveredServer'],
    McpDiscoverySourceContribution: ['@happier-dev/protocol', 'PluginMcpDiscoverySourceContributionV1'],
    McpDiscoverySourceRef: ['../services/resources.js', 'PluginMcpDiscoverySourceRef'],
    McpDiscoveryRequest: ['../activation.js', 'PluginMcpDiscoveryRequest'],
    McpDiscoveryResult: ['../activation.js', 'PluginMcpDiscoveryResult'],
    McpGetPromptResult: ['../services/resources.js', 'PluginMcpGetPromptResult'],
    McpIcon: ['../services/resources.js', 'PluginMcpIcon'],
    McpListToolsRequest: ['../activation.js', 'PluginMcpListToolsRequest'],
    McpPageOptions: ['../services/resources.js', 'PluginMcpPageOptions'],
    McpPrompt: ['../services/resources.js', 'PluginMcpPrompt'],
    McpPromptArgument: ['../services/resources.js', 'PluginMcpPromptArgument'],
    McpPromptContent: ['../services/resources.js', 'PluginMcpPromptContent'],
    McpPromptMessage: ['../services/resources.js', 'PluginMcpPromptMessage'],
    McpPromptPage: ['../services/resources.js', 'PluginMcpPromptPage'],
    McpReadResourceResult: ['../services/resources.js', 'PluginMcpReadResourceResult'],
    McpRegistrationApi: ['../activation.js', 'PluginMcpRegistrationApi'],
    McpResource: ['../services/resources.js', 'PluginMcpResource'],
    McpResourceContents: ['../services/resources.js', 'PluginMcpResourceContents'],
    McpResourcePage: ['../services/resources.js', 'PluginMcpResourcePage'],
    McpResourceTemplate: ['../services/resources.js', 'PluginMcpResourceTemplate'],
    McpResourceTemplatePage: ['../services/resources.js', 'PluginMcpResourceTemplatePage'],
    McpResourceUpdatedEvent: ['../services/resources.js', 'PluginMcpResourceUpdatedEvent'],
    McpServerContribution: ['@happier-dev/protocol', 'PluginMcpServerContributionV1'],
    McpServerRef: ['../services/resources.js', 'PluginMcpServerRef'],
    McpServerRuntime: ['../activation.js', 'PluginMcpServerRuntime'],
    McpServerTransport: ['../mcp.js', 'McpServerTransportV1'],
    McpService: ['../services/resources.js', 'McpService'],
    McpTextResourceContents: ['../services/resources.js', 'PluginMcpTextResourceContents'],
    McpTool: ['../services/resources.js', 'PluginMcpTool'],
    McpToolPage: ['../services/resources.js', 'PluginMcpToolPage'],
    McpToolCallContent: ['../activation.js', 'PluginMcpToolCallContent'],
    McpToolCallRequest: ['../activation.js', 'PluginMcpToolCallRequest'],
    McpToolCallResult: ['../activation.js', 'PluginMcpToolCallResult'],
    McpToolPageOptions: ['../services/resources.js', 'PluginMcpToolPageOptions'],
    normalizeDetectedMcpServerV1: ['../mcp.js', 'normalizeDetectedMcpServerV1'],
} as const;

const MCP_EXPORT_NAMES = Object.keys(MCP_EXPORT_OWNERS).sort();

const INTERNAL_MCP_BRIDGE_EXPORTS = [
    'McpEndpointTransportV1',
    'McpHostedRuntimeExposureV1',
    'McpHostedServerDefinitionV1',
    'McpHostedServerTransportV1',
    'McpHostedToolAnnotationsV1',
    'McpHostedToolCallContextV1',
    'McpHostedToolContentV1',
    'McpHostedToolDefinitionV1',
    'McpHostedToolHandlerV1',
    'McpHostedToolResultV1',
    'McpHostedToolTextContentV1',
    'McpServerSpecV1',
    'McpStdioTransportV1',
    'McpResolveForSessionInputV1',
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

function ownerSymbol(
    program: ts.Program,
    specifier: string,
    exportName: string,
): ts.Symbol {
    const containingFile = sourceFile(program, 'src/mcp/projections.ts').fileName;
    const resolved = ts.resolveModuleName(
        specifier,
        containingFile,
        program.getCompilerOptions(),
        ts.sys,
    ).resolvedModule;
    if (!resolved) throw new Error(`Unable to resolve ${specifier} from src/mcp/projections.ts`);
    const ownerSource = program.getSourceFile(resolved.resolvedFileName);
    if (!ownerSource) throw new Error(`Missing resolved source for ${specifier}`);
    const ownerModule = program.getTypeChecker().getSymbolAtLocation(ownerSource);
    if (!ownerModule) throw new Error(`Missing module symbol for ${specifier}`);
    const symbol = program.getTypeChecker().getExportsOfModule(ownerModule)
        .find((candidate) => candidate.name === exportName);
    if (!symbol) throw new Error(`Missing ${exportName} from ${specifier}`);
    return canonicalSymbol(program, symbol);
}

function directNamedExports(source: string): readonly Readonly<{
    name: string;
    ownerName: string;
    specifier: string;
    typeOnly: boolean;
}>[] {
    const parsed = ts.createSourceFile(
        'projections.ts',
        source,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TS,
    );
    return parsed.statements.flatMap((statement) => {
        if (!ts.isExportDeclaration(statement)
            || !statement.moduleSpecifier
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)) {
            throw new Error('MCP projections must contain only direct named re-exports');
        }
        const specifier = statement.moduleSpecifier.text;
        const typeOnly = statement.isTypeOnly;
        return statement.exportClause.elements.map((element) => ({
            name: element.name.text,
            ownerName: element.propertyName?.text ?? element.name.text,
            specifier,
            typeOnly: typeOnly || element.isTypeOnly,
        }));
    });
}

describe('MCP package-local publication projection', () => {
    it('keeps hosted-loopback and session-resolution implementation shapes out of the SDK module', () => {
        const program = readSdkProgram();
        const exports = moduleExports(program, 'src/mcp.ts').map((symbol) => symbol.name);

        for (const internalName of INTERNAL_MCP_BRIDGE_EXPORTS) {
            expect(exports).not.toContain(internalName);
        }
    }, 120_000);

    it('contains exactly the approved 41-symbol MCP author surface', () => {
        const program = readSdkProgram();
        expect(moduleExports(program, 'src/mcp/projections.ts')
            .map((symbol) => symbol.name)
            .sort()).toEqual(MCP_EXPORT_NAMES);
    }, 120_000);

    it('directly aliases every final name to its canonical owner', async () => {
        const program = readSdkProgram();
        const source = await readFile(new URL('./projections.ts', import.meta.url), 'utf8');
        const directExports = [...directNamedExports(source)]
            .sort((left, right) => left.name.localeCompare(right.name));

        expect(directExports).toEqual(MCP_EXPORT_NAMES.map((name) => {
            const [specifier, ownerName] = MCP_EXPORT_OWNERS[name as keyof typeof MCP_EXPORT_OWNERS];
            return {
                name,
                ownerName,
                specifier,
                typeOnly: name !== 'normalizeDetectedMcpServerV1',
            };
        }));

        for (const name of MCP_EXPORT_NAMES) {
            const [specifier, ownerName] = MCP_EXPORT_OWNERS[name as keyof typeof MCP_EXPORT_OWNERS];
            expect(exportedSymbol(program, 'src/mcp/projections.ts', name)).toBe(
                ownerSymbol(program, specifier, ownerName),
            );
        }
    }, 120_000);

    it('adds no runtime wrapper or second registry', async () => {
        expect(Object.keys(await import('./projections.js')))
            .toEqual(['normalizeDetectedMcpServerV1']);
    }, 45_000);
});
