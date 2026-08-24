import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type {
    AgentSessionCompactRequest as CanonicalAgentSessionCompactRequest,
    AgentSessionProviderCheckpointV1 as CanonicalAgentSessionProviderCheckpoint,
    AgentSessionRuntimeEvent as CanonicalAgentSessionRuntimeEvent,
    AgentSessionSendRequest as CanonicalAgentSessionSendRequest,
} from '@happier-dev/protocol/runtime';
import type {
    AgentSessionProviderBinding as CanonicalAgentSessionProviderBinding,
    AgentSessionStartupInstructionsV1 as CanonicalAgentSessionStartupInstructions,
} from '@happier-dev/protocol';

import type {
    ConnectedAccountCredentialStore,
    ConnectedAccountRuntime,
} from './connectedAccounts.js';
import type {
    ComposerAttachmentMessageAcceptedV1,
    ComposerAttachmentPrepareOutcomeV1,
    ComposerAttachmentPrepareRequestV1,
    ComposerAttachmentPrepareResultV1,
    ComposerAttachmentResolveRequestV1,
    ComposerAttachmentResolveResultV1,
    ComposerAttachmentRuntime,
} from './activation.js';
import type { ComposerStagedMediaContentV1 } from './composer.js';
import type { PluginDiagnosticData } from './diagnostics.js';
import type { JsonValue, PluginJsonValueV2 } from './identity.js';
import type { PluginUiIconTokenV1 } from './ui.js';
import type {
    AgentSessionConversationRollbackReconciliationResult,
    AgentSessionConversationRollbackRequest,
    AgentSessionConversationRollbackResult,
} from './agentRuntime/controls.js';
import type {
    AgentSessionCompactRequest,
    AgentSessionConnectedAccountSelection,
    AgentSessionOpenRequest,
    AgentSessionProviderBinding,
    AgentSessionProviderCheckpoint,
    AgentSessionRuntimeEvent,
    AgentSessionSendRequest,
} from './agentRuntime/session.js';

function parseSource(fileName: string, sourceText: string): ts.SourceFile {
    return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function exportedTypeAlias(
    sourceFile: ts.SourceFile,
    name: string,
): ts.TypeAliasDeclaration | undefined {
    return sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => (
        ts.isTypeAliasDeclaration(statement)
        && statement.name.text === name
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ));
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
    exportedName: string,
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
        const binding = statement.exportClause.elements.find((element) => element.name.text === exportedName);
        if (binding) return (binding.propertyName ?? binding.name).text;
    }
    return undefined;
}

function exportedCallableTypeText(
    sourceFile: ts.SourceFile,
    name: string,
): string | undefined {
    const functionDeclaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
        ts.isFunctionDeclaration(statement)
        && statement.name?.text === name
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ));
    if (functionDeclaration) {
        return [
            ...functionDeclaration.parameters.map((parameter) => parameter.type?.getText(sourceFile) ?? ''),
            functionDeclaration.type?.getText(sourceFile) ?? '',
        ].join(' ');
    }

    for (const statement of sourceFile.statements) {
        if (
            !ts.isVariableStatement(statement)
            || statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true
        ) {
            continue;
        }
        const declaration = statement.declarationList.declarations.find(
            (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
        );
        if (!declaration) continue;
        if (declaration.type) return declaration.type.getText(sourceFile);
        if (declaration.initializer && ts.isAsExpression(declaration.initializer)) {
            return declaration.initializer.type.getText(sourceFile);
        }
    }
    return undefined;
}

interface DeclarationEmissionOwner {
    readonly program: ts.Program;
    readonly declarations: Map<string, string>;
}

let declarationEmissionOwner: DeclarationEmissionOwner | undefined;

// These are the source declarations that this file validates through the real
// TypeScript declaration emitter. Keep the compiler program rooted here: a
// declaration closure must resolve and declaration-check its transitive
// dependencies, but an unrelated SDK entrypoint must not make this focused
// author-surface contract slow or fail because it is separately covered by the
// package typecheck.
const DECLARATION_CLOSURE_SOURCE_URLS = [
    './actions/executionOrigin.ts',
    './collections.ts',
    './manifest.ts',
    './connectedAccounts.ts',
    './connected-accounts/index.ts',
    './connected-accounts/index.public.ts',
    './connected-accounts/projections.ts',
    './cloud/auth.ts',
    './definePlugin.ts',
    './services/index.ts',
    './services/connectedAccounts.ts',
    './services/sessions.ts',
    './agentRuntime/session.ts',
    './actions/service.ts',
    './voice/client.ts',
] as const;

const declarationClosureSourcePaths = new Set(
    DECLARATION_CLOSURE_SOURCE_URLS.map((relativeSourceUrl) => (
        fileURLToPath(new URL(relativeSourceUrl, import.meta.url))
    )),
);

function getDeclarationEmissionOwner(): DeclarationEmissionOwner {
    if (declarationEmissionOwner) return declarationEmissionOwner;

    const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
    });
    if (!parsed) throw new Error(`Unable to parse ${configPath}`);
    const program = ts.createProgram({
        rootNames: [...declarationClosureSourcePaths],
        options: {
            ...parsed.options,
            declaration: true,
            declarationMap: false,
            emitDeclarationOnly: true,
            incremental: false,
        },
        projectReferences: parsed.projectReferences,
    });
    declarationEmissionOwner = { program, declarations: new Map() };
    return declarationEmissionOwner;
}

function emittedDeclarationForSourcePath(sourcePath: string): string {
    const owner = getDeclarationEmissionOwner();
    const cachedDeclaration = owner.declarations.get(sourcePath);
    if (cachedDeclaration) return cachedDeclaration;

    const sourceFile = owner.program.getSourceFile(sourcePath);
    if (!sourceFile) throw new Error(`Missing ${sourcePath}`);
    const diagnostics = owner.program.getDeclarationDiagnostics(sourceFile);
    if (diagnostics.length > 0) {
        throw new Error(diagnostics.map((diagnostic) => (
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        )).join('\n'));
    }

    let declaration = '';
    const result = owner.program.emit(sourceFile, (fileName, contents) => {
        if (fileName.endsWith('.d.ts')) declaration = contents;
    }, undefined, true);
    if (result.diagnostics.length > 0) {
        throw new Error(result.diagnostics.map((diagnostic) => (
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        )).join('\n'));
    }
    if (!declaration) throw new Error(`No declaration emitted for ${sourcePath}`);
    owner.declarations.set(sourcePath, declaration);
    return declaration;
}

function emittedDeclaration(relativeSourceUrl: string): string {
    const sourcePath = fileURLToPath(new URL(relativeSourceUrl, import.meta.url));
    if (!declarationClosureSourcePaths.has(sourcePath)) {
        throw new Error(`Declaration fixture root is not declared: ${relativeSourceUrl}`);
    }
    return emittedDeclarationForSourcePath(sourcePath);
}

