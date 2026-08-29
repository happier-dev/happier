import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as agents from '@happier-dev/agents';
import * as protocol from '@happier-dev/protocol';
import type {
    ConnectedAccountHttpHeadersRequest as ProtocolConnectedAccountHttpHeadersRequest,
    ConnectedAccountMaterializationRequest as ProtocolConnectedAccountMaterializationRequest,
} from '@happier-dev/protocol/connect/connected-account-purposes';
import type {
    QualifiedConnectedAccountRef as ProtocolQualifiedConnectedAccountRef,
} from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type {
    PluginConnectedAccountAuthenticationModeV2 as ProtocolPluginConnectedAccountAuthenticationModeV2,
    PluginConnectedAccountAuthenticationV2 as ProtocolPluginConnectedAccountAuthenticationV2,
    PluginConnectedAccountConfigurationFieldV2 as ProtocolPluginConnectedAccountConfigurationFieldV2,
    PluginConnectedAccountConfigurationV2 as ProtocolPluginConnectedAccountConfigurationV2,
    PluginConnectedAccountDescriptorContributionV2 as ProtocolPluginConnectedAccountDescriptorContributionV2,
} from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import * as canonicalConnectedServiceBindings from '@happier-dev/protocol/connect/connected-service-bindings';
import * as canonicalConnectedServiceSchemas from '@happier-dev/protocol/connect/connected-service-schemas';
import * as canonicalWorkState from '@happier-dev/protocol/sessions/work-state';
import type {
    ConnectedServiceAuthGroupId as ProtocolConnectedServiceAuthGroupId,
    ConnectedServiceBindingsV1 as ProtocolConnectedServiceBindings,
    ConnectedServiceId as ProtocolConnectedServiceId,
    ConnectedServiceProfileId as ProtocolConnectedServiceProfileId,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
    ConnectedServiceLimitCategoryV1 as ProtocolConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol/connect/connected-service-limit-category';
import type {
    QualifiedConnectedAccountPurposeBindingV1 as ProtocolQualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type {
    ConnectedServiceCredentialRevisionV1 as ProtocolConnectedServiceCredentialRevisionV1,
    ConnectedServiceQuotaMeterV1 as ProtocolConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaRecoveryCreditKindV1 as ProtocolConnectedServiceQuotaRecoveryCreditKindV1,
    ConnectedServiceQuotaRecoveryCreditStatusV1 as ProtocolConnectedServiceQuotaRecoveryCreditStatusV1,
    ConnectedServiceQuotaRecoveryCreditV1 as ProtocolConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditsV1 as ProtocolConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaSnapshotV1 as ProtocolConnectedServiceQuotaSnapshotV1,
    ConnectedServiceUsageSourceV1 as ProtocolConnectedServiceUsageSourceV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';
import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import type {
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1 as ProtocolConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 as ProtocolConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
} from '@happier-dev/protocol/sessions/work-state';

import * as accountUsage from './accountUsage.js';
import * as auth from './cloud/auth.js';
import * as publicConnectedAccounts from './connected-accounts/index.js';
import * as requestAuth from './connected-accounts/requestAuth.js';
import * as providerLimitEvidence from './cloud/providerLimitEvidence.js';
import * as connectedAccounts from './connectedAccounts.js';
import * as envConstants from './envConstants.js';
import type {
    ConnectedAccountRequestAuthClientSourceParams as PublicConnectedAccountRequestAuthClientSourceParams,
} from './connected-accounts/index.js';
import type {
    ConnectedAccountHttpHeadersRequest as SdkConnectedAccountHttpHeadersRequest,
    ConnectedAccountMaterializationOptions as SdkConnectedAccountMaterializationOptions,
    ConnectedAccountMaterializationRequest as SdkConnectedAccountMaterializationRequest,
    ConnectedAccountRef as SdkConnectedAccountRef,
    ConnectedServiceAuthGroupId as SdkConnectedServiceAuthGroupId,
    ConnectedServiceBindings as SdkConnectedServiceBindings,
    ConnectedServiceCredentialRevisionV1 as SdkConnectedServiceCredentialRevisionV1,
    ConnectedServiceId as SdkConnectedServiceId,
    ConnectedServiceLimitCategoryV1 as SdkConnectedServiceLimitCategoryV1,
    ConnectedServiceProfileId as SdkConnectedServiceProfileId,
    ConnectedServiceQuotaMeterV1 as SdkConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1 as SdkConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 as SdkConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
    ConnectedServiceQuotaRecoveryCreditKindV1 as SdkConnectedServiceQuotaRecoveryCreditKindV1,
    ConnectedServiceQuotaRecoveryCreditStatusV1 as SdkConnectedServiceQuotaRecoveryCreditStatusV1,
    ConnectedServiceQuotaRecoveryCreditV1 as SdkConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditsV1 as SdkConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaSnapshotV1 as SdkConnectedServiceQuotaSnapshotV1,
    ConnectedServiceUsageSourceV1 as SdkConnectedServiceUsageSourceV1,
    PluginConnectedAccountAuthenticationModeV2 as SdkPluginConnectedAccountAuthenticationModeV2,
    PluginConnectedAccountAuthenticationV2 as SdkPluginConnectedAccountAuthenticationV2,
    PluginConnectedAccountConfigurationFieldV2 as SdkPluginConnectedAccountConfigurationFieldV2,
    PluginConnectedAccountConfigurationV2 as SdkPluginConnectedAccountConfigurationV2,
    PluginConnectedAccountDescriptorContributionV2 as SdkPluginConnectedAccountDescriptorContributionV2,
} from './connectedAccounts.js';

function namedTypeImportBindings(
    source: ts.SourceFile,
    moduleSpecifier: string,
): readonly string[] {
    return source.statements.flatMap((statement): readonly string[] => {
        const importClause = ts.isImportDeclaration(statement)
            ? statement.importClause
            : undefined;
        if (
            !ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || !importClause
            || importClause.isTypeOnly !== true
        ) {
            return [];
        }
        const bindings = importClause.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) return [];
        return bindings.elements.map((binding) => (binding.propertyName ?? binding.name).text);
    });
}

function namedValueImportBindings(
    source: ts.SourceFile,
    moduleSpecifier: string,
): readonly string[] {
    return source.statements.flatMap((statement): readonly string[] => {
        const importClause = ts.isImportDeclaration(statement)
            ? statement.importClause
            : undefined;
        if (
            !ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || !importClause
            || importClause.isTypeOnly
        ) {
            return [];
        }
        const bindings = importClause.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) return [];
        return bindings.elements.map((binding) => (binding.propertyName ?? binding.name).text);
    });
}

function namedExportBindings(
    source: ts.SourceFile,
    moduleSpecifier: string,
    typeOnly: boolean,
): readonly string[] {
    return source.statements.flatMap((statement): readonly string[] => {
        if (
            !ts.isExportDeclaration(statement)
            || !statement.moduleSpecifier
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || statement.isTypeOnly !== typeOnly
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)
        ) {
            return [];
        }
        return statement.exportClause.elements.map((binding) => (binding.propertyName ?? binding.name).text);
    });
}

