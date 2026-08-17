import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function hasExportedType(sourceFile: ts.SourceFile, name: string): boolean {
    return sourceFile.statements.some((statement) => (
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))
        && statement.name.text === name
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ));
}

describe('author signature closure source contract', () => {
    it('publishes the exact Action and Agent declaration dependencies of definePlugin', async () => {
        const [sourceText, actionPublicSource, agentPublicSource] = await Promise.all([
            readFile(new URL('./definePlugin.ts', import.meta.url), 'utf8'),
            readFile(new URL('./actions/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./agents/index.public.ts', import.meta.url), 'utf8'),
        ]);
        const sourceFile = ts.createSourceFile(
            'definePlugin.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );

        expect(hasExportedType(sourceFile, 'PluginActionPlacement')).toBe(true);
        expect(hasExportedType(sourceFile, 'PluginCustomAgentDeclaration')).toBe(true);
        expect(hasExportedType(sourceFile, 'PluginHostOwnedAgentDeclaration')).toBe(true);
        expect(actionPublicSource).toContain(
            "export type { PluginActionPlacement } from '../definePlugin.js';",
        );
        expect(agentPublicSource).toContain(
            "export type { PluginCustomAgentDeclaration } from '../definePlugin.js';",
        );
        expect(agentPublicSource).toContain(
            "export type { PluginHostOwnedAgentDeclaration } from '../definePlugin.js';",
        );

        const declarationText = (name: string): string => {
            const declaration = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => (
                ts.isTypeAliasDeclaration(statement) && statement.name.text === name
            ));
            return declaration?.type.getText(sourceFile) ?? '';
        };
        expect(declarationText('PluginCustomAgentDeclaration')).toContain('AgentContribution');
        expect(declarationText('PluginCustomAgentDeclaration')).not.toContain(
            'PluginAgentRuntimeCustomSessionDeclaration',
        );
        expect(declarationText('PluginCustomAgentDeclaration')).not.toContain(
            'PluginAgentRuntimeCustomExecutionDeclaration',
        );
        expect(declarationText('PluginHostOwnedAgentDeclaration')).toContain('AgentContribution');
        expect(declarationText('PluginHostOwnedAgentDeclaration')).not.toContain('PluginAgentDeclaration');

        expect(declarationText('DefinePluginInput')).toContain('McpServerContribution');
        expect(declarationText('DefinePluginInput')).toContain('McpDiscoverySourceContribution');
        expect(declarationText('DefinePluginInput')).not.toContain('PluginMcpServerDeclaration');
        expect(declarationText('DefinePluginInput')).not.toContain('PluginMcpDiscoverySourceDeclaration');

        const definition = sourceFile.statements.flatMap((statement) => (
            ts.isVariableStatement(statement) ? statement.declarationList.declarations : []
        )).find((declaration) => (
            ts.isIdentifier(declaration.name) && declaration.name.text === 'definePlugin'
        ));
        const publicSignature = definition?.type?.getText(sourceFile);
        expect(publicSignature).toContain('DefinePluginInput');
        expect(publicSignature).toContain('DefinedPluginActionContracts<TPluginId, TActions>');
        expect(publicSignature).not.toContain('ProjectedDefinedPluginActionContracts');
        expect(sourceText).not.toContain('ProjectedDefinedPluginActionContracts');
    });

    it('keeps the approved Composer effect and parser contract directly nameable by authors', async () => {
        const [sourceText, publicSource] = await Promise.all([
            readFile(new URL('./manifest.ts', import.meta.url), 'utf8'),
            readFile(new URL('./manifest/index.public.ts', import.meta.url), 'utf8'),
        ]);
        const sourceFile = ts.createSourceFile(
            'manifest.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const effect = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => (
            ts.isTypeAliasDeclaration(statement)
            && statement.name.text === 'PluginDeclarativeComposerApplyEffectV1'
        ));
        const identitySchema = sourceFile.statements.flatMap((statement) => (
            ts.isVariableStatement(statement) ? statement.declarationList.declarations : []
        )).find((declaration) => (
            ts.isIdentifier(declaration.name)
            && declaration.name.text === 'PluginContributionIdentityV1Schema'
        ));

        expect(effect).toBeDefined();
        expect(effect && hasExportedType(sourceFile, effect.name.text)).toBe(true);
        const effectSignature = effect?.type.getText(sourceFile) ?? '';
        expect(effectSignature).toContain("kind: 'composerApply'");
        expect(effectSignature).toContain('expectedRevision: number');
        expect(effectSignature).toContain('operations: readonly ComposerOperationV1[]');
        expect(publicSource).toContain(
            "export type { PluginDeclarativeComposerApplyEffectV1 } from '../manifest.js';",
        );

        const identitySchemaSignature = identitySchema?.type?.getText(sourceFile) ?? '';
        expect(identitySchemaSignature).toBe('ProtocolComposableSchema<PluginContributionIdentity>');
        expect(sourceText).not.toContain('PluginManifestComposableSchema');
        expect(sourceText).not.toContain('PluginManifestOptionalSchema');
    });

    it('names Collection migration declarations at their canonical public owner', async () => {
        const [definePluginSource, collectionsSource, collectionsIndexSource, collectionsPublicSource] = await Promise.all([
            readFile(new URL('./definePlugin.ts', import.meta.url), 'utf8'),
            readFile(new URL('./collections.ts', import.meta.url), 'utf8'),
            readFile(new URL('./collections/index.ts', import.meta.url), 'utf8'),
            readFile(new URL('./collections/index.public.ts', import.meta.url), 'utf8'),
        ]);
        const collectionsFile = ts.createSourceFile(
            'collections.ts',
            collectionsSource,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );

        expect(hasExportedType(collectionsFile, 'PluginAccountCollectionDeclaration')).toBe(true);
        for (const source of [collectionsIndexSource, collectionsPublicSource]) {
            expect(source).toContain(
                "export type { PluginAccountCollectionDeclaration } from '../collections.js';",
            );
        }
        expect(definePluginSource).toMatch(
            /import type \{[\s\S]*\bPluginAccountCollectionDeclaration\b[\s\S]*\} from '\.\/collections\.js';/u,
        );
        expect(definePluginSource).not.toMatch(/type PluginAccountCollectionDeclaration =/u);
    });

    it('publishes browser, request-interceptor, and HostAccess signature dependencies through their canonical author specs', async () => {
        const [
            browserActionsSource,
            browserTargetsSource,
            browserPublicSource,
            definePluginSource,
            manifestSource,
            manifestPublicSource,
            rootPublicSource,
        ] = await Promise.all([
            readFile(new URL('./browser/actions.ts', import.meta.url), 'utf8'),
            readFile(new URL('./browser/targets.ts', import.meta.url), 'utf8'),
            readFile(new URL('./browser/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./definePlugin.ts', import.meta.url), 'utf8'),
            readFile(new URL('./manifest.ts', import.meta.url), 'utf8'),
            readFile(new URL('./manifest/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./index.public.ts', import.meta.url), 'utf8'),
        ]);
        const browserActionsFile = ts.createSourceFile(
            'browser/actions.ts',
            browserActionsSource,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const definePluginFile = ts.createSourceFile(
            'definePlugin.ts',
            definePluginSource,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const manifestFile = ts.createSourceFile(
            'manifest.ts',
            manifestSource,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );

        expect(hasExportedType(browserActionsFile, 'BrowserAvailabilityDescriptor')).toBe(true);
        expect(hasExportedType(browserActionsFile, 'BrowserContributionReference')).toBe(true);
        expect(browserTargetsSource).toContain(
            "import type { BrowserAvailabilityDescriptor } from './actions.js';",
        );
        expect(browserPublicSource).toContain(
            'BrowserAvailabilityDescriptor, BrowserContributionReference',
        );

        expect(hasExportedType(definePluginFile, 'PluginRequestInterceptorDefinition')).toBe(true);
        expect(rootPublicSource).toContain(
            'export type { PluginRequestInterceptorDefinition } from \'./definePlugin.js\';',
        );

        for (const name of [
            'PluginBrowserActionContribution',
            'PluginBrowserTargetContribution',
            'PluginRequestInterceptorContribution',
            'PluginBrowserActionContributionInput',
            'PluginBrowserTargetContributionInput',
            'PluginBrowserContributionDisplay',
            'PluginContributionReference',
            'PluginAvailabilityDescriptor',
            'PluginHttpMethod',
            'PublicHostAccessCapability',
        ]) {
            expect(hasExportedType(manifestFile, name)).toBe(true);
            expect(manifestPublicSource).toContain(`export type { ${name} } from '../manifest.js';`);
        }
    });
});
