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
    it('projects Connected Account request-auth helpers through a package-local module', async () => {
        const [connectedAccountsSource, connectedAccountsPublicSource, requestAuthSource] = await Promise.all([
            readFile(new URL('./connected-accounts/index.ts', import.meta.url), 'utf8'),
            readFile(new URL('./connected-accounts/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./connected-accounts/requestAuth.ts', import.meta.url), 'utf8'),
        ]);

        for (const source of [connectedAccountsSource, connectedAccountsPublicSource]) {
            expect(source).toContain("from './requestAuth.js';");
            expect(source).not.toContain("from '@happier-dev/agents/request-auth';");
        }
        expect(requestAuthSource).not.toContain("from '@happier-dev/agents/request-auth';");
        expect(requestAuthSource).not.toContain("from 'node:");
        expect(requestAuthSource).toContain(
            "from '@happier-dev/protocol/connect/connected-account-request-auth';",
        );
        expect(requestAuthSource).toContain(
            'export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV',
        );
        expect(requestAuthSource).toContain('buildConnectedAccountRequestAuthClientSource');
        expect(requestAuthSource).toContain('ConnectedAccountRequestAuthClientSourceParams');
    });

    it('publishes the Protocol-owned quota scope used by Connected Accounts classifications', async () => {
        const [connectedAccountsSource, connectedAccountsPublicSource] = await Promise.all([
            readFile(new URL('./connectedAccounts.ts', import.meta.url), 'utf8'),
            readFile(new URL('./connected-accounts/index.public.ts', import.meta.url), 'utf8'),
        ]);

        expect(connectedAccountsSource).toContain(
            "export type { ProviderAccountUsageQuotaScopeV1 } from '@happier-dev/protocol/connect/account-usage-primitives';",
        );
        expect(connectedAccountsPublicSource).toContain(
            "export type { ProviderAccountUsageQuotaScopeV1 } from '../connectedAccounts.js';",
        );
    });

    it('publishes every named type referenced by Connected Account and review helper signatures', async () => {
        const [connectedAccountsPublicSource, reviewsPublicSource] = await Promise.all([
            readFile(new URL('./connected-accounts/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./reviews/index.public.ts', import.meta.url), 'utf8'),
        ]);

        expect(connectedAccountsPublicSource).toContain('ConnectedAccountServiceKey');
        expect(reviewsPublicSource).toContain('ReviewCommentPublicationMarkerMatchV1');
        expect(reviewsPublicSource).toContain('ReviewCommentPublicationTargetExpectationV1');
    });

    it('names targeted-contribution selector signatures through Protocol-owned public aliases', async () => {
        const [publicContractText, uiPublicSource] = await Promise.all([
            readFile(new URL('./ui/publicContract.ts', import.meta.url), 'utf8'),
            readFile(new URL('./ui/index.public.ts', import.meta.url), 'utf8'),
        ]);
        const sourceFile = ts.createSourceFile(
            'publicContract.ts',
            publicContractText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const declarationText = (name: string): string => {
            const declaration = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => (
                ts.isTypeAliasDeclaration(statement) && statement.name.text === name
            ));
            return declaration?.type.getText(sourceFile) ?? '';
        };

        for (const name of [
            'PluginUiTargetedContributionV1',
            'PluginUiTargetedContributionsV1',
            'PluginUiTargetedContributionSurfaceV1',
            'PluginUiTargetedContributionOperationV1',
            'PluginUiTargetedContributionSelectorV1',
        ]) {
            expect(declarationText(name), name).toBe(`Protocol${name}`);
            expect(uiPublicSource, name).toContain(name);
        }
    });

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
        for (const name of [
            'PluginAgentExternalSessionLinkDataArray',
            'PluginAgentExternalSessionLinkDataObject',
            'PluginAgentExternalSessionLinkDataValue',
            'JSONType',
        ]) {
            expect(actionPublicSource).toContain(
                `export type { ${name} } from './actionTypeMap.generated.js';`,
            );
        }
        expect(actionPublicSource).not.toContain(
            "export type { AgentExternalSessionTranscriptRawRecord } from './actionTypeMap.generated.js';",
        );
        expect(actionPublicSource).not.toContain(
            "export type { PluginUiJsonValueV1 } from './actionTypeMap.generated.js';",
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
        expect(declarationText('PluginActionDeclaration')).not.toContain('PluginActionDeclarationBase');
        expect(declarationText('PluginCustomAgentDeclaration')).toContain('AgentContribution');
        expect(declarationText('PluginCustomAgentDeclaration')).not.toContain(
            'PluginAgentRuntimeCustomSessionDeclaration',
        );
        expect(declarationText('PluginCustomAgentDeclaration')).not.toContain(
            'PluginAgentRuntimeCustomExecutionDeclaration',
        );
        expect(declarationText('PluginHostOwnedAgentDeclaration')).toContain('AgentContribution');
        expect(declarationText('PluginHostOwnedAgentDeclaration')).not.toContain('PluginAgentDeclaration');

        // The Agent authoring grammar has exactly one spelling: the
        // Protocol-owned `AgentContribution` row projected above. A second,
        // hand-written mirror in this file is a split-brain that silently
        // re-closes unions Protocol deliberately opened — the wire protocol
        // among them — so no mirror declaration may exist at all.
        const localTypeNames = sourceFile.statements.flatMap((statement) => (
            ts.isTypeAliasDeclaration(statement) ? [statement.name.text] : []
        ));
        expect(localTypeNames).not.toContain('PluginAgentDeclaration');
        expect(localTypeNames).not.toContain('PluginAgentDisplayDeclaration');
        expect(localTypeNames).not.toContain('PluginAgentProviderRequirements');
        expect(sourceText).not.toContain(
            "'anthropic' | 'openai-chat' | 'openai-responses' | 'ollama-native'",
        );

        expect(declarationText('DefinePluginInput')).toContain('McpServerContribution');
        expect(declarationText('DefinePluginInput')).toContain('McpDiscoverySourceContribution');
        expect(declarationText('DefinePluginInput')).not.toContain('PluginMcpServerDeclaration');
        expect(declarationText('DefinePluginInput')).not.toContain('PluginMcpDiscoverySourceDeclaration');

        const definePluginInputSignature = declarationText('DefinePluginInput');
        expect(definePluginInputSignature).not.toContain('ValidatedPluginAgentDefinitions');
        expect(definePluginInputSignature).not.toContain('ValidatedPluginAgentDefinition');
        expect(definePluginInputSignature).not.toContain('PluginAgentExternalSessionsFacetRule');
        expect(definePluginInputSignature).toContain("readonly ('terminal' | 'externalSessions')[]");
        expect(definePluginInputSignature).toContain('externalSessions: AgentExternalSessionsContribution');
        expect(definePluginInputSignature).toContain('externalSessions?: never');
        expect(definePluginInputSignature).toContain('AgentExternalSessionHooksContribution');
        expect(definePluginInputSignature).toContain('AgentExternalSessionObservationContribution');
        expect(definePluginInputSignature).toContain('AgentExternalSessionTakeoverContribution');

        const functionDeclaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
            ts.isFunctionDeclaration(statement)
            && statement.name?.text === 'definePlugin'
        ));
        const variableDeclaration = sourceFile.statements.flatMap((statement) => (
            ts.isVariableStatement(statement) ? statement.declarationList.declarations : []
        )).find((declaration) => (
            ts.isIdentifier(declaration.name) && declaration.name.text === 'definePlugin'
        ));
        const publicSignature = functionDeclaration?.getText(sourceFile)
            ?? variableDeclaration?.type?.getText(sourceFile);
        expect(publicSignature).toContain('DefinePluginInput');
        expect(publicSignature).toContain('DefinedPluginActionContracts<TPluginId, TActions>');
        expect(publicSignature).not.toContain('ProjectedDefinedPluginActionContracts');
        expect(sourceText).not.toContain('ProjectedDefinedPluginActionContracts');
    });

    it('keeps every named declarative grammar dependency directly nameable through the canonical manifest author spec', async () => {
        const [sourceText, publicSource, rootPublicSource, uiPublicSource] = await Promise.all([
            readFile(new URL('./manifest.ts', import.meta.url), 'utf8'),
            readFile(new URL('./manifest/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./ui/index.public.ts', import.meta.url), 'utf8'),
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
        const actionNode = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => (
            ts.isTypeAliasDeclaration(statement)
            && statement.name.text === 'PluginDeclarativeActionNodeV2'
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
        expect(actionNode?.type.getText(sourceFile)).toContain('PluginDeclarativeComposerApplyEffectV1');
        expect(effectSignature).toContain("kind: 'composerApply'");
        expect(effectSignature).toContain('PluginJsonValueV2');
        expect(effectSignature).toContain('ComposerContentMediaKindV1');
        expect(effectSignature).not.toContain('DeclarationMutable');
        expect(effectSignature).not.toContain('ComposerOperationV1');
        expect(rootPublicSource).toContain(
            "export type { PluginJsonValueV2 } from './identity.js';",
        );
        expect(rootPublicSource).toContain('ComposerContentMediaKindV1,');
        expect(rootPublicSource).toContain('ComposerContentMimeTypeV1,');
        expect(uiPublicSource).toContain(
            "export type { PluginUiIconTokenV1 } from '../ui.js';",
        );
        expect(uiPublicSource).toContain(
            "export type { PluginUiAttachmentToneV1 } from '../ui.js';",
        );
        for (const name of [
            'PluginDeclarativeActionVariantV2',
            'PluginCollectionProjectedScalarFieldRefV1',
            'PluginCollectionRowCommandV1',
            'PluginDeclarativeRowNodeV2',
            'PluginDeclarativeMetadataEntryV2',
            'PluginDeclarativeStateV2',
            'PluginDeclarativeComposerApplyEffectV1',
        ]) {
            expect(hasExportedType(sourceFile, name), name).toBe(true);
            expect(publicSource, name).toContain(
                `export type { ${name} } from '../manifest.js';`,
            );
        }
        expect(publicSource).not.toContain('MutableComposerTransactionV1');

        expect(sourceText).toContain("from '@happier-dev/protocol/plugins/manifest';");

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

    it('projects shared runtime and prepared-workspace leaves through their semantic author entrypoints', async () => {
        const [
            agentSessionSource,
            agentRuntimeProjectionSource,
            agentRuntimePublicSource,
            externalSessionsPublicSource,
            scmBackendSource,
            scmBackendPublicSource,
            scmPublicSource,
            scmGitMaterializerSource,
        ] = await Promise.all([
            readFile(new URL('./agentRuntime/session.ts', import.meta.url), 'utf8'),
            readFile(new URL('./agentRuntime/projections.ts', import.meta.url), 'utf8'),
            readFile(new URL('./agents/runtime/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./sessions/external/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./scm/backend.ts', import.meta.url), 'utf8'),
            readFile(new URL('./scm/backend/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('./scm/index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../plugins/scm-git/src/operations/materializeGitWorkspaceCheckout.ts', import.meta.url), 'utf8'),
        ]);

        expect(agentSessionSource).not.toContain('@happier-dev/protocol');
        expect(agentSessionSource).toContain('export type RuntimeDescriptorV1 = Readonly<{');
        expect(agentRuntimeProjectionSource).toMatch(
            /export type \{[\s\S]*\bRuntimeDescriptorV1,[\s\S]*\} from '\.\/session\.js';/u,
        );
        expect(agentRuntimePublicSource).toContain(
            "export type { RuntimeDescriptorV1 } from '../../agentRuntime/projections.js';",
        );
        expect(externalSessionsPublicSource).not.toContain('RuntimeDescriptorV1');

        for (const source of [scmBackendSource, scmBackendPublicSource]) {
            expect(source).toContain('ScmReviewWorkspaceMaterializePreparedRequest');
            expect(source).toContain('ScmReviewWorkspaceMaterializePreparedResponse');
        }
        expect(scmBackendSource).not.toContain('@happier-dev/protocol');
        expect(scmBackendSource).toContain(
            'export type ScmReviewWorkspaceMaterializePreparedRequest = Readonly<{',
        );
        expect(scmBackendPublicSource).toContain("from '../backend.js';");
        for (const name of [
            'ScmReviewWorkspaceCurrentness',
            'ScmReviewWorkspaceSourceTip',
        ]) {
            expect(scmPublicSource).toContain(
                `export type { ${name} } from './projections.js';`,
            );
        }
        expect(scmGitMaterializerSource).toContain("from '@happier-dev/plugin-sdk/scm';");
        expect(scmGitMaterializerSource).not.toContain("from '@happier-dev/protocol'");
    });
});