function exportedTypeAliases(source: ts.SourceFile): readonly string[] {
    return source.statements.flatMap((statement): readonly string[] => (
        ts.isTypeAliasDeclaration(statement)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
            ? [statement.name.text]
            : []
    ));
}

function exportedValueDeclarations(source: ts.SourceFile): readonly string[] {
    return source.statements.flatMap((statement): readonly string[] => {
        if (
            !ts.isVariableStatement(statement)
            || statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true
        ) {
            return [];
        }
        return statement.declarationList.declarations.flatMap((declaration): readonly string[] => (
            ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
        ));
    });
}

const EXPECTED_EXPORTS = [
    'AuthCallbackCreateInput',
    'AuthCallbackCreateResult',
    'AuthCallbackMode',
    'AuthCallbackResult',
    'AuthCallbackService',
    'AuthCallbackSession',
    'AuthCallbackWaitInput',
    'AuthCredentialWriteInput',
    'AuthCredentialWriteResult',
    'AuthDiagnostic',
    'AuthFailureCode',
    'AuthLoopbackInput',
    'AuthLoopbackResult',
    'AuthMaterializationBinding',
    'AuthMaterializationHelpers',
    'AuthOpenBrowserResult',
    'AuthPkceChallenge',
    'AuthPromptTextInput',
    'AuthPromptTextResult',
    'AuthenticateOptions',
    'AuthenticateResult',
    'Authenticator',
    'AuthenticatorContext',
    'CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1',
    'CLAUDE_SUBSCRIPTION_OAUTH_PROFILE',
    'CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1',
    'ClaudeSubscriptionMaterializationContractV1',
    'ClaudeSubscriptionSetupTokenEnvironmentRequestV1',
    'ConnectedAccountAuthFailureRequestV1Schema',
    'ConnectedAccountAuthenticationContext',
    'ConnectedAccountAuthenticationModeRuntime',
    'ConnectedAccountBindingEvent',
    'ConnectedAccountBindingSummary',
    'ConnectedAccountCredentialStore',
    'ConnectedAccountHealthResult',
    'ConnectedAccountHttpHeadersRequest',
    'ConnectedAccountListRequest',
    'ConnectedAccountListedAccount',
    'ConnectedAccountListedMaterializationRequest',
    'ConnectedAccountListedState',
    'ConnectedAccountManualCompletion',
    'ConnectedAccountMaterialization',
    'ConnectedAccountMaterializationOptions',
    'ConnectedAccountMaterializationRequest',
    'ConnectedAccountMetadataList',
    'ConnectedAccountPurposeDeclaration',
    'ConnectedAccountPurposeDeclarationsV1Schema',
    'ConnectedAccountPurposeId',
    'ConnectedAccountQuotaFailureRequestV1Schema',
    'ConnectedAccountRef',
    'ConnectedAccountRequestAuthMaterialization',
    'ConnectedAccountRequestAuthUse',
    'ConnectedAccountRequestAuthUsesV1Schema',
    'ConnectedAccountRuntime',
    'ConnectedAccountRuntimeConfiguration',
    'ConnectedAccountServiceKey',
    'ConnectedAccountsService',
    'ConnectedServiceAuthGroupId',
    'ConnectedServiceAuthGroupIdSchema',
    'ConnectedServiceBindings',
    'ConnectedServiceBindingsV1Schema',
    'ConnectedServiceCredentialRecordV1',
    'ConnectedServiceCredentialRecordV1Schema',
    'ConnectedServiceCredentialRevisionV1',
    'ConnectedServiceCredentialRevisionV1Schema',
    'ConnectedServiceId',
    'ConnectedServiceLimitCategoryV1',
    'ConnectedServiceProfileId',
    'ConnectedServiceProfileIdSchema',
    'ConnectedServiceQuotaMeterV1',
    'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1',
    'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema',
    'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1',
    'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema',
    'ConnectedServiceQuotaRecoveryCreditKindV1',
    'ConnectedServiceQuotaRecoveryCreditKindV1Schema',
    'ConnectedServiceQuotaRecoveryCreditStatusV1',
    'ConnectedServiceQuotaRecoveryCreditStatusV1Schema',
    'ConnectedServiceQuotaRecoveryCreditV1',
    'ConnectedServiceQuotaRecoveryCreditV1Schema',
    'ConnectedServiceQuotaRecoveryCreditsV1',
    'ConnectedServiceQuotaRecoveryCreditsV1Schema',
    'ConnectedServiceQuotaSnapshotV1',
    'ConnectedServiceQuotaSnapshotV1Schema',
    'ConnectedServiceUsageSourceV1',
    'ConnectedServiceUsageSourceV1Schema',
    'ConnectedServicesProviderStateSharingPolicyV1',
    'CredentialRequirementOptions',
    'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON_ENV',
    'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV',
    'OPENAI_CODEX_OAUTH_PROFILE',
    'OauthAuthEntry',
    'OauthCredentialRecord',
    'OauthCredentialRecordWithExpiry',
    'PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1',
    'PluginConnectedAccountAuthenticationModeV2',
    'PluginConnectedAccountAuthenticationV2',
    'PluginConnectedAccountConfigurationFieldV2',
    'PluginConnectedAccountConfigurationV2',
    'PluginConnectedAccountDescriptorContributionV2',
    'PluginConnectedAccountMaterializationKind',
    'PluginConnectedAccountRegistrationApi',
    'ProviderAccountUsageQuotaScopeV1',
    'ProviderLimitCategory',
    'ProviderLimitEvidenceClassification',
    'ProviderLimitEvidenceConfidence',
    'ProviderLimitEvidenceContext',
    'ProviderLimitEvidenceProvenance',
    'QualifiedConnectedAccountGroupV4Schema',
    'QualifiedConnectedAccountListResponseV4Schema',
    'QualifiedConnectedAccountRef',
    'QualifiedConnectedAccountRefJsonSchema',
    'QualifiedConnectedAccountRefSchema',
    'QualifiedConnectedAccountPurpose',
    'QualifiedConnectedAccountPurposeBinding',
    'QualifiedConnectedAccountPurposeBindingTarget',
    'QualifiedConnectedAccountPurposeBindingV1Schema',
    'QualifiedConnectedAccountPurposeBindingsV1',
    'QualifiedConnectedAccountServiceRef',
    'QuotaFetchError',
    'QuotaFetchErrorCode',
    'TokenCredentialRecord',
    'UnsupportedAccountUsage',
    'buildConnectedServiceCredentialRecord',
    'buildOauthAuthEntry',
    'classifyProviderLimitEvidence',
    'defineAuthMaterialization',
    'isAuthenticateResult',
    'normalizeConnectedServiceLimitCategoryV1',
    'parseCredentialRecord',
    'requireOauthCredentialRecordWithExpiry',
    'requireTokenCredentialRecord',
    'resolveConnectedServicesProviderStateSharingPolicyV1',
    'unsupportedAccountUsage',
] as const;