function emittedIsolatedDeclaration(fileName: string, sourceText: string): string {
    const result = ts.transpileDeclaration(sourceText, {
        fileName,
        compilerOptions: {
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
    });
    if (result.diagnostics?.length) {
        throw new Error(result.diagnostics.map((diagnostic) => (
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        )).join('\n'));
    }
    return result.outputText;
}

describe('normal SDK declaration closure identities', () => {
    it('scans every matching import before deciding a public identity is absent', () => {
        const sourceFile = parseSource('split-imports.ts', [
            "import { EarlierIdentity } from '@happier-dev/protocol';",
            "import { CanonicalIdentity as LaterIdentity } from '@happier-dev/protocol';",
        ].join('\n'));

        expect(importedName(
            sourceFile,
            '@happier-dev/protocol',
            'LaterIdentity',
        )).toBe('CanonicalIdentity');
    });

    it('keeps Agent model option override rules on the canonical Protocol identity across author barrels', async () => {
        const [agentsSource, agentsBarrelSource] = await Promise.all([
            readFile(new URL('./agents.ts', import.meta.url), 'utf8'),
            readFile(new URL('./agents/index.ts', import.meta.url), 'utf8'),
        ]);
        const agents = parseSource('agents.ts', agentsSource);
        const agentsBarrel = parseSource('agents/index.ts', agentsBarrelSource);

        expect(reexportedName(
            agents,
            '@happier-dev/protocol',
            'AgentModelOptionOverrideRule',
        )).toBe('AgentModelOptionOverrideRule');
        expect(reexportedName(
            agentsBarrel,
            '../agents.js',
            'AgentModelOptionOverrideRule',
        )).toBe('AgentModelOptionOverrideRule');

        expect(emittedIsolatedDeclaration('agents.ts', agentsSource)).toMatch(
            /AgentModelOptionOverrideRule[\s\S]*from ['"]@happier-dev\/protocol['"]/u,
        );
    });

    it('keeps portable manifest parse identities local to external author declarations', async () => {
        const sourceText = await readFile(new URL('./manifest.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('manifest.ts', sourceText);
        const declaration = emittedIsolatedDeclaration('manifest.ts', sourceText);
        const parseResult = exportedTypeAlias(sourceFile, 'PluginManifestParseResult');
        const parsedManifest = sourceFile.statements.find((statement): statement is ts.InterfaceDeclaration => (
            ts.isInterfaceDeclaration(statement)
            && statement.name.text === 'ParsedPluginManifest'
            && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
        ));
        const diagnostic = exportedTypeAlias(sourceFile, 'PluginManifestDiagnostic');

        expect(parsedManifest?.getText(sourceFile)).toContain('interface ParsedPluginManifest');
        expect(parsedManifest?.getText(sourceFile)).toContain('PluginManifest');
        expect(parsedManifest?.getText(sourceFile)).toContain('PluginContributes');
        expect(diagnostic?.type.getText(sourceFile)).not.toMatch(/PluginManifestIngestionDiagnostic/u);
        expect(parseResult?.type.getText(sourceFile)).toContain('ParsedPluginManifest');
        expect(parseResult?.type.getText(sourceFile)).toContain('PluginManifestDiagnostic');
        expect(parseResult?.type.getText(sourceFile)).not.toMatch(
            /ParsedPluginManifestV2|PluginManifestIngestionResult/u,
        );
        expect(exportedCallableTypeText(sourceFile, 'parsePluginManifest'))
            .toMatch(/unknown PluginManifestParseResult/u);
        expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        for (const hostOnlyName of [
            'PluginContributionRegistrationRight',
            'PluginContributionRegistrationTarget',
            'PluginManifestIngestionResult',
        ]) {
            for (const protocolPath of [
                '@happier-dev/protocol',
                '@happier-dev/protocol/plugins/manifest',
            ]) {
                expect(reexportedName(sourceFile, protocolPath, hostOnlyName))
                    .toBeUndefined();
            }
        }
    });

    it('keeps public author root declarations free of Zod and uses only the required Protocol identity seam', () => {
        const declarations = {
            manifest: emittedDeclaration('./manifest.ts'),
            connectedAccounts: emittedDeclaration('./connectedAccounts.ts'),
            definePlugin: emittedDeclaration('./definePlugin.ts'),
            sessions: emittedDeclaration('./services/sessions.ts'),
        };

        // Every module is compared in ONE assertion. A per-module `expect`
        // inside the loop throws on the first violation, which silently stops
        // the remaining modules from being checked at all: while `manifest`
        // carries a leak, the `connectedAccounts` seam below is unreachable and
        // a regression there passes unnoticed.
        const protocolSpecifiersByModule: Record<string, readonly string[]> = {};
        const zodBearingModules: string[] = [];
        for (const [name, declaration] of Object.entries(declarations)) {
            const sourceFile = parseSource(`${name}.d.ts`, declaration);
            const externalSpecifiers = sourceFile.statements.flatMap((statement) => {
                if (
                    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
                    && statement.moduleSpecifier
                    && ts.isStringLiteral(statement.moduleSpecifier)
                ) {
                    return [statement.moduleSpecifier.text];
                }
                return [];
            });

            protocolSpecifiersByModule[name] = [...new Set(externalSpecifiers.filter((specifier) => (
                specifier === '@happier-dev/protocol'
                || specifier.startsWith('@happier-dev/protocol/')
            )))].sort();
            if (
                externalSpecifiers.includes('zod')
                || /\b(?:z\.Zod|Zod[A-Za-z])/u.test(declaration)
            ) {
                zodBearingModules.push(name);
            }
        }

        expect(protocolSpecifiersByModule).toEqual({
            manifest: [],
            connectedAccounts: [
                '@happier-dev/protocol/account/settings/connected-services',
                '@happier-dev/protocol/connect/connected-account-purpose-bindings',
                '@happier-dev/protocol/connect/connected-account-purposes',
                '@happier-dev/protocol/connect/connected-account-request-auth',
                '@happier-dev/protocol/connect/connected-service-bindings',
                '@happier-dev/protocol/connect/connected-service-limit-category',
                '@happier-dev/protocol/connect/connected-service-schemas',
                '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2',
                '@happier-dev/protocol/connect/qualified-connected-account-persistence',
                '@happier-dev/protocol/connect/qualified-connected-account-projections',
                '@happier-dev/protocol/sessions/work-state',
            ],
            definePlugin: [],
            sessions: [],
        });
        expect(zodBearingModules).toEqual([]);

        for (const [name, declaration] of Object.entries({
            actionsExecutionOrigin: emittedDeclaration('./actions/executionOrigin.ts'),
            collections: emittedDeclaration('./collections.ts'),
        })) {
            expect(declaration, name).not.toMatch(/\bfrom\s+['"]zod(?:\/[^'"]*)?['"]/u);
            expect(declaration, name).not.toMatch(/\b(?:z\.Zod|Zod[A-Za-z])/u);
        }

        const connectedAccountsDeclaration = parseSource(
            'connectedAccounts.d.ts',
            declarations.connectedAccounts,
        );
        for (const publicName of ['QualifiedConnectedAccountRefJsonSchema']) {
            expect(reexportedName(
                connectedAccountsDeclaration,
                '@happier-dev/protocol/connect/qualified-connected-account-persistence',
                publicName,
            ), publicName).toBe(publicName);
        }
        for (const publicName of [
            'ConnectedAccountHttpHeadersRequest',
            'ConnectedAccountMaterializationRequest',
            'ConnectedAccountPurposeId',
            'PluginConnectedAccountMaterializationKind',
        ]) {
            expect(reexportedName(
                connectedAccountsDeclaration,
                '@happier-dev/protocol/connect/connected-account-purposes',
                publicName,
            ), publicName).toBe(publicName);
        }
        for (const publicName of [
            'ConnectedAccountAuthFailureRequestV1Schema',
            'ConnectedAccountQuotaFailureRequestV1Schema',
            'ConnectedAccountRequestAuthUsesV1Schema',
        ]) {
            expect(reexportedName(
                connectedAccountsDeclaration,
                '@happier-dev/protocol/connect/connected-account-request-auth',
                publicName,
            ), publicName).toBe(publicName);
        }
        for (const publicName of [
            'ConnectedServiceAuthGroupId',
            'ConnectedServiceAuthGroupIdSchema',
            'ConnectedServiceBindingsV1Schema',
            'ConnectedServiceId',
            'ConnectedServiceProfileId',
            'ConnectedServiceProfileIdSchema',
        ]) {
            expect(reexportedName(
                connectedAccountsDeclaration,
                '@happier-dev/protocol/connect/connected-service-bindings',
                publicName,
            ), publicName).toBe(publicName);
        }
        expect(reexportedName(
            connectedAccountsDeclaration,
            '@happier-dev/protocol/connect/connected-service-bindings',
            'ConnectedServiceBindings',
        )).toBe('ConnectedServiceBindingsV1');
        expect(reexportedName(
            connectedAccountsDeclaration,
            '@happier-dev/protocol/connect/connected-service-limit-category',
            'ConnectedServiceLimitCategoryV1',
        )).toBe('ConnectedServiceLimitCategoryV1');
        expect(reexportedName(
            connectedAccountsDeclaration,
            '@happier-dev/protocol/connect/qualified-connected-account-persistence',
            'QualifiedConnectedAccountRef',
        )).toBe('QualifiedConnectedAccountRef');
        for (const publicName of [
            'ConnectedServiceCredentialRevisionV1',
            'ConnectedServiceCredentialRevisionV1Schema',
            'ConnectedServiceQuotaRecoveryCreditKindV1',
            'ConnectedServiceQuotaRecoveryCreditStatusV1',
            'ConnectedServiceQuotaRecoveryCreditV1',
            'ConnectedServiceQuotaRecoveryCreditsV1',
            'ConnectedServiceQuotaMeterV1',
            'ConnectedServiceQuotaSnapshotV1',
            'ConnectedServiceUsageSourceV1',
            'ConnectedServiceQuotaRecoveryCreditKindV1Schema',
            'ConnectedServiceQuotaRecoveryCreditStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditV1Schema',
            'ConnectedServiceQuotaRecoveryCreditsV1Schema',
            'ConnectedServiceQuotaSnapshotV1Schema',
            'ConnectedServiceUsageSourceV1Schema',
        ]) {
            expect(reexportedName(
                connectedAccountsDeclaration,
                '@happier-dev/protocol/connect/connected-service-schemas',
                publicName,
            ), publicName).toBe(publicName);
        }
        for (const publicName of [
            'QualifiedConnectedAccountGroupV4Schema',
            'QualifiedConnectedAccountListResponseV4Schema',
        ]) {
            expect(reexportedName(
                connectedAccountsDeclaration,
                '@happier-dev/protocol/connect/qualified-connected-account-projections',
                publicName,
            ), publicName).toBe(publicName);
        }
        expect(reexportedName(
            connectedAccountsDeclaration,
            '@happier-dev/protocol/connect/connected-account-purpose-bindings',
            'QualifiedConnectedAccountPurposeBindingV1Schema',
        )).toBe('QualifiedConnectedAccountPurposeBindingV1Schema');
        for (const publicName of [
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema',
        ]) {
            expect(reexportedName(
                connectedAccountsDeclaration,
                '@happier-dev/protocol/sessions/work-state',
                publicName,
            ), publicName).toBe(publicName);
        }
        expect(declarations.connectedAccounts).not.toMatch(
            /\bConnectedAccount(?:Composable|Optional)?Schema\b/u,
        );
    // This remains one cached, real TypeScript declaration closure. Under
    // shared CPU contention its cold compiler phase can exceed the ordinary
    // test budget even after unrelated roots and repeated diagnostics are
    // removed; keep that bounded without forcing a false timeout.
    }, 90_000);

    it('keeps direct Connected Accounts facade declarations off the Protocol root', async () => {
        const sources = await Promise.all([
            './connectedAccounts.ts',
            './cloud/auth.ts',
            './connected-accounts/projections.ts',
            './services/index.ts',
            './runtime/index.ts',
        ].map(async (relativeSourceUrl) => {
            const sourceText = await readFile(new URL(relativeSourceUrl, import.meta.url), 'utf8');
            const declaration = relativeSourceUrl === './runtime/index.ts'
                ? emittedIsolatedDeclaration(relativeSourceUrl, sourceText)
                : emittedDeclaration(relativeSourceUrl);
            return [relativeSourceUrl, parseSource(`${relativeSourceUrl}.d.ts`, declaration)] as const;
        }));

        for (const [relativeSourceUrl, declaration] of sources) {
            const protocolSpecifiers = declaration.statements.flatMap((statement): readonly string[] => (
                (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
                && statement.moduleSpecifier
                && ts.isStringLiteral(statement.moduleSpecifier)
                && (statement.moduleSpecifier.text === '@happier-dev/protocol'
                    || statement.moduleSpecifier.text.startsWith('@happier-dev/protocol/'))
                    ? [statement.moduleSpecifier.text]
                    : []
            ));

            expect(protocolSpecifiers, relativeSourceUrl).not.toContain('@happier-dev/protocol');
        }
    }, 90_000);

    it('routes Connected Accounts barrel declarations through their canonical facade or Protocol subpath', async () => {
        const targets = [
            {
                relativeSourceUrl: './services/index.ts',
                moduleSpecifier: '../connectedAccounts.js',
                exportName: 'PluginConnectedAccountMaterializationKind',
                ownerName: 'PluginConnectedAccountMaterializationKind',
            },
            {
                relativeSourceUrl: './runtime/index.ts',
                moduleSpecifier: '../connectedAccounts.js',
                exportName: 'PluginConnectedAccountMaterializationKind',
                ownerName: 'PluginConnectedAccountMaterializationKind',
            },
            {
                relativeSourceUrl: './connected-accounts/projections.ts',
                moduleSpecifier: '@happier-dev/protocol/connect/connected-account-purposes',
                exportName: 'ConnectedAccountPurposeDeclarations',
                ownerName: 'ConnectedAccountPurposeDeclarationsV1',
            },
        ] as const;

        for (const target of targets) {
            const sourceText = await readFile(new URL(target.relativeSourceUrl, import.meta.url), 'utf8');
            const source = parseSource(target.relativeSourceUrl, sourceText);
            const declaration = parseSource(
                `${target.relativeSourceUrl}.d.ts`,
                emittedIsolatedDeclaration(target.relativeSourceUrl, sourceText),
            );

            expect(reexportedName(
                source,
                target.moduleSpecifier,
                target.exportName,
            ), target.relativeSourceUrl).toBe(target.ownerName);
            expect(reexportedName(
                declaration,
                target.moduleSpecifier,
                target.exportName,
            ), target.relativeSourceUrl).toBe(target.ownerName);
            expect(sourceText, target.relativeSourceUrl).not.toMatch(/@happier-dev\/protocol['"]/u);
            expect(declaration.getText(), target.relativeSourceUrl).not.toMatch(/@happier-dev\/protocol['"]/u);
        }
    });

    it('keeps selected pull-request review scope identities at the canonical Protocol owner', async () => {
        const sourceText = await readFile(new URL('./reviews/scope.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('reviews/scope.ts', sourceText);
        const declaration = emittedIsolatedDeclaration('reviews/scope.ts', sourceText);
        const emitted = parseSource('reviews/scope.d.ts', declaration);
        const scope = exportedTypeAlias(emitted, 'ScmPullRequestReviewScopeV1');
        const production = exportedTypeAlias(emitted, 'ScmPullRequestReviewScopeProductionV1');

        expect(scope?.type.getText(emitted)).toBe('ProtocolScmPullRequestReviewScopeV1');
        expect(production?.type.getText(emitted)).toBe('ProtocolScmPullRequestReviewScopeProductionV1');
        expect(importedName(
            emitted,
            '@happier-dev/protocol',
            'ProtocolScmPullRequestReviewScopeV1',
        )).toBe('ScmPullRequestReviewScopeV1');
        expect(reexportedName(
            emitted,
            '@happier-dev/protocol',
            'ScmPullRequestReviewScopeV1Schema',
        )).toBe('ScmPullRequestReviewScopeV1Schema');
        expect(exportedCallableTypeText(sourceFile, 'produceScmPullRequestReviewScope'))
            .toBe('typeof canonicalProduceScmPullRequestReviewScope');
        expect(declaration).not.toMatch(/\b(?:z\.Zod|Zod[A-Za-z])/u);
    });

    it('keeps public UI and testkit author declarations independent from private Protocol and Zod types', async () => {
        const sources = await Promise.all([
            './ui.ts',
            './ui/compatibility.ts',
            './ui/declarativeDocument.ts',
            './ui/hostApi.ts',
            './ui/hostedWeb.ts',
            './testing/types.ts',
            './testing/uiHost.ts',
            './testing/host.ts',
            './ui/build/toolchainCompatibility.ts',
            './ui/reactNativeBuild.ts',
            './ui/reactNativeWebBuild.ts',
        ].map(async (relativeSourceUrl) => ([
            relativeSourceUrl,
            await readFile(new URL(relativeSourceUrl, import.meta.url), 'utf8'),
        ] as const)));

        for (const [relativeSourceUrl, sourceText] of sources) {
            let declaration: string;
            try {
                declaration = emittedIsolatedDeclaration(relativeSourceUrl, sourceText);
            } catch (error) {
                throw new Error(`${relativeSourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
            }
            expect(declaration, relativeSourceUrl).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
            expect(declaration, relativeSourceUrl).not.toMatch(/\bzod\b/u);
            expect(declaration, relativeSourceUrl).not.toMatch(/\b(?:z\.Zod|Zod[A-Za-z])/u);
        }
    });

    it('projects Session system-record facts through SDK-local author declarations', async () => {
        const sourceText = await readFile(new URL('./services/sessions.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('services/sessions.ts', sourceText);
        const declarationSourceFile = parseSource('services/sessions.d.ts', declaration);

        expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        for (const name of [
            'SessionSystemRecord',
            'SessionSystemRecordAddress',
            'SessionSystemRecordDeleteRequest',
            'SessionSystemRecordListQuery',
            'SessionSystemRecordPage',
            'SessionSystemRecordReadRequest',
            'SessionSystemRecordRevision',
            'SessionSystemRecordUpsertRequest',
        ]) {
            expect(exportedTypeAlias(declarationSourceFile, name), name).toBeDefined();
        }
        expect(exportedTypeAlias(declarationSourceFile, 'SessionSystemRecord')?.type.getText(declarationSourceFile))
            .toContain('SessionSystemRecordAddress');
        expect(exportedTypeAlias(declarationSourceFile, 'SessionSystemRecordUpsertRequest')?.type.getText(declarationSourceFile))
            .toContain('JsonValue');
    });

    it('keeps structured-input consumers nameable through the public Sessions declaration', async () => {
        const sourceText = await readFile(new URL('./services/sessions.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('services/sessions.ts', sourceText);
        const declarationSourceFile = parseSource('services/sessions.d.ts', declaration);
        const publicBarrelText = await readFile(new URL('./sessions/index.ts', import.meta.url), 'utf8');
        const publicBarrelDeclaration = emittedIsolatedDeclaration('sessions/index.ts', publicBarrelText);
        const publicBarrelSourceFile = parseSource('sessions/index.d.ts', publicBarrelDeclaration);
        const publicationSpecText = await readFile(new URL('./sessions/index.public.ts', import.meta.url), 'utf8');
        const publicationSpecDeclaration = emittedIsolatedDeclaration('sessions/index.public.ts', publicationSpecText);
        const publicationSpecSourceFile = parseSource('sessions/index.public.d.ts', publicationSpecDeclaration);

        expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        expect(declaration).not.toMatch(/\bzod\b/u);
        expect(exportedTypeAlias(
            declarationSourceFile,
            'HappierStructuredInputV1',
        )?.type.getText(declarationSourceFile)).toContain('imageInputs?: StructuredImageInputV1[]');
        expect(exportedTypeAlias(
            declarationSourceFile,
            'StructuredImageInputV1',
        )?.type.getText(declarationSourceFile)).toContain("kind: 'localImage' | 'image'");
        expect(exportedTypeAlias(
            declarationSourceFile,
            'StructuredInputMentionSourcesV1',
        )?.type.getText(declarationSourceFile)).toContain('vendorPluginMentions: readonly VendorPluginMentionV1[]');
        expect(exportedTypeAlias(
            declarationSourceFile,
            'StructuredInputMentionSourcesV1',
        )?.type.getText(declarationSourceFile)).toContain('skillMentions: readonly SkillMentionV1[]');
        expect(reexportedName(
            publicBarrelSourceFile,
            '../services/sessions.js',
            'HappierStructuredInputV1',
        )).toBe('HappierStructuredInputV1');
        expect(reexportedName(
            publicBarrelSourceFile,
            '../services/sessions.js',
            'StructuredInputMentionSourcesV1',
        )).toBe('StructuredInputMentionSourcesV1');
        for (const publicName of [
            'StructuredImageInputV1',
            'VendorPluginMentionV1',
            'SkillMentionV1',
        ]) {
            expect(reexportedName(
                publicBarrelSourceFile,
                '../services/sessions.js',
                publicName,
            ), publicName).toBe(publicName);
            expect(reexportedName(
                publicationSpecSourceFile,
                '../services/sessions.js',
                publicName,
            ), publicName).toBe(publicName);
        }
    });

    it('projects External Session transcript author facts through an exact SDK-local declaration', async () => {
        const sourceText = await readFile(new URL('./externalSessions.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('externalSessions.ts', sourceText);
        const sourceFile = parseSource('externalSessions.ts', sourceText);
        const rawRecord = exportedTypeAlias(sourceFile, 'AgentExternalSessionTranscriptRawRecord');
        const transcriptItem = exportedTypeAlias(sourceFile, 'AgentExternalSessionTranscriptItem');

        expect(rawRecord).toBeDefined();
        if (!rawRecord) return;
        expect(rawRecord.type.getText(sourceFile)).toContain('JsonValue');
        expect(importedName(sourceFile, './identity.js', 'JsonValue')).toBe('JsonValue');
        expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        expect(declaration).toMatch(
            /import type \{ JsonValue \} from ['"]\.\/identity\.js['"];/u,
        );
        for (const publicName of [
            'AgentExternalSessionLinkData',
            'AgentExternalSessionLinkDataValue',
            'AgentExternalSessionTranscriptRawRecord',
            'AgentExternalSessionUserProjection',
        ]) {
            expect(declaration).toMatch(new RegExp(`\\b${publicName}\\b`, 'u'));
        }
        expect(importedName(sourceFile, './services/sessions.js', 'SessionMessageRole'))
            .toBe('SessionMessageRole');
        expect(transcriptItem?.type.getText(sourceFile)).toContain('SessionMessageRole');
        expect(transcriptItem?.type.getText(sourceFile)).not.toContain('SidechainId');
        expect(declaration).not.toMatch(/\bSidechainId\b/u);
    });

    it('spells Contribution Protocol manifest projections without private helper aliases', async () => {
        const sourceText = await readFile(new URL('./targetedContributionAuthoring.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('targetedContributionAuthoring.ts', sourceText);
        const declarationSourceFile = parseSource('targetedContributionAuthoring.d.ts', declaration);
        const manifest = exportedTypeAlias(declarationSourceFile, 'ContributionProtocolManifest');

        expect(manifest).toBeDefined();
        expect(manifest?.type.getText(declarationSourceFile)).not.toMatch(
            /\bProjectedContribution(?:Operation|Surface)\b/u,
        );
        expect(declaration).not.toMatch(/\bProjectedContribution(?:Operation|Surface)\b/u);
    });

    it('imports admitted targeted-operation identity from its realm-neutral leaf', async () => {
        const sourceText = await readFile(new URL('./targetedContributionAuthoring.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('targetedContributionAuthoring.ts', sourceText);
        const declarationSourceFile = parseSource('targetedContributionAuthoring.d.ts', declaration);

        expect(importedName(
            declarationSourceFile,
            './actions/admittedTargetedOperation.js',
            'AdmittedTargetedOperationExecutionHandle',
        )).toBe('AdmittedTargetedOperationExecutionHandle');
        expect(declaration).not.toMatch(/declare const .*TargetedOperation.*Evidence/iu);
        expect(exportedTypeAlias(
            declarationSourceFile,
            'AdmittedTargetedOperationExecutionHandle',
        )).toBeUndefined();
        expect(exportedTypeAlias(
            declarationSourceFile,
            'AdmittedTargetedOperationIdentity',
        )).toBeUndefined();
    });

    it('publishes targeted operation and surface handles as nameable opaque declaration classes', async () => {
        const [operationSourceText, authoringSourceText] = await Promise.all([
            readFile(new URL('./actions/admittedTargetedOperation.ts', import.meta.url), 'utf8'),
            readFile(new URL('./targetedContributionAuthoring.ts', import.meta.url), 'utf8'),
        ]);
        const operationDeclaration = emittedIsolatedDeclaration(
            'actions/admittedTargetedOperation.ts',
            operationSourceText,
        );
        const authoringDeclaration = emittedIsolatedDeclaration(
            'targetedContributionAuthoring.ts',
            authoringSourceText,
        );

        expect(operationDeclaration).toMatch(
            /export declare abstract class AdmittedTargetedOperationExecutionHandle\b/u,
        );
        expect(operationDeclaration).toMatch(
            /protected readonly opaqueTypes: Readonly<\{\s*readonly input: TInput;\s*readonly result: TResult;\s*\}>;/u,
        );
        expect(operationDeclaration).not.toMatch(
            /declare const admittedTargetedOperationExecutionHandleEvidence\b/u,
        );
        expect(authoringDeclaration).toMatch(
            /export declare abstract class ContributionSurfaceHandle\b/u,
        );
        expect(authoringDeclaration).toMatch(/protected readonly opaqueInput: TInput;/u);
        expect(authoringDeclaration).not.toMatch(
            /declare const contributionSurfaceInputEvidence\b/u,
        );
    });

    it('keeps admitted-operation identity on the realm-neutral leaf through the emitted source service declaration sidecar', async () => {
        const [
            serviceSourceText,
            serviceDeclarationText,
            publicSourceText,
            authoringDeclarationText,
        ] = await Promise.all([
            readFile(new URL('./actions/service.ts', import.meta.url), 'utf8'),
            readFile(new URL('../dist/actions/service.d.ts', import.meta.url), 'utf8'),
            readFile(new URL('./actions/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('../dist/targetedContributionAuthoring.d.ts', import.meta.url), 'utf8'),
        ]);
        const serviceSource = parseSource('actions/service.ts', serviceSourceText);
        const serviceDeclaration = parseSource('actions/service.d.ts', serviceDeclarationText);
        const publicSource = parseSource('actions/index.public.ts', publicSourceText);
        const authoringDeclaration = parseSource('targetedContributionAuthoring.d.ts', authoringDeclarationText);

        for (const name of [
            'AdmittedTargetedOperationExecutionHandle',
            'AdmittedTargetedOperationIdentity',
        ]) {
            expect(importedName(serviceSource, './admittedTargetedOperation.js', name)).toBe(name);
            expect(reexportedName(serviceSource, './admittedTargetedOperation.js', name)).toBe(name);
            expect(reexportedName(serviceDeclaration, './admittedTargetedOperation.js', name)).toBe(name);
            expect(reexportedName(publicSource, './admittedTargetedOperation.js', name)).toBe(name);
        }
        expect(importedName(
            authoringDeclaration,
            './actions/admittedTargetedOperation.js',
            'AdmittedTargetedOperationExecutionHandle',
        )).toBe('AdmittedTargetedOperationExecutionHandle');
        expect(importedName(
            authoringDeclaration,
            './actions/service.js',
            'AdmittedTargetedOperationExecutionHandle',
        )).toBeUndefined();
    });

    it('declares the hook payload map without Protocol schema-map helper identities', async () => {
        const sourceText = await readFile(new URL('./hooks.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('hooks.ts', sourceText);
        const declarationSourceFile = parseSource('hooks.d.ts', declaration);
        const payloadMap = exportedTypeAlias(declarationSourceFile, 'PluginHookPayloadMap');

        expect(payloadMap).toBeDefined();
        expect(payloadMap?.type.getText(declarationSourceFile)).not.toMatch(
            /\bPluginHookPayload(?:Schema)?MapV1\b/u,
        );
        expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        expect(declaration).not.toMatch(/\bzod\b/u);
        expect(declaration).not.toMatch(/\bHookSchema\b/u);
    });

    it('projects invocation provenance through SDK-local author declarations', async () => {
        const [executionOriginSource, invocationSource] = await Promise.all([
            readFile(new URL('./executionOrigin.ts', import.meta.url), 'utf8'),
            readFile(new URL('./invocation.ts', import.meta.url), 'utf8'),
        ]);

        for (const [fileName, sourceText] of [
            ['executionOrigin.ts', executionOriginSource],
            ['invocation.ts', invocationSource],
        ] as const) {
            const declaration = emittedIsolatedDeclaration(fileName, sourceText);
            expect(declaration, fileName).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
            expect(declaration, fileName).not.toMatch(/\bzod\b/u);
            expect(declaration, fileName).not.toMatch(/\bVoiceSchema\b/u);
        }
    });

    it('projects Voice author declarations through public Protocol DTO identities without Zod edges', async () => {
        const sources = await Promise.all([
            ['voice/projections.ts', new URL('./voice/projections.ts', import.meta.url)],
            ['voice/client.ts', new URL('./voice/client.ts', import.meta.url)],
            ['voice/speech.ts', new URL('./voice/speech.ts', import.meta.url)],
        ] as const).then(async (entries) => Promise.all(entries.map(async ([fileName, url]) => (
            [fileName, await readFile(url, 'utf8')] as const
        ))));

        const declarations = new Map(sources.map(([fileName, sourceText]) => (
            [fileName, emittedIsolatedDeclaration(fileName, sourceText)] as const
        )));

        expect(declarations.get('voice/projections.ts')).toContain(
            "from '@happier-dev/protocol/plugins/contributions/voice';",
        );
        expect(declarations.get('voice/projections.ts')).toContain(
            "from '@happier-dev/protocol/voice/realtime';",
        );
        expect(declarations.get('voice/speech.ts')).toContain(
            "from '@happier-dev/protocol/voice/speech';",
        );

        for (const [fileName, declaration] of declarations) {
            expect(declaration, fileName).not.toMatch(/\bzod\b/u);
        }
    });

    it('projects the SCM backend manifest declaration without a private type edge', async () => {
        const sourceText = await readFile(new URL('./manifest/scmBackends.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('manifest/scmBackends.ts', sourceText);

        expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        expect(declaration).not.toMatch(/\bzod\b/u);
    });

    it('keeps all public SCM subpath declarations free of private Protocol and Zod types', async () => {
        const sources = await Promise.all([
            ['scm/projections.ts', new URL('./scm/projections.ts', import.meta.url)],
            ['scm/backend.ts', new URL('./scm/backend.ts', import.meta.url)],
            ['scm/hostingProvider.ts', new URL('./scm/hostingProvider.ts', import.meta.url)],
            ['scm/backendProjections.ts', new URL('./scm/backendProjections.ts', import.meta.url)],
            ['scm/hostingProviderProjections.ts', new URL('./scm/hostingProviderProjections.ts', import.meta.url)],
            ['scm/remoteMutationPreconditions.ts', new URL('./scm/remoteMutationPreconditions.ts', import.meta.url)],
            ['scm/forgeHttp.ts', new URL('./scm/forgeHttp.ts', import.meta.url)],
        ] as const).then(async (entries) => Promise.all(entries.map(async ([fileName, url]) => (
            [fileName, await readFile(url, 'utf8')] as const
        ))));

        for (const [fileName, sourceText] of sources) {
            const declaration = emittedIsolatedDeclaration(fileName, sourceText);
            expect(declaration, fileName).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
            expect(declaration, fileName).not.toMatch(/\bzod\b/u);
        }
    });

    it('keeps Connected Account runtime credential reads on the public store contract', async () => {
        const [runtimeSourceText, publicSourceText] = await Promise.all([
            readFile(new URL('./services/connectedAccounts.ts', import.meta.url), 'utf8'),
            readFile(new URL('./connectedAccounts.ts', import.meta.url), 'utf8'),
        ]);
        const runtimeDeclaration = emittedIsolatedDeclaration(
            'services/connectedAccounts.ts',
            runtimeSourceText,
        );
        const publicSourceFile = parseSource('connectedAccounts.ts', publicSourceText);
        const hiddenReaderName = ['PluginConnectedAccountCredential', 'Reader'].join('');
        const publicReaderName = ['ConnectedAccountCredential', 'Reader'].join('');

        expect(runtimeDeclaration).not.toContain(hiddenReaderName);
        expect(reexportedName(
            publicSourceFile,
            './services/connectedAccounts.js',
            'ConnectedAccountCredentialStore',
        )).toBe('PluginConnectedAccountCredentialStore');
        expect(reexportedName(
            publicSourceFile,
            './services/connectedAccounts.js',
            publicReaderName,
        )).toBeUndefined();

        expectTypeOf<Parameters<ConnectedAccountRuntime['refresh']>[0]['credentials']>()
            .toEqualTypeOf<Pick<ConnectedAccountCredentialStore, 'get'>>();
        expectTypeOf<Parameters<ConnectedAccountRuntime['revoke']>[0]['credentials']>()
            .toEqualTypeOf<Pick<ConnectedAccountCredentialStore, 'get'>>();
        expectTypeOf<Parameters<ConnectedAccountRuntime['status']>[0]['credentials']>()
            .toEqualTypeOf<Pick<ConnectedAccountCredentialStore, 'get'>>();
        expectTypeOf<Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0]['credentials']>()
            .toEqualTypeOf<Pick<ConnectedAccountCredentialStore, 'get'>>();
        expectTypeOf<Parameters<ConnectedAccountRuntime['materialize']>[1]['credentials']>()
            .toEqualTypeOf<Pick<ConnectedAccountCredentialStore, 'get'>>();
    });

    it('uses an SDK-local Action declaration in definePlugin author signatures', async () => {
        const sourceText = await readFile(new URL('./definePlugin.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('definePlugin.ts', sourceText);

        expect(sourceText).not.toMatch(/\bPluginActionPlacementV2\b/u);
        expect(exportedTypeAlias(sourceFile, 'PluginActionDeclaration')).toBeDefined();

        for (const helperName of [
            'PluginEventContribution',
            'PluginHookContribution',
            'PluginMcpDiscoverySourceContribution',
            'PluginMcpServerContribution',
            'PluginActionContribution',
            'PluginAgentContribution',
            'PluginPromptAssetContribution',
        ]) {
            expect(exportedTypeAlias(sourceFile, helperName), helperName).toBeUndefined();
        }
    }, 30_000);

    it('keeps testkit openable-content requests on the existing UI author contract', async () => {
        const sourceText = await readFile(new URL('./testing/uiHost.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('testing/uiHost.ts', sourceText);
        const input = exportedTypeAlias(sourceFile, 'PluginUiTestkitReadOpenableContentInput');

        expect(importedName(sourceFile, '../ui/hostApi.js', 'OpenableContentReadRequest'))
            .toBe('OpenableContentReadRequest');
        expect(input?.type.getText(sourceFile)).toContain('OpenableContentReadRequest');
        expect(input?.type.getText(sourceFile)).not.toMatch(/OpenableContentReadRequestV1/u);
    });

    it('curates genuine Connected Account types and keeps helper implementation types out of public signatures', async () => {
        const sourceText = await readFile(new URL('./connectedAccounts.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('connectedAccounts.ts', sourceText);

        expect(reexportedName(
            sourceFile,
            '@happier-dev/protocol',
            'ProviderAccountUsageQuotaScope',
        )).toBeUndefined();
        for (const name of ['ProviderAccountUsageQuotaScope']) {
            expect(exportedTypeAlias(sourceFile, name), name).toBeDefined();
        }

        for (const name of ['buildConnectedServiceCredentialRecord']) {
            const declarationType = exportedCallableTypeText(sourceFile, name);
            expect(declarationType, name).toBeDefined();
            expect(declarationType, name).not.toMatch(
                /ConnectedServiceOauthCredentialRawMetadata|ConnectedServiceLimitCategoryInputV1|\bAgentId\b/u,
            );
        }
        expect(reexportedName(
            sourceFile,
            '@happier-dev/protocol/connect/connected-service-limit-category',
            'normalizeConnectedServiceLimitCategoryV1',
        )).toBe('normalizeConnectedServiceLimitCategoryV1');
    });

    it('keeps backend target implementation identities out of the Agent helper signature', async () => {
        const sourceText = await readFile(new URL('./agents.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('agents.ts', sourceText);
        const declarationType = exportedCallableTypeText(sourceFile, 'buildAgentTargetKeyV2');

        expect(declarationType).toBeDefined();
        expect(declarationType).not.toMatch(/BackendTarget(?:Key|Ref)V2/u);
    });

    it('names hook observation facts through the curated External Sessions observation contract', async () => {
        const sourceText = await readFile(new URL('./externalSessionHooks.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('externalSessionHooks.ts', sourceText);
        const mapEventValue = exportedTypeAlias(sourceFile, 'AgentExternalSessionHookMapEventValue');
        const identifiers = new Set<string>();

        if (mapEventValue) {
            const visit = (node: ts.Node): void => {
                if (ts.isIdentifier(node)) identifiers.add(node.text);
                ts.forEachChild(node, visit);
            };
            visit(mapEventValue.type);
        }

        expect(mapEventValue).toBeDefined();
        expect(importedName(
            sourceFile,
            '@happier-dev/protocol',
            'ExternalAgentObservationLeafFactV1',
        )).toBeUndefined();
        expect(importedName(
            sourceFile,
            './externalSessionObservation.js',
            'AgentExternalSessionObservationLinkEvidenceBatchV1',
        )).toBe('AgentExternalSessionObservationLinkEvidenceBatchV1');
        expect(identifiers).toContain('AgentExternalSessionObservationLinkEvidenceBatchV1');
        expect(identifiers).not.toContain('ExternalAgentObservationLeafFactV1');
    });

    it('publishes the Agent auth result only as the canonical Agents-owned identity', async () => {
        const sourceText = await readFile(new URL('./agentRuntime/context.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('agentRuntime/context.ts', sourceText);

        expect(exportedTypeAlias(sourceFile, 'AgentSessionAuthRefreshResult')).toBeUndefined();
        expect(reexportedName(
            sourceFile,
            '@happier-dev/agents',
            'AgentSessionAuthRefreshResult',
        )).toBe('SessionRuntimeAuthRefreshResultV1');
    });

    it('owns Agent runtime auth DTO declarations without private Session transport aliases', async () => {
        const sourceText = await readFile(new URL('./agentRuntime/session.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('agentRuntime/session.ts', sourceText);
        const emitted = emittedDeclaration('./agentRuntime/session.ts');

        for (const [publicName, privateName] of [
            ['AgentSessionRuntimeAuthApplyRequest', 'SessionConnectedServiceAuthApplyGenerationRequestV1'],
            ['AgentSessionRuntimeAuthApplyResult', 'SessionConnectedServiceAuthApplyGenerationResponseV1'],
            ['AgentSessionRuntimeAuthIdentityRequest', 'SessionConnectedServiceAuthReadRuntimeIdentityRequestV1'],
            ['AgentSessionRuntimeAuthIdentityResult', 'SessionConnectedServiceAuthReadRuntimeIdentityResponseV1'],
        ] as const) {
            expect(importedName(sourceFile, '@happier-dev/protocol', privateName)).toBeUndefined();
            const declaration = exportedTypeAlias(sourceFile, publicName);
            expect(declaration, publicName).toBeDefined();
            expect(declaration?.type.getText(sourceFile), publicName).not.toContain('ProtocolRuntimeAuth');
            expect(emitted, privateName).not.toContain(privateName);
        }
    }, 30_000);

    it('keeps Agent runtime author signatures declaration-neutral without widening their contracts', async () => {
        const [sourceText, controlsSourceText] = await Promise.all([
            readFile(new URL('./agentRuntime/session.ts', import.meta.url), 'utf8'),
            readFile(new URL('./agentRuntime/controls.ts', import.meta.url), 'utf8'),
        ]);
        const emitted = emittedIsolatedDeclaration('agentRuntime/session.ts', sourceText);
        const emittedControls = emittedIsolatedDeclaration(
            'agentRuntime/controls.ts',
            controlsSourceText,
        );

        expect(emitted).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        expect(emittedControls).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        for (const privateName of [
            'AgentSessionProviderCheckpointV1',
            'CanonicalAgentSessionRuntimeEventSchema',
            'ProtocolAgentSessionProviderBinding',
            'AgentSessionStartupInstructionsV1',
            'AgentSessionRuntimeDiagnostic',
            'AgentSessionRuntimeEventBase',
            'AgentSessionRuntimeTurnEventBase',
            'AgentSessionRuntimeInputIds',
            'AgentSessionRuntimeCompactionEventBase',
            'RuntimeCompactionEvent',
            'RuntimeEventBase',
            'RuntimeEventContextUsage',
            'RuntimeEventDelivery',
            'RuntimeEventDiagnostic',
            'RuntimeEventInputIds',
            'RuntimeEventUsageCost',
            'RuntimeEventUsageTokens',
            'RuntimeTurnEvent',
            'AgentSessionProviderBindingModelOption',
            'AgentSessionProviderBindingModel',
            'AgentSessionProviderBindingLaunchMaterialization',
            'AgentSessionCausalPermissionSourceAuthority',
            'AgentSessionCausalPermissionAuthority',
            'PluginConnectedAccountRef',
        ]) {
            expect(emitted, privateName).not.toContain(privateName);
        }

        expectTypeOf<AgentSessionRuntimeEvent>()
            .toMatchTypeOf<CanonicalAgentSessionRuntimeEvent>();
        expectTypeOf<CanonicalAgentSessionRuntimeEvent>()
            .toMatchTypeOf<AgentSessionRuntimeEvent>();
        expectTypeOf<AgentSessionProviderCheckpoint>()
            .toEqualTypeOf<CanonicalAgentSessionProviderCheckpoint>();
        expectTypeOf<AgentSessionSendRequest>()
            .toEqualTypeOf<CanonicalAgentSessionSendRequest>();
        expectTypeOf<AgentSessionCompactRequest>()
            .toEqualTypeOf<CanonicalAgentSessionCompactRequest>();
        type ExpectedRollbackAffectedTurn = Readonly<{
            turnId: string;
            providerCheckpoint?: JsonValue;
        }>;
        type ExpectedRollbackRequest = Readonly<{
            operationId: string;
            target: Readonly<{ kind: 'beforeTurn'; turnId: string }>;
            affectedTurns: readonly [
                ExpectedRollbackAffectedTurn,
                ...ExpectedRollbackAffectedTurn[],
            ];
            providerSessionId: string;
            runtimeIncarnationId: string;
            managedServerInstanceId?: string;
        }>;
        type ExpectedRollbackControlFailure =
            | Readonly<{
                status: 'rejected' | 'unavailable';
                diagnostic: PluginDiagnosticData;
                retryable: boolean;
            }>
            | Readonly<{ status: 'unsupported'; diagnostic: PluginDiagnosticData }>;
        type ExpectedRollbackResult =
            | Readonly<{ status: 'applied' }>
            | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>
            | ExpectedRollbackControlFailure;
        type ExpectedRollbackReconciliationResult =
            | Readonly<{ status: 'applied' | 'notApplied' }>
            | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>
            | Readonly<{
                status: 'unavailable';
                diagnostic: PluginDiagnosticData;
                retryable: boolean;
            }>;

        type RollbackAffectedTurns<TRequest> = TRequest extends Readonly<{
            affectedTurns: infer TAffectedTurns;
        }>
            ? TAffectedTurns
            : never;
        type HasRequiredFirstRollbackAffectedTurn<TAffectedTurns> = TAffectedTurns extends readonly [
            unknown,
            ...unknown[],
        ]
            ? true
            : false;

        expectTypeOf<Omit<AgentSessionConversationRollbackRequest, 'affectedTurns'>>()
            .toEqualTypeOf<Omit<ExpectedRollbackRequest, 'affectedTurns'>>();
        expectTypeOf<RollbackAffectedTurns<AgentSessionConversationRollbackRequest>[number]>()
            .toEqualTypeOf<ExpectedRollbackAffectedTurn>();
        expectTypeOf<HasRequiredFirstRollbackAffectedTurn<
            RollbackAffectedTurns<AgentSessionConversationRollbackRequest>
        >>().toEqualTypeOf<true>();
        expectTypeOf<AgentSessionConversationRollbackResult>()
            .toEqualTypeOf<ExpectedRollbackResult>();
        expectTypeOf<AgentSessionConversationRollbackReconciliationResult>()
            .toEqualTypeOf<ExpectedRollbackReconciliationResult>();
        expectTypeOf<CanonicalAgentSessionProviderBinding>()
            .toMatchTypeOf<AgentSessionProviderBinding>();
        expectTypeOf<Extract<AgentSessionOpenRequest, { kind: 'create' }>['startupInstructions']>()
            .toEqualTypeOf<CanonicalAgentSessionStartupInstructions | undefined>();
        expectTypeOf<AgentSessionConnectedAccountSelection>().toEqualTypeOf<Readonly<{
            purpose: string;
            account: Readonly<{
                service: Readonly<{
                    pluginId: string;
                    localId: string;
                }>;
                accountId: string;
            }>;
        }>>();
        expectTypeOf<NonNullable<AgentSessionOpenRequest['connectedAccounts']>[number]>()
            .toEqualTypeOf<AgentSessionConnectedAccountSelection>();
    }, 30_000);

    it('declares Agent runtime schema values through SDK structural output types', async () => {
        const sourceText = await readFile(new URL('./agentRuntime/projections.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('agentRuntime/projections.ts', sourceText);
        const declarationSourceFile = parseSource('agentRuntime/projections.d.ts', declaration);

        for (const [name, publicOutputType, privateOutputType] of [
            [
                'AgentSessionProviderBindingV1Schema',
                'AgentSessionProviderBinding',
                'CanonicalAgentSessionProviderBinding',
            ],
            [
                'AgentSessionRuntimeEventSchema',
                'AgentSessionRuntimeEvent',
                'CanonicalAgentSessionRuntimeEvent',
            ],
        ] as const) {
            const declarationType = exportedCallableTypeText(declarationSourceFile, name);
            expect(declarationType, name).toContain(publicOutputType);
            expect(declarationType, name).not.toContain(privateOutputType);
        }
        expect(declaration).not.toContain('strictJsonValue');
        for (const validatorSpecificReference of [
            /\bfrom\s+['"]zod(?:\/[^'"]*)?['"]/u,
            /\bzod\b/iu,
            /\bz\.[A-Za-z_$][A-Za-z0-9_$]*/u,
            /\b_zod\b/u,
            /\bZodLikeSchema\b/u,
            /\bZod[A-Za-z0-9_$]*/u,
        ]) {
            expect(validatorSpecificReference.test(declaration), validatorSpecificReference.toString()).toBe(false);
        }
    });

    it('aliases the retained Event subscription target to its canonical Protocol manifest identity', async () => {
        const [sdkSourceText, protocolSourceText] = await Promise.all([
            readFile(new URL('./events.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../protocol/src/plugins/contributions/events.ts', import.meta.url), 'utf8'),
        ]);
        const sdkSourceFile = parseSource('events.ts', sdkSourceText);
        const protocolSourceFile = parseSource('protocol/events.ts', protocolSourceText);
        const sdkAlias = exportedTypeAlias(sdkSourceFile, 'EventSubscriptionTarget');

        expect(exportedTypeAlias(protocolSourceFile, 'EventSubscriptionTargetV1')).toBeDefined();
        expect(sdkAlias?.type && ts.isTypeReferenceNode(sdkAlias.type)).toBe(true);
        if (!sdkAlias || !ts.isTypeReferenceNode(sdkAlias.type)) return;
        expect(sdkAlias.type.typeName.getText(sdkSourceFile)).toBe('ProtocolEventSubscriptionTargetV1');
        expect(importedName(
            sdkSourceFile,
            '@happier-dev/protocol',
            'ProtocolEventSubscriptionTargetV1',
        )).toBe('EventSubscriptionTargetV1');
    });

    it('keeps Automation Event values canonical while owning their public schema signatures', async () => {
        const sourceText = await readFile(new URL('./events.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('events.ts', sourceText);

        for (const name of [
            'PluginEventAutomationSetupResultV1',
        ]) {
            expect(reexportedName(
                sourceFile,
                '@happier-dev/protocol/automations/event-setup-result',
                name,
            )).toBe(name);
        }
        for (const name of [
            'PluginEventAutomationHistoryGapResetActionInputV1',
            'PluginEventAutomationHistoryGapResetActionResultV1',
        ]) {
            expect(reexportedName(
                sourceFile,
                '@happier-dev/protocol/automations/event-history-gap-reset-action',
                name,
            )).toBe(name);
        }
        expect(reexportedName(
            sourceFile,
            '@happier-dev/protocol/automations/event-history-gap-reset-action',
            'PluginEventAutomationHistoryGapResetActionInputV1Schema',
        )).toBeUndefined();
        expect(importedName(
            sourceFile,
            '@happier-dev/protocol/automations/event-history-gap-reset-action',
            'canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema',
        )).toBe('PluginEventAutomationHistoryGapResetActionInputV1Schema');

        for (const [canonicalName, publicName] of [
            [
                'canonicalPluginEventAutomationSetupResultV1Schema',
                'PluginEventAutomationSetupResultV1Schema',
            ],
            [
                'canonicalPluginEventAutomationHistoryGapResetActionInputV1JsonSchema',
                'PluginEventAutomationHistoryGapResetActionInputV1JsonSchema',
            ],
            [
                'canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema',
                'PluginEventAutomationHistoryGapResetActionInputV1Schema',
            ],
            [
                'canonicalPluginEventAutomationHistoryGapResetActionResultV1JsonSchema',
                'PluginEventAutomationHistoryGapResetActionResultV1JsonSchema',
            ],
        ] as const) {
            const moduleSpecifier = publicName.includes('SetupResult')
                ? '@happier-dev/protocol/automations/event-setup-result'
                : '@happier-dev/protocol/automations/event-history-gap-reset-action';
            expect(importedName(sourceFile, moduleSpecifier, canonicalName)).toBe(publicName);
        }

        const setupSchemaSignature = exportedCallableTypeText(
            sourceFile,
            'PluginEventAutomationSetupResultV1Schema',
        );
        expect(setupSchemaSignature).toContain('parse(value: unknown): PluginEventAutomationSetupResultV1');
        expect(setupSchemaSignature).toContain('safeParse(value: unknown)');
        expect(setupSchemaSignature).not.toMatch(/\b(?:Zod|PluginJson(?:Schema|Value)V2)\b/u);
        expect(exportedCallableTypeText(
            sourceFile,
            'PluginEventAutomationHistoryGapResetActionInputV1JsonSchema',
        )).toBe('PluginJsonSchema');
        const historyGapInputSchemaSignature = exportedCallableTypeText(
            sourceFile,
            'PluginEventAutomationHistoryGapResetActionInputV1Schema',
        );
        expect(historyGapInputSchemaSignature)
            .toContain('parse(value: unknown): PluginEventAutomationHistoryGapResetActionInputV1');
        expect(historyGapInputSchemaSignature).toContain('safeParse(value: unknown)');
        expect(historyGapInputSchemaSignature).not.toMatch(/\b(?:Zod|PluginJson(?:Schema|Value)V2)\b/u);
        expect(exportedCallableTypeText(
            sourceFile,
            'PluginEventAutomationHistoryGapResetActionResultV1JsonSchema',
        )).toBe('PluginJsonSchema');
    });

    it('keeps Automation result-delivery values canonical while owning their public schema signatures', async () => {
        const sourceText = await readFile(new URL('./automations.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('automations.ts', sourceText);
        const moduleSpecifier = '@happier-dev/protocol/automations/result-delivery';

        for (const name of [
            'AutomationIdV1Schema',
        ]) {
            expect(reexportedName(sourceFile, moduleSpecifier, name)).toBe(name);
        }
        expect(importedName(
            sourceFile,
            moduleSpecifier,
            'canonicalAutomationIdV1Schema',
        )).toBeUndefined();

        for (const [canonicalName, publicName] of [
            [
                'canonicalAutomationConversationAdmitInputV1Schema',
                'AutomationConversationAdmitInputV1Schema',
            ],
            [
                'canonicalAutomationConversationAdmitResultV1Schema',
                'AutomationConversationAdmitResultV1Schema',
            ],
            [
                'canonicalAutomationConversationResultDeliveryV1Schema',
                'AutomationConversationResultDeliveryV1Schema',
            ],
            [
                'canonicalAutomationResultDeliveryInputV1JsonSchema',
                'AutomationResultDeliveryInputV1JsonSchema',
            ],
            [
                'canonicalAutomationResultDeliveryInputV1Schema',
                'AutomationResultDeliveryInputV1Schema',
            ],
            [
                'canonicalAutomationResultDeliveryResultV1JsonSchema',
                'AutomationResultDeliveryResultV1JsonSchema',
            ],
            [
                'canonicalAutomationResultDeliveryResultV1Schema',
                'AutomationResultDeliveryResultV1Schema',
            ],
            [
                'canonicalAutomationResultDeliverySourceV1JsonSchema',
                'AutomationResultDeliverySourceV1JsonSchema',
            ],
            [
                'canonicalAutomationResultDeliverySourceV1Schema',
                'AutomationResultDeliverySourceV1Schema',
            ],
        ] as const) {
            expect(importedName(sourceFile, moduleSpecifier, canonicalName)).toBe(publicName);
        }

        for (const [name, output] of [
            ['AutomationConversationAdmitInputV1Schema', 'AutomationConversationAdmitInputV1'],
            ['AutomationConversationResultDeliveryV1Schema', 'AutomationConversationResultDeliveryV1'],
            ['AutomationResultDeliveryInputV1Schema', 'AutomationResultDeliveryInputV1'],
        ] as const) {
            const signature = exportedCallableTypeText(sourceFile, name);
            expect(signature).toContain(`parse(value: unknown): ${output}`);
            expect(signature).toContain('safeParse(value: unknown)');
            expect(signature).not.toMatch(/\b(?:Zod|PluginJson(?:Schema|Value)V2)\b/u);
        }

        for (const name of [
            'AutomationResultDeliveryInputV1JsonSchema',
            'AutomationResultDeliveryResultV1JsonSchema',
            'AutomationResultDeliverySourceV1JsonSchema',
        ]) {
            expect(exportedCallableTypeText(sourceFile, name)).toBe('PluginJsonSchema');
        }
    });

    it('projects the Webhook endpoint setup and contribution descriptors directly through narrow Protocol owners', async () => {
        const sourceText = await readFile(new URL('./webhooks.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('webhooks.ts', sourceText);

        for (const name of [
            'PluginWebhookEndpointSetupV1',
            'PluginWebhookEndpointSetupV1Schema',
        ]) {
            expect(reexportedName(
                sourceFile,
                '@happier-dev/protocol/plugins/webhooks/endpointV1',
                name,
            )).toBe(name);
        }

        for (const [publicName, canonicalName] of [
            ['PluginWebhookContribution', 'PluginWebhookContributionV1'],
            ['PluginWebhookVerifier', 'PluginWebhookVerifierV1'],
        ] as const) {
            expect(reexportedName(
                sourceFile,
                '@happier-dev/protocol/plugins/contributions/webhooks',
                publicName,
            )).toBe(canonicalName);
            expect(reexportedName(
                sourceFile,
                '@happier-dev/protocol',
                publicName,
            )).toBeUndefined();
        }
    });

    it('projects Session message provenance through local public Session declarations', async () => {
        const sourceText = await readFile(new URL('./services/sessions.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('services/sessions.ts', sourceText);

        expect(exportedTypeAlias(sourceFile, 'SessionMessageProvenanceV1')?.type.getText(sourceFile))
            .toContain('kind: string');
        expect(exportedCallableTypeText(sourceFile, 'SessionMessageProvenanceV1Schema'))
            .toContain('SessionSchema<SessionMessageProvenanceV1>');
        expect(reexportedName(
            sourceFile,
            '@happier-dev/protocol/sessions/general',
            'SessionMessageProvenanceV1',
        )).toBeUndefined();
        expect(reexportedName(
            sourceFile,
            '@happier-dev/protocol/sessions/general',
            'SessionMessageProvenanceV1Schema',
        )).toBeUndefined();

        const protocolRootReferences = sourceFile.statements.filter((statement) => (
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
            && statement.moduleSpecifier
            && ts.isStringLiteral(statement.moduleSpecifier)
            && statement.moduleSpecifier.text === '@happier-dev/protocol'
        ));
        expect(protocolRootReferences).toEqual([]);
    });

    it('projects the browser-safe Session start draft through local public declarations', async () => {
        const sourceText = await readFile(new URL('./services/sessions.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('services/sessions.ts', sourceText);

        expect(exportedTypeAlias(sourceFile, 'SessionServerStartSpawnDraftV1')?.type.getText(sourceFile))
            .toContain("'creationKey' | 'initialMessage' | 'environmentVariables'");
        expect(exportedCallableTypeText(sourceFile, 'SessionServerStartSpawnDraftV1Schema'))
            .toContain('SessionSchema<SessionServerStartSpawnDraftV1>');
        expect(importedName(
            sourceFile,
            '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2',
            'protocolSessionServerStartSpawnDraftV1Schema',
        )).toBe('SessionServerStartSpawnDraftV1Schema');
        expect(importedName(
            sourceFile,
            '@happier-dev/protocol/sessions/creation/sessionServerStartV1',
            'SessionServerStartSpawnDraftV1',
        )).toBeUndefined();
    });

    it('aliases Agent callback metadata to the canonical Agents surface identities', async () => {
        const sourceText = await readFile(new URL('./agentRuntime/projections.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('agentRuntime/projections.ts', sourceText);
        const aliases = [
            ['AttachSessionMetadata', 'AttachSessionMetadataV1'],
            ['ForkSessionMetadata', 'ForkSessionMetadataV1'],
            ['HandoffExportSessionMetadata', 'HandoffExportSessionMetadataV1'],
        ] as const;

        for (const [publicName, canonicalName] of aliases) {
            const declaration = exportedTypeAlias(sourceFile, publicName);
            expect(declaration?.type && ts.isTypeReferenceNode(declaration.type), publicName).toBe(true);
            if (!declaration || !ts.isTypeReferenceNode(declaration.type)) continue;
            expect(declaration.type.typeName.getText(sourceFile), publicName).toBe(canonicalName);
            expect(importedName(sourceFile, '@happier-dev/agents', canonicalName), publicName)
                .toBe(canonicalName);
        }
    });

    it('declares SCM backend author types at their final public identities', async () => {
        const sourceText = await readFile(new URL('./scm/backend.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('scm/backend.ts', sourceText);
        for (const name of [
            'BackendCommandRunInput',
            'BackendCommandRunResult',
            'BackendRuntimeContext',
            'BackendRuntimeDetection',
            'BackendRuntimeHandlerInput',
            'BackendRuntimeHandlers',
            'BackendRuntimeRegistration',
            'BackendRuntimeServices',
            'CheckoutMaterializationRequest',
            'CreatableWorkspaceCheckoutKind',
            'PortableWorkspacePathClassification',
            'PortableWorkspacePathRequest',
            'WorkspaceCheckoutCreationRequest',
            'WorkspaceCheckoutCreationResult',
            'WorkspaceCheckoutMaterializationRequest',
            'WorkspaceCheckoutMaterializationResult',
            'WorkspaceCheckoutRealizationRequest',
            'WorkspaceCheckoutRealizationResult',
            'WorkspaceIntegrationHandlers',
            'WorkspaceLocationInspection',
            'WorkspaceTransferEntry',
            'WorkspaceTransferMetadata',
            'WorkspaceTransferRequest',
            'WorkspaceTransferResult',
        ]) {
            const declaration = exportedTypeAlias(sourceFile, name);
            expect(declaration, name).toBeDefined();
            expect(
                declaration?.type.getText(sourceFile),
                `${name} must not depend on a backend predecessor identity`,
            ).not.toMatch(/\b(?:ScmBackendRuntime|ScmBackendCommandRun|ScmWorkspaceIntegration)/);
        }
        expect(exportedTypeAlias(sourceFile, 'ScmBackendRuntimeRegistration')?.type.getText(sourceFile))
            .toBe('BackendRuntimeRegistration');
    });

    it('declares SCM hosting author types at their final public identities', async () => {
        const sourceText = await readFile(new URL('./scm/hostingProvider.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('scm/hostingProvider.ts', sourceText);
        for (const name of [
            'HostingProviderCompareUrlInput',
            'HostingProviderCompareUrlResult',
            'HostingProviderDefaultBranchInput',
            'HostingProviderDefaultBranchMetadata',
            'HostingProviderDescriptor',
            'HostingProviderPullRequestCheckoutReferenceInput',
            'HostingProviderPullRequestCheckoutReferenceMetadata',
            'HostingProviderPullRequestCreateInput',
            'HostingProviderPullRequestGetInput',
            'HostingProviderPullRequestListInput',
            'HostingProviderRegistryDiagnostic',
            'HostingProviderRemoteDetectionInput',
            'HostingProviderRemoteDetectionResult',
            'HostingProviderRepositoryCreateInput',
            'HostingProviderRepositoryDescribeCloneTargetsInput',
            'HostingProviderRepositoryDescribePublishTargetsInput',
            'HostingProviderRepositoryDescribePublishTargetsResult',
            'HostingProviderRepositoryGetInput',
            'HostingProviderResolvedProvider',
            'HostingProviderResolvedRegistry',
            'HostingProviderResolvedRemote',
            'HostingProviderRuntimeAdapter',
            'HostingProviderRuntimeBasicAuthMaterializationResult',
            'HostingProviderRuntimeCommandResult',
            'HostingProviderRuntimeRegistration',
            'HostingProviderRuntimeServices',
            'HostingProviderRuntimeTokenMaterializationResult',
            'HostingProviderUnresolvedRemote',
        ]) {
            const declaration = exportedTypeAlias(sourceFile, name);
            expect(declaration, name).toBeDefined();
            expect(
                declaration?.type.getText(sourceFile),
                `${name} must not depend on a hosting predecessor identity`,
            ).not.toMatch(/\bScmHostingProvider(?:CompareUrl|DefaultBranch|Descriptor|PullRequest|Registry|RemoteDetection|Repository|Resolved|Runtime|Unresolved)/);
        }
        expect(exportedTypeAlias(sourceFile, 'HostingProviderRuntimeBinding')).toBeUndefined();
        expect(exportedTypeAlias(sourceFile, 'ScmHostingProviderRuntimeBinding')).toBeUndefined();
        expect(
            exportedTypeAlias(sourceFile, 'HostingProviderResolvedProvider')?.type.getText(sourceFile),
        ).not.toMatch(/\b(?:runtime|RuntimeBinding)\b/);
        expect(exportedTypeAlias(sourceFile, 'ScmHostingProviderRuntimeRegistration')?.type.getText(sourceFile))
            .toBe('HostingProviderRuntimeRegistration');
    });

    it('uses the final SCM runtime identities in the registration API', async () => {
        const sourceText = await readFile(new URL('./activation.ts', import.meta.url), 'utf8');
        const sourceFile = parseSource('activation.ts', sourceText);

        expect(exportedTypeAlias(sourceFile, 'BackendRuntime')).toBeDefined();
        expect(exportedTypeAlias(sourceFile, 'HostingProviderRuntime')).toBeDefined();
        expect(exportedTypeAlias(sourceFile, 'PluginScmBackendRuntime')).toBeUndefined();
        expect(exportedTypeAlias(sourceFile, 'PluginScmHostingProviderRuntime')).toBeUndefined();
    });

    it('emits Actions and Voice values through their curated SDK identities', () => {
        const actionsDeclaration = emittedDeclaration('./actions/service.ts');
        const voiceDeclaration = emittedDeclaration('./voice/client.ts');

        expect(actionsDeclaration).toMatch(
            /export declare const getActionSpec:[^;]*=> ActionSpec;/u,
        );
        expect(actionsDeclaration).not.toContain('ReturnType<typeof canonicalGetActionSpec>');

        expect(voiceDeclaration).toContain(
            "import type { ActionSpec } from '../actions/service.js';",
        );
        // `ActionSpec` and the realtime DTOs are curated differently on
        // purpose. `ActionSpec` is an SDK-owned identity, so naming Protocol's
        // is a leak. The realtime DTOs are Protocol-OWNED identities under
        // `SDK-VOICE-PROJECTION`, reached at the client realm's own Protocol
        // subpath exactly as `voice/projections.ts` and `voice/speech.ts`
        // already reach theirs. `voice/projections.ts` used to re-export them,
        // so `client.ts` reached the identity through a second module; the
        // first assertion is what fails if that second path returns.
        //
        // The second assertion catches the shape the first cannot see: an
        // aliased Protocol import re-declared under the public name. That keeps
        // the specifier and loses the identity — the author's `.d.ts` reprints
        // an SDK-local alias instead of the schema the host parses with.
        expect(voiceDeclaration).toMatch(
            /import type \{[^}]*\bVoiceRealtimeJsonValue\b[^}]*\} from '@happier-dev\/protocol\/voice\/realtime';/u,
        );
        expect(voiceDeclaration).not.toMatch(
            /^(?:export )?(?:declare )?type VoiceRealtimeJsonValue\b/mu,
        );
        expect(voiceDeclaration).not.toMatch(
            /import type \{[^}]*\bActionSpec\b[^}]*\} from '@happier-dev\/protocol/u,
        );
        expect(voiceDeclaration).toMatch(
            /export declare const describeActionInputFieldForVoice:\s*\(\s*spec: Pick<ActionSpec, 'id'>,\s*field: NonNullable<ActionSpec\['inputHints'\]>\['fields'\]\[number\],\s*availability\?: VoiceGuidanceAvailability\s*\) => string;/u,
        );
        expect(voiceDeclaration).not.toContain(
            'typeof canonicalDescribeActionInputFieldForVoice',
        );
        expect(voiceDeclaration).toMatch(
            /export declare const isVoiceSdkSafeActionSpec:\s*\(spec: Pick<ActionSpec, 'sideEffectClass'>\) => boolean;/u,
        );

        for (const value of [
            'describeActionForVoiceTool',
            'listVoiceSdkSafeToolActionSpecs',
        ]) {
            expect(voiceDeclaration, value).toMatch(
                new RegExp(`export declare const ${value}:[^;]*\\bActionSpec\\b[^;]*;`, 'u'),
            );
        }
        for (const value of [
            'VoiceRealtimeJsonValueSchema',
            'VoiceRealtimeToolCallV1Schema',
            'VoiceRealtimeToolResultV1Schema',
        ]) {
            expect(voiceDeclaration, value).toMatch(
                new RegExp(`export declare const ${value}:[^;]*\\bVoiceRealtime`, 'u'),
            );
        }
    }, 30_000);
});

describe('activation author declaration closure', () => {
    it('emits Composer attachment callbacks through SDK structural types with the approved localId-only identity', async () => {
        const sourceText = await readFile(new URL('./activation.ts', import.meta.url), 'utf8');
        const declaration = emittedIsolatedDeclaration('activation.ts', sourceText);

        expect(declaration).not.toMatch(/from ['"]@happier-dev\/protocol(?:\/[^'"]+)?['"]/u);
        for (const name of [
            'ComposerAttachmentMessageAcceptedV1',
            'ComposerAttachmentPrepareOutcomeV1',
            'ComposerAttachmentPrepareRequestV1',
            'ComposerAttachmentPrepareResultV1',
            'ComposerAttachmentResolveRequestV1',
            'ComposerAttachmentResolveResultV1',
        ]) {
            expect(declaration).toMatch(new RegExp(`export type ${name}\\b`, 'u'));
        }
        expect(declaration).toContain('localId: string;');
        expect(declaration).not.toMatch(/\bmessage(?:Id|LocalId)\b/u);
        expect([...declaration.matchAll(/content\?: ComposerStagedMediaContentV1;/gu)]).toHaveLength(2);

        type ExpectedPrepareRequest<TDraft = JsonValue> = Readonly<{
            sessionId: string;
            localId: string;
            attachments: readonly Readonly<{
                instanceId: string;
                key: string;
                value: TDraft;
                content?: ComposerStagedMediaContentV1;
            }>[];
        }>;
        type ExpectedPrepareOutcome<TPrepared = PluginJsonValueV2> =
            | Readonly<{
                instanceId: string;
                status: 'ready';
                value: TPrepared;
                content?: ComposerStagedMediaContentV1;
                presentation?: {
                    label: string;
                    description?: string;
                    icon?: PluginUiIconTokenV1;
                    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
                };
            }>
            | Readonly<{
                instanceId: string;
                status: 'invalid' | 'unavailable' | 'failed';
                retryable: boolean;
                message?: string;
            }>;
        type ExpectedPrepareResult<TPrepared = PluginJsonValueV2> = Readonly<{
            attachments: readonly ExpectedPrepareOutcome<TPrepared>[];
        }>;
        type ExpectedResolveRequest<TPrepared = JsonValue> = Readonly<{
            sessionId: string;
            localId: string;
            attachments: readonly Readonly<{
                instanceId: string;
                key: string;
                value: TPrepared;
            }>[];
        }>;
        type ExpectedResolveResult = Readonly<{
            attachments: readonly (
                | Readonly<{
                    instanceId: string;
                    status: 'ready';
                    context?: string;
                    data?: PluginJsonValueV2;
                }>
                | Readonly<{
                    instanceId: string;
                    status: 'unavailable' | 'notFound' | 'invalid' | 'failed';
                    retryable: boolean;
                    message?: string;
                }>
            )[];
        }>;
        type ExpectedMessageAccepted<TPrepared = JsonValue> = Readonly<{
            sessionId: string;
            localId: string;
            attachments: readonly Readonly<{
                instanceId: string;
                key: string;
                value: TPrepared;
            }>[];
        }>;

        expectTypeOf<ComposerAttachmentPrepareRequestV1>()
            .toEqualTypeOf<ExpectedPrepareRequest>();
        expectTypeOf<ComposerAttachmentPrepareOutcomeV1>()
            .toEqualTypeOf<ExpectedPrepareOutcome>();
        expectTypeOf<ComposerAttachmentPrepareResultV1>()
            .toEqualTypeOf<ExpectedPrepareResult>();
        type PrepareFailureOutcome = Exclude<
            ComposerAttachmentPrepareOutcomeV1,
            Readonly<{ status: 'ready' }>
        >;
        expectTypeOf<Extract<'content', keyof PrepareFailureOutcome>>()
            .toEqualTypeOf<never>();
        expectTypeOf<ComposerAttachmentResolveRequestV1>()
            .toEqualTypeOf<ExpectedResolveRequest>();
        expectTypeOf<ComposerAttachmentResolveResultV1>()
            .toEqualTypeOf<ExpectedResolveResult>();
        expectTypeOf<ComposerAttachmentMessageAcceptedV1>()
            .toEqualTypeOf<ExpectedMessageAccepted>();

        type Draft = Readonly<{ issueId: string }>;
        type Prepared = Readonly<{ issueId: string; resolved: boolean }>;
        type Runtime = ComposerAttachmentRuntime<Draft, Prepared>;

        expectTypeOf<Parameters<NonNullable<Runtime['prepareForSend']>>[0]>()
            .toEqualTypeOf<ExpectedPrepareRequest<Draft>>();
        expectTypeOf<Awaited<ReturnType<NonNullable<Runtime['prepareForSend']>>>>()
            .toEqualTypeOf<ExpectedPrepareResult<Prepared>>();
        expectTypeOf<Parameters<NonNullable<Runtime['resolveForDispatch']>>[0]>()
            .toEqualTypeOf<ExpectedResolveRequest<Prepared>>();
        expectTypeOf<Parameters<NonNullable<Runtime['afterMessageAccepted']>>[0]>()
            .toEqualTypeOf<ExpectedMessageAccepted<Prepared>>();
    });
});