const FORBIDDEN_PRIVATE_EXPORTS = [
    'AgentConnectedServicesAdapter',
    'ConnectedAccountRequestAuthCapabilityDocumentV2',
    'RequestAuthCapabilityDocumentV1',
    'OAuthBearerLeaseV1',
    'RequestAuthCredentialContextV1',
    'SessionConnectedServiceAuthApplyGenerationRequestV1',
    'SessionConnectedServiceAuthApplyGenerationResponseV1',
    'SessionConnectedServiceAuthReadRuntimeIdentityRequestV1',
    'SessionConnectedServiceAuthReadRuntimeIdentityResponseV1',
    'SessionMetadataConnectedServiceBinding',
    'ProviderAccountUsageRecordId',
    'ProviderAccountUsageRecordKeyV1',
    'ProviderAccountUsageSnapshotV1',
    'ProviderAccountUsageSnapshotV1Schema',
    'buildProviderAccountUsageOpaqueLocalCredentialRef',
    'buildProviderAccountUsageRecordId',
    'buildConnectedAccountRequestAuthClientSource',
    'parseConnectedAccountRequestAuthCapabilityDocument',
    'readConnectedAccountRequestAuthCapabilityFile',
    'resolveConnectedAccountRequestAuthCapabilityPath',
    'getAgentConnectedServicesAdapter',
    'readSessionMetadataConnectedServiceBindings',
] as const;

function exportedNames(): readonly string[] {
    const sourcePath = fileURLToPath(new URL('./connectedAccounts.ts', import.meta.url));
    const source = ts.createSourceFile(
        sourcePath,
        readFileSync(sourcePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    return source.statements.flatMap((statement): readonly string[] => {
        if (ts.isExportDeclaration(statement)
            && statement.exportClause
            && ts.isNamedExports(statement.exportClause)) {
            return statement.exportClause.elements.map((element) => element.name.text);
        }
        if (ts.isVariableStatement(statement)
            && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true) {
            return statement.declarationList.declarations.flatMap((declaration) => (
                ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
            ));
        }
        if ((ts.isFunctionDeclaration(statement)
            || ts.isTypeAliasDeclaration(statement)
            || ts.isInterfaceDeclaration(statement))
            && statement.name
            && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true) {
            return [statement.name.text];
        }
        return [];
    })
        .sort();
}

describe('Connected Accounts final package-local projection', () => {
    it('owns the exact final-name census without private request-auth custody', () => {
        const exports = exportedNames();
        expect(exports).toEqual([...EXPECTED_EXPORTS].sort());
        expect(exports).not.toEqual(expect.arrayContaining([...FORBIDDEN_PRIVATE_EXPORTS]));
    });

    it('re-exports canonical runtime values by identity', () => {
        expect(connectedAccounts.ConnectedAccountPurposeDeclarationsV1Schema)
            .toBe(protocol.ConnectedAccountPurposeDeclarationsV1Schema);
        expect(connectedAccounts.ConnectedAccountRequestAuthUsesV1Schema)
            .toBe(protocol.ConnectedAccountRequestAuthUsesV1Schema);
        expect(connectedAccounts.QualifiedConnectedAccountPurposeBindingV1Schema)
            .toBe(protocol.QualifiedConnectedAccountPurposeBindingV1Schema);
        expectTypeOf(connectedAccounts.QualifiedConnectedAccountPurposeBindingV1Schema.parse)
            .returns.toMatchTypeOf<ProtocolQualifiedConnectedAccountPurposeBindingV1>();
        expectTypeOf<ProtocolQualifiedConnectedAccountPurposeBindingV1>()
            .toMatchTypeOf<ReturnType<typeof connectedAccounts.QualifiedConnectedAccountPurposeBindingV1Schema.parse>>();
        expectTypeOf(connectedAccounts.ConnectedServiceProfileIdSchema.parse)
            .returns.toEqualTypeOf<string>();
        expect(connectedAccounts.ConnectedServiceAuthGroupIdSchema)
            .toBe(canonicalConnectedServiceBindings.ConnectedServiceAuthGroupIdSchema);
        expect(connectedAccounts.ConnectedServiceBindingsV1Schema)
            .toBe(canonicalConnectedServiceBindings.ConnectedServiceBindingsV1Schema);
        expect(connectedAccounts.ConnectedServiceProfileIdSchema)
            .toBe(canonicalConnectedServiceBindings.ConnectedServiceProfileIdSchema);
        expect(connectedAccounts.ConnectedServiceCredentialRevisionV1Schema)
            .toBe(canonicalConnectedServiceSchemas.ConnectedServiceCredentialRevisionV1Schema);
        expect(connectedAccounts.QualifiedConnectedAccountListResponseV4Schema)
            .toBe(protocol.QualifiedConnectedAccountListResponseV4Schema);
        expect(connectedAccounts.QualifiedConnectedAccountRefSchema)
            .toBe(protocol.QualifiedConnectedAccountRefSchema);
        expect((connectedAccounts as Record<string, unknown>).QualifiedConnectedAccountRefJsonSchema)
            .toBe((protocol as Record<string, unknown>).QualifiedConnectedAccountRefJsonSchema);
        expect(connectedAccounts.buildConnectedServiceCredentialRecord)
            .toBe(protocol.buildConnectedServiceCredentialRecord);
        expect(connectedAccounts.normalizeConnectedServiceLimitCategoryV1)
            .toBe(protocol.normalizeConnectedServiceLimitCategoryV1);
        expect(connectedAccounts.defineAuthMaterialization)
            .toBe(auth.defineConnectedServiceAuthMaterialization);
        expect(connectedAccounts.QuotaFetchError)
            .toBe(auth.ConnectedServiceQuotaFetchError);
        expect(connectedAccounts.PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1)
            .toBe(providerLimitEvidence.PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1);
        expect(connectedAccounts.unsupportedAccountUsage)
            .toBe(accountUsage.unsupportedAccountUsage);
        expect(connectedAccounts.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV)
            .toBe(envConstants.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV);
        expect(publicConnectedAccounts.CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV)
            .toBe(requestAuth.CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV);
        expect(publicConnectedAccounts.buildConnectedAccountRequestAuthClientSource)
            .toBe(requestAuth.buildConnectedAccountRequestAuthClientSource);
        expectTypeOf<PublicConnectedAccountRequestAuthClientSourceParams>()
            .toEqualTypeOf<requestAuth.ConnectedAccountRequestAuthClientSourceParams>();
    });

    it('projects localized Connected Account purpose presentation from the Protocol owner', () => {
        expect(connectedAccounts.ConnectedAccountPurposeDeclarationsV1Schema.parse([{
            purpose: 'upstream',
            service: 'account',
            title: {
                key: 'plugins.example.connectedAccounts.upstream',
                fallback: 'Upstream account',
            },
        }])).toEqual([{
            purpose: 'upstream',
            service: 'account',
            title: {
                key: 'plugins.example.connectedAccounts.upstream',
                fallback: 'Upstream account',
            },
        }]);
    });

    it('projects the exact reusable Claude and Codex Connected Account facts', () => {
        expect(connectedAccounts.CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1)
            .toBe(protocol.CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1);
        expect(connectedAccounts.CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1)
            .toBe(protocol.CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1);
        expect(publicConnectedAccounts.CLAUDE_SUBSCRIPTION_OAUTH_PROFILE)
            .toEqual({
                authorizeUrl: protocol.CLAUDE_OAUTH_AUTHORIZE_URL,
                callbackUrl: protocol.CLAUDE_OAUTH_CALLBACK_URL,
                clientId: protocol.CLAUDE_OAUTH_CLIENT_ID,
                tokenUrl: protocol.CLAUDE_OAUTH_TOKEN_URL,
            });
        expect(publicConnectedAccounts.OPENAI_CODEX_OAUTH_PROFILE.clientId)
            .toBe(protocol.OPENAI_CODEX_CLIENT_ID);
        expect(publicConnectedAccounts.OPENAI_CODEX_OAUTH_PROFILE.device.verificationUrl)
            .toBe(protocol.OPENAI_CODEX_DEVICE_VERIFICATION_URL);
    });

    it('directly projects canonical materialization, qualified-account, quota, and descriptor identities', () => {
        const sourcePath = fileURLToPath(new URL('./connectedAccounts.ts', import.meta.url));
        const sourceText = readFileSync(sourcePath, 'utf8');
        const source = ts.createSourceFile(
            sourcePath,
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const emitted = ts.transpileDeclaration(sourceText, {
            fileName: sourcePath,
            compilerOptions: {
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                target: ts.ScriptTarget.ES2022,
            },
            reportDiagnostics: true,
        });

        expect(emitted.diagnostics).toEqual([]);
        expect(namedTypeImportBindings(
            source,
            '@happier-dev/protocol/connect/connected-account-purposes',
        )).toEqual(expect.arrayContaining([
            'ConnectedAccountHttpHeadersRequest',
            'ConnectedAccountMaterializationRequest',
            'ConnectedAccountPurposeId',
            'PluginConnectedAccountMaterializationKind',
        ]));
        expect(namedTypeImportBindings(
            source,
            '@happier-dev/protocol/connect/qualified-connected-account-persistence',
        )).toContain('QualifiedConnectedAccountRef');
        expect(namedTypeImportBindings(
            source,
            './protocol/protocolFacade.js',
        )).toEqual([]);
        expect(namedTypeImportBindings(source, '@happier-dev/protocol')).toEqual([]);
        expect(namedValueImportBindings(source, '@happier-dev/protocol')).toEqual([]);
        expect(namedValueImportBindings(
            source,
            '@happier-dev/protocol/connect/claude-subscription-materialization',
        )).toEqual([
            'CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1',
            'CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1',
        ]);
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2',
            true,
        )).toEqual([
            'PluginConnectedAccountAuthenticationModeV2',
            'PluginConnectedAccountAuthenticationV2',
            'PluginConnectedAccountConfigurationFieldV2',
            'PluginConnectedAccountConfigurationV2',
            'PluginConnectedAccountDescriptorContributionV2',
        ]);
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-account-purposes',
            true,
        )).toEqual(expect.arrayContaining([
            'ConnectedAccountHttpHeadersRequest',
            'ConnectedAccountMaterializationRequest',
            'ConnectedAccountPurposeId',
            'PluginConnectedAccountMaterializationKind',
        ]));
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/qualified-connected-account-persistence',
            false,
        )).toEqual(expect.arrayContaining([
            'QualifiedConnectedAccountRefJsonSchema',
            'QualifiedConnectedAccountRefSchema',
        ]));
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/qualified-connected-account-persistence',
            true,
        )).toContain('QualifiedConnectedAccountRef');
        expect(sourceText).toMatch(
            /export\s+type\s*\{\s*QualifiedConnectedAccountRef\s+as\s+ConnectedAccountRef\s*\}\s*from\s*['"]@happier-dev\/protocol\/connect\/qualified-connected-account-persistence['"];?/u,
        );
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-service-schemas',
            false,
        )).toEqual(expect.arrayContaining([
            'ConnectedServiceQuotaRecoveryCreditKindV1Schema',
            'ConnectedServiceQuotaRecoveryCreditStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditV1Schema',
            'ConnectedServiceQuotaRecoveryCreditsV1Schema',
            'ConnectedServiceQuotaSnapshotV1Schema',
            'ConnectedServiceUsageSourceV1Schema',
        ]));
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-service-schemas',
            true,
        )).toEqual(expect.arrayContaining([
            'ConnectedServiceQuotaRecoveryCreditKindV1',
            'ConnectedServiceQuotaRecoveryCreditStatusV1',
            'ConnectedServiceQuotaRecoveryCreditV1',
            'ConnectedServiceQuotaRecoveryCreditsV1',
            'ConnectedServiceQuotaMeterV1',
            'ConnectedServiceQuotaSnapshotV1',
            'ConnectedServiceUsageSourceV1',
        ]));
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/sessions/work-state',
            false,
        )).toEqual(expect.arrayContaining([
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema',
        ]));
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/sessions/work-state',
            true,
        )).toEqual(expect.arrayContaining([
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1',
        ]));
        expect(namedExportBindings(source, '@happier-dev/protocol', true)).toEqual([]);
        expect(namedExportBindings(source, '@happier-dev/protocol', false)).toEqual([]);
        expect(exportedTypeAliases(source)).not.toEqual(expect.arrayContaining([
            'ConnectedAccountHttpHeadersRequest',
            'ConnectedAccountMaterializationRequest',
            'ConnectedAccountRef',
            'QualifiedConnectedAccountRef',
            'ConnectedServiceQuotaRecoveryCreditKindV1',
            'ConnectedServiceQuotaRecoveryCreditStatusV1',
            'ConnectedServiceQuotaRecoveryCreditV1',
            'ConnectedServiceQuotaRecoveryCreditsV1',
            'ConnectedServiceQuotaMeterV1',
            'ConnectedServiceQuotaSnapshotV1',
            'ConnectedServiceUsageSourceV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1',
            'PluginConnectedAccountAuthenticationModeV2',
            'PluginConnectedAccountAuthenticationV2',
            'PluginConnectedAccountConfigurationFieldV2',
            'PluginConnectedAccountConfigurationV2',
            'PluginConnectedAccountDescriptorContributionV2',
        ]));
        expect(exportedValueDeclarations(source)).not.toEqual(expect.arrayContaining([
            'ConnectedServiceQuotaRecoveryCreditKindV1Schema',
            'ConnectedServiceQuotaRecoveryCreditStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditV1Schema',
            'ConnectedServiceQuotaRecoveryCreditsV1Schema',
            'ConnectedServiceQuotaSnapshotV1Schema',
            'ConnectedServiceUsageSourceV1Schema',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema',
        ]));
        expect(emitted.outputText).toMatch(
            /export\s*\{\s*QualifiedConnectedAccountRefJsonSchema\s*,?\s*QualifiedConnectedAccountRefSchema\s*,?\s*\}\s*from\s*['"]@happier-dev\/protocol\/connect\/qualified-connected-account-persistence['"];/u,
        );
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?ConnectedAccountHttpHeadersRequest[\s\S]*?ConnectedAccountMaterializationRequest[\s\S]*?ConnectedAccountPurposeId[\s\S]*?PluginConnectedAccountMaterializationKind[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/connect\/connected-account-purposes['"];/u,
        );
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?QualifiedConnectedAccountRef[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/connect\/qualified-connected-account-persistence['"];/u,
        );
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?PluginConnectedAccountAuthenticationModeV2[\s\S]*?PluginConnectedAccountAuthenticationV2[\s\S]*?PluginConnectedAccountConfigurationFieldV2[\s\S]*?PluginConnectedAccountConfigurationV2[\s\S]*?PluginConnectedAccountDescriptorContributionV2[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/connect\/plugin-connected-account-authentication-v2['"];/u,
        );
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?ConnectedServiceQuotaRecoveryCreditKindV1[\s\S]*?ConnectedServiceQuotaMeterV1[\s\S]*?ConnectedServiceUsageSourceV1[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/connect\/connected-service-schemas['"];/u,
        );
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1[\s\S]*?ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/sessions\/work-state['"];/u,
        );
        expect(emitted.outputText).not.toMatch(/@happier-dev\/protocol['"]/u);
        expect(emitted.outputText).not.toContain('ProtocolComposableSchema');
        expect(emitted.outputText).not.toMatch(/\bConnectedAccount(?:Composable|Optional)Schema\b/u);
        expect(emitted.outputText).not.toMatch(
            /(?:type|interface)\s+(?:ConnectedAccountHttpHeadersRequest|ConnectedAccountMaterializationRequest|QualifiedConnectedAccountRef|ConnectedServiceQuota(?:RecoveryCredit(?:Kind|Status)?|RecoveryCredits|Meter|Snapshot)|ConnectedServiceUsageSourceV1)\b/u,
        );
    });

    it('keeps descriptor declarations as exact Protocol types and reexports their schema family narrowly', () => {
        expectTypeOf<SdkPluginConnectedAccountAuthenticationModeV2>()
            .toEqualTypeOf<ProtocolPluginConnectedAccountAuthenticationModeV2>();
        expectTypeOf<SdkPluginConnectedAccountAuthenticationV2>()
            .toEqualTypeOf<ProtocolPluginConnectedAccountAuthenticationV2>();
        expectTypeOf<SdkPluginConnectedAccountConfigurationFieldV2>()
            .toEqualTypeOf<ProtocolPluginConnectedAccountConfigurationFieldV2>();
        expectTypeOf<SdkPluginConnectedAccountConfigurationV2>()
            .toEqualTypeOf<ProtocolPluginConnectedAccountConfigurationV2>();
        expectTypeOf<SdkPluginConnectedAccountDescriptorContributionV2>()
            .toEqualTypeOf<ProtocolPluginConnectedAccountDescriptorContributionV2>();

        const manifestSourcePath = fileURLToPath(
            new URL('./manifest/connectedAccountDescriptors.ts', import.meta.url),
        );
        const manifestSource = ts.createSourceFile(
            manifestSourcePath,
            readFileSync(manifestSourcePath, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const descriptorModule = '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';

        expect(namedExportBindings(manifestSource, descriptorModule, false)).toEqual([
            'PluginConnectedAccountAuthenticationModeV2Schema',
            'PluginConnectedAccountAuthenticationV2Schema',
            'PluginConnectedAccountConfigurationFieldV2Schema',
            'PluginConnectedAccountConfigurationV2Schema',
            'PluginConnectedAccountDescriptorContributionV2Schema',
        ]);
        expect(namedExportBindings(manifestSource, descriptorModule, true)).toEqual([
            'PluginConnectedAccountAuthenticationModeV2',
            'PluginConnectedAccountAuthenticationV2',
            'PluginConnectedAccountConfigurationFieldV2',
            'PluginConnectedAccountConfigurationV2',
            'PluginConnectedAccountDescriptorContributionV2',
        ]);
        expect(namedExportBindings(manifestSource, '@happier-dev/protocol', false)).toEqual([]);
        expect(namedExportBindings(manifestSource, '@happier-dev/protocol', true)).toEqual([]);
    });

    it('directly projects connected-service binding identities without SDK parser wrappers', () => {
        const sourcePath = fileURLToPath(new URL('./connectedAccounts.ts', import.meta.url));
        const sourceText = readFileSync(sourcePath, 'utf8');
        const source = ts.createSourceFile(
            sourcePath,
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const emitted = ts.transpileDeclaration(sourceText, {
            fileName: sourcePath,
            compilerOptions: {
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                target: ts.ScriptTarget.ES2022,
            },
            reportDiagnostics: true,
        });

        expect(emitted.diagnostics).toEqual([]);
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-service-bindings',
            false,
        )).toEqual(expect.arrayContaining([
            'ConnectedServiceAuthGroupIdSchema',
            'ConnectedServiceBindingsV1Schema',
            'ConnectedServiceProfileIdSchema',
        ]));
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-service-bindings',
            true,
        )).toEqual(expect.arrayContaining([
            'ConnectedServiceAuthGroupId',
            'ConnectedServiceBindingsV1',
            'ConnectedServiceId',
            'ConnectedServiceProfileId',
        ]));
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-service-limit-category',
            true,
        )).toContain('ConnectedServiceLimitCategoryV1');
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-service-schemas',
            false,
        )).toContain('ConnectedServiceCredentialRevisionV1Schema');
        expect(namedExportBindings(
            source,
            '@happier-dev/protocol/connect/connected-service-schemas',
            true,
        )).toContain('ConnectedServiceCredentialRevisionV1');
        expect(exportedTypeAliases(source)).not.toEqual(expect.arrayContaining([
            'ConnectedServiceAuthGroupId',
            'ConnectedServiceBindings',
            'ConnectedServiceCredentialRevisionV1',
            'ConnectedServiceId',
            'ConnectedServiceLimitCategoryV1',
            'ConnectedServiceProfileId',
        ]));
        expect(exportedValueDeclarations(source)).not.toEqual(expect.arrayContaining([
            'ConnectedAccountAuthFailureRequestV1Schema',
            'ConnectedAccountPurposeDeclarationsV1Schema',
            'ConnectedAccountQuotaFailureRequestV1Schema',
            'ConnectedAccountRequestAuthUsesV1Schema',
            'ConnectedServiceAuthGroupIdSchema',
            'ConnectedServiceBindingsV1Schema',
            'ConnectedServiceProfileIdSchema',
            'QualifiedConnectedAccountGroupV4Schema',
            'QualifiedConnectedAccountListResponseV4Schema',
            'QualifiedConnectedAccountPurposeBindingV1Schema',
        ]));
        expect(sourceText).not.toMatch(/\bConnectedAccountSchema\b/u);
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?ConnectedServiceAuthGroupId[\s\S]*?ConnectedServiceBindingsV1\s+as\s+ConnectedServiceBindings[\s\S]*?ConnectedServiceId[\s\S]*?ConnectedServiceProfileId[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/connect\/connected-service-bindings['"];/u,
        );
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?ConnectedServiceLimitCategoryV1[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/connect\/connected-service-limit-category['"];/u,
        );
        expect(emitted.outputText).toMatch(
            /export\s+type\s*\{[\s\S]*?ConnectedServiceCredentialRevisionV1[\s\S]*?\}\s*from\s*['"]@happier-dev\/protocol\/connect\/connected-service-schemas['"];/u,
        );
        expect(emitted.outputText).not.toMatch(/@happier-dev\/protocol['"]/u);
        expect(emitted.outputText).not.toMatch(/\bConnectedAccountSchema\b/u);
    });

    it('keeps quota and recovery types as exact canonical Protocol symbols', () => {
        expectTypeOf<SdkConnectedAccountHttpHeadersRequest>()
            .toEqualTypeOf<ProtocolConnectedAccountHttpHeadersRequest>();
        expectTypeOf<SdkConnectedAccountMaterializationRequest>()
            .toEqualTypeOf<ProtocolConnectedAccountMaterializationRequest>();
        expectTypeOf<SdkConnectedAccountRef>()
            .toEqualTypeOf<ProtocolQualifiedConnectedAccountRef>();
        expectTypeOf<SdkConnectedServiceAuthGroupId>()
            .toEqualTypeOf<ProtocolConnectedServiceAuthGroupId>();
        expectTypeOf<SdkConnectedServiceBindings>()
            .toEqualTypeOf<ProtocolConnectedServiceBindings>();
        expectTypeOf<SdkConnectedServiceCredentialRevisionV1>()
            .toEqualTypeOf<ProtocolConnectedServiceCredentialRevisionV1>();
        expectTypeOf<SdkConnectedServiceId>()
            .toEqualTypeOf<ProtocolConnectedServiceId>();
        expectTypeOf<SdkConnectedServiceLimitCategoryV1>()
            .toEqualTypeOf<ProtocolConnectedServiceLimitCategoryV1>();
        expectTypeOf<SdkConnectedServiceProfileId>()
            .toEqualTypeOf<ProtocolConnectedServiceProfileId>();
        expectTypeOf<SdkConnectedServiceQuotaMeterV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaMeterV1>();
        expectTypeOf<SdkConnectedServiceQuotaRecoveryCreditKindV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaRecoveryCreditKindV1>();
        expectTypeOf<SdkConnectedServiceQuotaRecoveryCreditStatusV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaRecoveryCreditStatusV1>();
        expectTypeOf<SdkConnectedServiceQuotaRecoveryCreditV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaRecoveryCreditV1>();
        expectTypeOf<SdkConnectedServiceQuotaRecoveryCreditsV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaRecoveryCreditsV1>();
        expectTypeOf<SdkConnectedServiceQuotaSnapshotV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaSnapshotV1>();
        expectTypeOf<SdkConnectedServiceUsageSourceV1>()
            .toEqualTypeOf<ProtocolConnectedServiceUsageSourceV1>();
        expectTypeOf<SdkConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1>();
        expectTypeOf<SdkConnectedServiceQuotaRecoveryCreditConsumeReceiptV1>()
            .toEqualTypeOf<ProtocolConnectedServiceQuotaRecoveryCreditConsumeReceiptV1>();
        expectTypeOf<ReturnType<typeof connectedAccounts.ConnectedServiceQuotaSnapshotV1Schema.parse>>()
            .toEqualTypeOf<SdkConnectedServiceQuotaSnapshotV1>();
        expectTypeOf<ReturnType<typeof connectedAccounts.ConnectedServiceQuotaRecoveryCreditsV1Schema.parse>>()
            .toEqualTypeOf<SdkConnectedServiceQuotaRecoveryCreditsV1>();
        expectTypeOf<ReturnType<typeof connectedAccounts.ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema.parse>>()
            .toEqualTypeOf<SdkConnectedServiceQuotaRecoveryCreditConsumeReceiptV1>();

        for (const [sdkSchema, protocolSchema] of [
            [
                connectedAccounts.ConnectedServiceQuotaRecoveryCreditKindV1Schema,
                canonicalConnectedServiceSchemas.ConnectedServiceQuotaRecoveryCreditKindV1Schema,
            ],
            [
                connectedAccounts.ConnectedServiceQuotaRecoveryCreditStatusV1Schema,
                canonicalConnectedServiceSchemas.ConnectedServiceQuotaRecoveryCreditStatusV1Schema,
            ],
            [
                connectedAccounts.ConnectedServiceQuotaRecoveryCreditV1Schema,
                canonicalConnectedServiceSchemas.ConnectedServiceQuotaRecoveryCreditV1Schema,
            ],
            [
                connectedAccounts.ConnectedServiceQuotaRecoveryCreditsV1Schema,
                canonicalConnectedServiceSchemas.ConnectedServiceQuotaRecoveryCreditsV1Schema,
            ],
            [
                connectedAccounts.ConnectedServiceQuotaSnapshotV1Schema,
                canonicalConnectedServiceSchemas.ConnectedServiceQuotaSnapshotV1Schema,
            ],
            [
                connectedAccounts.ConnectedServiceUsageSourceV1Schema,
                canonicalConnectedServiceSchemas.ConnectedServiceUsageSourceV1Schema,
            ],
            [
                connectedAccounts.ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema,
                canonicalWorkState.ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema,
            ],
            [
                connectedAccounts.ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
                canonicalWorkState.ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
            ],
        ] as const) {
            expect(sdkSchema).toBe(protocolSchema);
        }

    });

    it('models only compare-only current-binding preconditions as public materialization options', () => {
        expectTypeOf<{}>().toMatchTypeOf<SdkConnectedAccountMaterializationOptions>();
        expectTypeOf<Readonly<{ expectedAccount: SdkConnectedAccountRef }>>()
            .toMatchTypeOf<SdkConnectedAccountMaterializationOptions>();
        expectTypeOf<Readonly<{ account: SdkConnectedAccountRef }>>()
            .not.toMatchTypeOf<SdkConnectedAccountMaterializationOptions>();

        const expectedOnly: SdkConnectedAccountMaterializationOptions = {
            expectedAccount: {} as SdkConnectedAccountRef,
        };
        const exactSelection: SdkConnectedAccountMaterializationOptions = {
            /* @sdk-negative-type-case:src-connectedAccounts-test-ts-exact-selection:Q2FsbGVyLXNlbGVjdGVkIGFjY291bnRzIGFyZSBub3QgcHVibGljIG1hdGVyaWFsaXphdGlvbiBhdXRob3JpdHku:YWNjb3VudDoge30gYXMgU2RrQ29ubmVjdGVkQWNjb3VudFJlZiw */
            ...{}, /* @sdk-negative-type-case-end */
        };

        expect(expectedOnly).toBeDefined();
        expect(exactSelection).toBeDefined();
    });

    it('projects the canonical account reference JSON schema through the normal subpath', () => {
        const sourceText = readFileSync(
            new URL('./connected-accounts/index.ts', import.meta.url),
            'utf8',
        );

        expect(sourceText).toContain(
            "export { QualifiedConnectedAccountRefJsonSchema } from '../connectedAccounts.js';",
        );
    });

    it('leaves connected-service adapter and metadata custody with the Agents owner', () => {
        expect(agents.getProviderConnectedServicesAdapter).toBeTypeOf('function');
        expect(agents.readSessionMetadataConnectedServiceBindings).toBeTypeOf('function');
        for (const symbol of [
            'getProviderConnectedServicesAdapter',
            'ProviderConnectedServicesAdapter',
            'readSessionMetadataConnectedServiceBindings',
            'SessionMetadataConnectedServiceBinding',
        ]) {
            expect(symbol in auth).toBe(false);
        }
    });
});
